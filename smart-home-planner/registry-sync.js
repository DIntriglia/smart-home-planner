import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";
import { createConnection } from "home-assistant-js-websocket";

import "./src/js/data-consistency.js";
import "./src/js/ha-sync-model.js";
const { buildStorageDevicesUpdate, enrichDevices, cleanupRemovedFiles } = globalThis.HaSyncModel;
const normalizeString = value => String(value ?? "").trim();
globalThis.WebSocket = WebSocket;

const SUPERVISOR_WS_URL = "ws://supervisor/core/websocket";
const DATA_DIR = "/data";
const LABELS_FILE = path.join(DATA_DIR, "labels.json");
const DEVICES_FILE = path.join(DATA_DIR, "devices.json");
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
// data.json is written through the app server instead of the file system, so a
// single process owns it: writes go through the same ETag check, safety guards
// and rolling snapshots the browser uses, and neither side can silently
// overwrite the other.
const SERVER_BASE_URL = process.env.SHP_SERVER_URL || `http://127.0.0.1:${process.env.SHP_PORT || "80"}`;
const STORAGE_API_URL = `${SERVER_BASE_URL}/api/storage`;
const STORAGE_WRITE_ATTEMPTS = 3;

const registries = [
  {
    name: "areas",
    command: "config/area_registry/list",
    event: "area_registry_updated",
    file: "areas.json",
  },
  {
    name: "floors",
    command: "config/floor_registry/list",
    event: "floor_registry_updated",
    file: "floors.json",
  },
  {
    name: "devices",
    command: "config/device_registry/list",
    event: "device_registry_updated",
    file: "devices.json",
  },
  {
    name: "labels",
    command: "config/label_registry/list",
    event: "label_registry_updated",
    file: "labels.json",
  },
];

// Serializing registry work keeps cached membership and device reconciliation ordered.
const registryQueue = new Map();
const REGISTRY_FIELDS_TO_OMIT = {
  devices: new Set([
    "config_entries_subentries",
    "created_at",
    "hw_version",
    "serial_number",
    "sw_version",
  ]),
  areas: new Set(["temperature_entity_id", "humidity_entity_id"]),
};

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeConnectionError(error) {
  if (error === 1) return "ERR_CANNOT_CONNECT";
  if (error === 2) return "ERR_INVALID_AUTH";
  if (typeof error === "number") return `ERROR_CODE_${error}`;
  if (error && typeof error === "object" && "message" in error) {
    return error.message || String(error);
  }
  return String(error);
}

async function retry(fn, label, options = {}) {
  const initialDelay = options.initialDelay ?? 2000;
  const maxDelay = options.maxDelay ?? 30000;
  const factor = options.factor ?? 2;
  let delay = initialDelay;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      const errorMessage = error?.message || String(error);
      log(`${label} failed: ${errorMessage}. Retrying in ${delay}ms...`);
      await wait(delay);
      delay = Math.min(maxDelay, Math.floor(delay * factor));
    }
  }
}

async function saveToData(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const target = path.join(DATA_DIR, file);
  const temp = `${target}.tmp`;
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, target);
}

async function readRegistryFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    log(`Failed to read registry file ${filePath}: ${error?.message || error}`);
    return [];
  }
}

function omitFieldsFromObject(source, fieldsToOmit) {
  if (!source || typeof source !== "object") return source;
  if (!fieldsToOmit || fieldsToOmit.size === 0) return source;
  const next = {};
  for (const [key, value] of Object.entries(source)) {
    if (fieldsToOmit.has(key)) continue;
    next[key] = value;
  }
  return next;
}

function sanitizeRegistryDataForFile(registryName, data) {
  const fieldsToOmit = REGISTRY_FIELDS_TO_OMIT[registryName];
  if (!fieldsToOmit || !Array.isArray(data)) return data;
  return data.map((item) => omitFieldsFromObject(item, fieldsToOmit));
}

async function readStorage() {
  const response = await fetch(STORAGE_API_URL, { headers: { "Cache-Control": "no-store" } });
  if (!response.ok) {
    throw new Error(`Storage read failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const etag = response.headers.get("etag") || "";
  if (!etag) {
    // Without it the write carries no If-Match and the server cannot tell a
    // concurrent change apart, which is exactly what this path must prevent.
    throw new Error("Storage read failed: the server returned no ETag.");
  }
  return {
    storage: payload && typeof payload === "object" ? payload : {},
    etag,
  };
}

// Returns false when the storage changed under us, so the caller can rebuild
// the update from fresh data instead of overwriting someone else's write.
async function writeStorage(payload, etag, allowEmpty = false) {
  const response = await fetch(STORAGE_API_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": etag, ...(allowEmpty ? { "X-SHP-Allow-Empty": "1" } : {}) },
    body: JSON.stringify(payload),
  });
  if (response.status === 409) {
    const body = await response.json().catch(() => null);
    // A rejected write is not a concurrent change: rebuilding would produce
    // the same payload, so it must surface instead of looping.
    if (body?.code === "storage_empty_rejected") {
      throw new Error(`Storage write rejected: ${body.error || "it would have removed every device."}`);
    }
    return false;
  }
  if (!response.ok) {
    throw new Error(`Storage write failed: HTTP ${response.status}`);
  }
  return true;
}

async function readLabelsRegistry() {
  try {
    const raw = await fs.readFile(LABELS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    const labelIds = parsed
      .map((item) => normalizeString(item?.label_id || item?.id))
      .filter(Boolean);
    return new Set(labelIds);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return new Set();
    }
    log(`Failed to read labels registry: ${error?.message || error}`);
    return new Set();
  }
}

function logDeviceSyncSummary(stats) {
  log(`data.json devices synced (${stats.deviceCount})`);
  log(`Home Assistant area sync target: ${stats.haAreaSyncTarget}`);
  if (stats.excludedDevicesCount > 0) {
    log(`Ignored ${stats.excludedDevicesCount} device(s) by excluded_devices.`);
  }
  if (stats.autoExcludedCount > 0) {
    log(`Auto-excluded ${stats.autoExcludedCount} new device(s) by sync exclusion rules.`);
  }
  if (stats.unlinkedDevicesCount > 0) {
    log(
      `Marked ${stats.unlinkedDevicesCount} device(s) as unlinked from Home Assistant (homeAssistant=false).`
    );
  }
  if (stats.createdDevicesCount > 0) {
    log(`Created ${stats.createdDevicesCount} new device(s) from Home Assistant.`);
  }
  if (stats.addedBrandCount > 0) {
    log(`Registered ${stats.addedBrandCount} new brand option(s) in use by devices.`);
  }
}

async function syncStorageDevicesFromRegistry(haDevices) {
  const allowedLabels = await readLabelsRegistry();

  for (let attempt = 1; attempt <= STORAGE_WRITE_ATTEMPTS; attempt += 1) {
    const { storage, etag } = await readStorage();
    const { nextStorage, stats, removedDevices } = buildStorageDevicesUpdate(storage, haDevices, allowedLabels);
    if (await writeStorage(nextStorage, etag, removedDevices.length > 0)) {
      const failures = await cleanupRemovedFiles(removedDevices, nextStorage.devices, `${SERVER_BASE_URL}/api/device-files`);
      if (failures.length) log(`Integration exclusions saved, but ${failures.length} attachment(s) could not be deleted.`);
      logDeviceSyncSummary(stats);
      return;
    }
    log(
      `data.json changed while syncing (attempt ${attempt}/${STORAGE_WRITE_ATTEMPTS}). Rebuilding from fresh data.`
    );
  }

  throw new Error("Device sync aborted: data.json kept changing while writing.");
}

async function fetchRegistry(conn, registry) {
  const data = await conn.sendMessagePromise({ type: registry.command });
  if (!Array.isArray(data)) {
    throw new Error(`Invalid response for ${registry.command}`);
  }
  return data;
}

async function syncRegistry(conn, registry, reason = "manual") {
  let data = await fetchRegistry(conn, registry);
  if (registry.name === "devices") {
    let entries = null;
    try {
      const response = await conn.sendMessagePromise({ type: "config_entries/get" });
      if (!Array.isArray(response)) throw new Error("Invalid config entries response");
      entries = response.filter(entry => entry && typeof entry.entry_id === "string" && typeof entry.domain === "string")
        .map(entry => ({ entry_id: entry.entry_id, domain: entry.domain }));
      await saveToData("integrations.json", entries);
    } catch (error) {
      log(`Integration membership unavailable: ${error?.message || error}. No new integration removals will be made.`);
    }
    data = enrichDevices(data, entries);
  }
  const sanitizedData = sanitizeRegistryDataForFile(registry.name, data);
  await saveToData(registry.file, sanitizedData);
  if (registry.name === "devices") {
    await syncStorageDevicesFromRegistry(data);
  }
  if (registry.name === "labels") {
    const devicesRegistry = await readRegistryFile(DEVICES_FILE);
    if (devicesRegistry.length > 0) {
      await syncStorageDevicesFromRegistry(devicesRegistry);
      log("Devices re-synced after labels update.");
    }
  }

  if (registry.name === "areas") {
    log(`Areas synced (${data.length})`);
  } else if (registry.name === "floors") {
    log(`Floors synced (${data.length})`);
  } else if (registry.name === "devices") {
    log(`Devices synced (${data.length})`);
  } else {
    log(`${registry.name} synced (${data.length})`);
  }
  log(`${registry.name}: sync completed (reason: ${reason})`);
}

function enqueueRegistrySync(conn, registry, reason) {
  const previous = registryQueue.get("all") || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => retry(() => syncRegistry(conn, registry, reason), `Sync ${registry.name}`));
  registryQueue.set("all", next);
  return next;
}

async function syncAll(conn, reason = "startup") {
  for (const registry of registries) {
    await enqueueRegistrySync(conn, registry, reason);
  }
}

async function subscribeToUpdates(conn) {
  const devicesRegistry = registries.find(registry => registry.name === "devices");
  await conn.subscribeMessage(() => {
    enqueueRegistrySync(conn, devicesRegistry, "config entries changed").catch(error => log(error.message));
  }, { type: "config_entries/subscribe" });
  for (const registry of registries) {
    await retry(
      async () => {
        await conn.subscribeEvents((eventPayload) => {
          const eventType = eventPayload?.event_type || registry.event;
          log(`Event received: ${eventType}`);
          if (eventType === "area_registry_updated") {
            log("Area Registry updated -> re-syncing");
          }
          if (eventType === "floor_registry_updated") {
            log("Floor Registry updated -> re-syncing");
          }
          if (eventType === "device_registry_updated") {
            log("Device Registry updated -> re-syncing");
          }
          if (eventType === "label_registry_updated") {
            log("Label Registry updated -> re-syncing");
          }
          enqueueRegistrySync(conn, registry, `event ${eventType}`).catch(error => log(error.message));
        }, registry.event);
      },
      `Subscription ${registry.event}`
    );
    log(`Active subscription: ${registry.event}`);
  }
}

async function connectAndRun() {
  const token = (SUPERVISOR_TOKEN || "").trim();
  if (!token) {
    throw new Error("SUPERVISOR_TOKEN is not defined.");
  }

  const auth = {
    wsUrl: SUPERVISOR_WS_URL,
    accessToken: token,
    expired: false,
    refreshAccessToken: async () => {
      auth.accessToken = token;
      auth.expired = false;
    },
  };

  log(`Connecting to Home Assistant WebSocket: ${SUPERVISOR_WS_URL}`);
  const conn = await createConnection({
    auth,
    setupRetry: -1,
  });

  log("Connection and authentication successful.");

  conn.addEventListener("ready", () => {
    log("WebSocket connection ready. Re-syncing registries...");
    for (const registry of registries) {
      enqueueRegistrySync(conn, registry, "ready").catch(error => log(error.message));
    }
  });

  conn.addEventListener("disconnected", () => {
    log("WebSocket disconnected. The library will retry automatically.");
  });

  conn.addEventListener("reconnect-error", (event) => {
    const details = event?.data || "";
    log(`WebSocket reconnect error: ${details}`);
  });

  await syncAll(conn, "startup");
  await subscribeToUpdates(conn);

  log("Sync worker started and listening for events.");
  return conn;
}

async function main() {
  while (true) {
    try {
      const conn = await connectAndRun();
      await new Promise((resolve) => {
        process.once("SIGTERM", resolve);
        process.once("SIGINT", resolve);
      });
      await conn.close();
      process.exit(0);
    } catch (error) {
      const errorMessage = describeConnectionError(error);
      log(`Sync worker failed: ${errorMessage}`);
      if (error === 2) {
        log("Authentication was rejected by Home Assistant. Verify SUPERVISOR_TOKEN permissions and validity.");
      } else if (error === 1) {
        log("Cannot connect to ws://supervisor/core/websocket. Verify add-on API permissions/network.");
      }
      log("Retrying main connection in 10 seconds...");
      await wait(10000);
    }
  }
}

main().catch((error) => {
  const errorMessage = error?.message || String(error);
  log(`Error fatal: ${errorMessage}`);
  process.exit(1);
});
