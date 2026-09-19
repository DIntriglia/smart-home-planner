// Shared by the settings UI and registry worker. No browser or Node dependencies.
(() => {
const AUTO_EXCLUDED_DEVICE_MANUFACTURERS = new Set([
  "officialaddons",
  "homeassistant",
  "homeassistantcommunityapps",
  "localaddons",
  "tailscaleinc",
  "proxmoxve",
  "hacsxyz",
  "ping",
  "uptimekuma",
  "systemmonitor",
  "googlecastgroup",
  "googledrive",
  "musicassistant",
  "Zigbee2mqtt"
].map((value) => normalizeManufacturerKey(value)).filter(Boolean));
const AUTO_EXCLUDED_DEVICE_NAMES = new Set([
  "sun",
  "Google Translate es com"
].map((value) => normalizeString(value).toLowerCase()).filter(Boolean));
const AUTO_EXCLUDED_DEVICE_MODELS = new Set([
  "plugin",
  "integration",
  "alarmo",
  "forecast",
  "homeassistantapp",
  "jukeboxcontroller",
  "watchman",
  "googlecastgroup",
  "googledrive",
  "cloud",
].map((value) => normalizeModelKey(value)).filter(Boolean));
const AUTO_EXCLUDED_DEVICE_IDENTIFIER_NAMESPACES = new Set([
  "music_assistant",
  "google_weather"
].map((value) => normalizeString(value).toLowerCase()).filter(Boolean));
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeHaDeviceIds(values) {
  const result = [];
  const seen = new Set();
  const source = Array.isArray(values) ? values : values ? [values] : [];
  for (const value of source) {
    const normalized = normalizeString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function getLinkedHaDeviceIds(device) {
  if (!device || typeof device !== "object") {
    return [];
  }
  const direct = normalizeHaDeviceIds(device.haDeviceIds || device.homeAssistantDeviceIds);
  if (direct.length) {
    return direct;
  }
  const hasFlag = Boolean(
    device.homeAssistant === true ||
      ["true", "1", "yes"].includes(normalizeString(device.homeAssistant).toLowerCase())
  );
  if (hasFlag) {
    const fallbackId = normalizeString(device.id);
    return fallbackId ? [fallbackId] : [];
  }
  return [];
}

function normalizeManufacturerKey(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeModelKey(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Mirrors normalizeOptionValue() in src/js/common.js — the slug the UI uses to
// match a device value against its configured option list. Keep both in sync.
function normalizeOptionSlug(value) {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/\s*&\s*/g, "-")
    .replace(/\//g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized === "wi-fi" ? "wifi" : normalized;
}

// Mirrors the frontend fallback for values that were stored as their own slug:
// "intel" is shown as "Intel". Anything already written as a label is kept.
function formatOptionLabel(value) {
  const label = normalizeString(value);
  if (!label || label !== normalizeOptionSlug(label)) return label;
  return label
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Home Assistant reports the manufacturer as registered by the integration, so
// it arrives decorated with trademark symbols and legal forms ("Aqara™",
// "Google Inc.", "Shenzhen Neo Electronics Co., Ltd."). Devices are tagged with
// the trimmed name instead, which is what a user would type by hand.
const BRAND_SYMBOL_PATTERN = /[™®©℠]/g;
const BRAND_LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "corp", "corporation", "co", "company",
  "ltd", "ltda", "limited", "llc", "llp", "plc",
  "gmbh", "mbh", "ag", "kg", "kgaa", "ug",
  "sa", "sas", "sarl", "sl", "srl", "spa",
  "ab", "aps", "as", "bv", "nv", "oy", "oyj",
  "kk", "pte", "pty",
]);
const BRAND_MAX_SUFFIX_PASSES = 4;
// Applied to the cleaned name, so "Google Inc." needs no entry here.
const BRAND_ALIASES = new Map([
  ["googlenest", "Google"],
  ["raspberrypitrading", "Raspberry Pi"],
]);

function stripBrandLegalSuffixes(value) {
  let result = value;
  // "Co., Ltd." peels one suffix per pass.
  for (let pass = 0; pass < BRAND_MAX_SUFFIX_PASSES; pass += 1) {
    const match = result.match(/^(.+?)[\s,]+([^\s,]+)$/);
    if (!match) break;
    const head = match[1].replace(/[\s,]+$/, "");
    const tail = match[2].toLowerCase().replace(/[./]/g, "");
    if (!head || !BRAND_LEGAL_SUFFIXES.has(tail)) break;
    result = head;
  }
  return result;
}

function cleanBrandName(value) {
  const collapsed = normalizeString(value)
    .replace(BRAND_SYMBOL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "";
  const stripped = stripBrandLegalSuffixes(collapsed).replace(/[\s,]+$/, "").trim();
  // A manufacturer named after its legal form alone keeps its original name.
  return stripped || collapsed;
}

function normalizeBrand(value) {
  const cleaned = cleanBrandName(value);
  if (!cleaned) return "";
  return BRAND_ALIASES.get(normalizeManufacturerKey(cleaned)) || cleaned;
}

// A brand assigned by the sync must also exist in the device option list, or it
// never shows up in Settings > Device Options and cannot be renamed or reused —
// an orphan brand nobody created by hand.
//
// The default brands live in the frontend (src/js/metadata.js) and are not
// readable from here, so one that happens to be a default is still added as a
// custom; normalizeCustomOptionValues() in common.js drops the duplicate on the
// next settings load. Hidden defaults are un-hidden instead, otherwise the
// option would stay invisible while a device points at it.
function createBrandOptionRegistry(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const storedCustoms = Array.isArray(source.customOptions?.brands)
    ? source.customOptions.brands
    : null;
  // Pre-1.8.0 storage keeps one flat list per group. Writing customOptions here
  // would make the frontend migration skip it and drop the user's own brands,
  // so the legacy list is extended in place until the frontend migrates it.
  const legacyList = storedCustoms === null && Array.isArray(source.brands) ? source.brands : null;
  const values = [...(storedCustoms || legacyList || [])];
  const hiddenSlugs = Array.isArray(source.hiddenDefaults?.brands)
    ? [...source.hiddenDefaults.brands]
    : [];
  const bySlug = new Map();
  const byKey = new Map();
  let addedCount = 0;
  let unhiddenCount = 0;

  const index = (label) => {
    const slug = normalizeOptionSlug(label);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, label);
    const key = normalizeManufacturerKey(label);
    if (key && !byKey.has(key)) byKey.set(key, label);
  };
  values.forEach(index);

  const unhide = (slug) => {
    const position = hiddenSlugs.findIndex((hidden) => normalizeOptionSlug(hidden) === slug);
    if (position < 0) return;
    hiddenSlugs.splice(position, 1);
    unhiddenCount += 1;
  };

  const add = (label) => {
    values.push(label);
    index(label);
    addedCount += 1;
  };

  return {
    // For devices created by the sync: reuses the configured label when the
    // brand is already known ("TPLink" -> "TP-Link"), registers it otherwise.
    resolve(brand) {
      const label = normalizeString(brand);
      const slug = normalizeOptionSlug(label);
      if (!slug) return "";
      unhide(slug);
      const known = bySlug.get(slug) || byKey.get(normalizeManufacturerKey(label));
      if (known) return known;
      add(label);
      return label;
    },
    // For devices the user already owns: their brand is never rewritten, it is
    // only registered as an option when it is missing from the list.
    register(brand) {
      const label = normalizeString(brand);
      const slug = normalizeOptionSlug(label);
      if (!slug) return "";
      unhide(slug);
      if (!bySlug.has(slug)) add(formatOptionLabel(label));
      return label;
    },
    getAddedCount() {
      return addedCount;
    },
    // Returns the settings to persist, or null when nothing changed.
    buildNextSettings() {
      if (!addedCount && !unhiddenCount) return null;
      const next = { ...source };
      if (legacyList !== null) {
        next.brands = values;
      } else {
        next.customOptions = { ...(next.customOptions || {}), brands: values };
      }
      if (unhiddenCount) {
        next.hiddenDefaults = { ...(next.hiddenDefaults || {}), brands: hiddenSlugs };
      }
      return next;
    },
  };
}

function shouldAutoExcludeOnCreate(haDevice) {
  const disabledBy = normalizeString(haDevice?.disabled_by).toLowerCase();
  if (disabledBy === "user" || disabledBy === "config_entry") {
    return true;
  }
  const identifiers = Array.isArray(haDevice?.identifiers) ? haDevice.identifiers : [];
  const hasExcludedIdentifierNamespace = identifiers.some(
    (entry) =>
      Array.isArray(entry) &&
      AUTO_EXCLUDED_DEVICE_IDENTIFIER_NAMESPACES.has(normalizeString(entry[0]).toLowerCase())
  );
  if (hasExcludedIdentifierNamespace) {
    return true;
  }
  const manufacturerKey = normalizeManufacturerKey(haDevice?.manufacturer);
  if (AUTO_EXCLUDED_DEVICE_MANUFACTURERS.has(manufacturerKey)) {
    return true;
  }
  const modelKey = normalizeModelKey(haDevice?.model);
  if (AUTO_EXCLUDED_DEVICE_MODELS.has(modelKey)) {
    return true;
  }
  const rawName = normalizeString(haDevice?.name_by_user) || normalizeString(haDevice?.name);
  const nameKey = rawName.toLowerCase();
  return AUTO_EXCLUDED_DEVICE_NAMES.has(nameKey);
}

function pickDeviceName(device) {
  return (
    normalizeString(device?.name_by_user) ||
    normalizeString(device?.name) ||
    normalizeString(device?.id)
  );
}

function getHaAreaSyncTarget(settings) {
  if (settings && settings.haAreaSyncTarget === "installed") {
    return "installed";
  }
  return "controlled";
}

function getExcludedDeviceIds(storage) {
  const source = Array.isArray(storage?.excluded_devices)
    ? storage.excluded_devices
    : Array.isArray(storage?.excludedDevices)
      ? storage.excludedDevices
      : [];
  return new Set(source.map((value) => normalizeString(value)).filter(Boolean));
}

function buildSyncedDevice(haDevice, existingDevice, haAreaSyncTarget, allowedLabels, brandRegistry) {
  const id = normalizeString(haDevice?.id);
  const areaId = normalizeString(haDevice?.area_id);
  const manufacturer = normalizeBrand(haDevice?.manufacturer);
  const model = normalizeString(haDevice?.model);
  let haLabels = Array.isArray(haDevice?.labels)
    ? haDevice.labels.map((label) => normalizeString(label)).filter(Boolean)
    : Array.isArray(haDevice?.label_ids)
      ? haDevice.label_ids.map((label) => normalizeString(label)).filter(Boolean)
      : null;
  if (haLabels && allowedLabels instanceof Set) {
    haLabels = haLabels.filter((label) => allowedLabels.has(label));
  }
  const hasExistingDevice = Boolean(existingDevice && typeof existingDevice === "object");
  const base = hasExistingDevice ? { ...existingDevice } : {};
  const existingId = normalizeString(existingDevice?.id);
  const deviceId = existingId || id;
  const linkedHaIds = hasExistingDevice ? getLinkedHaDeviceIds(existingDevice) : [];
  if (id && !linkedHaIds.includes(id)) {
    linkedHaIds.push(id);
  }

  const synced = {
    ...base,
    id: deviceId,
    name: pickDeviceName(haDevice) || normalizeString(base.name) || id,
    brand: hasExistingDevice ? brandRegistry.register(base.brand) : brandRegistry.resolve(manufacturer),
    model: hasExistingDevice ? normalizeString(base.model) : model,
    homeAssistant: linkedHaIds.length > 0,
    haDeviceIds: linkedHaIds,
  };
  if (haLabels !== null) {
    synced.labels = haLabels;
  } else if (!Array.isArray(synced.labels)) {
    synced.labels = [];
  }

  if (!hasExistingDevice) {
    synced.status = "working";
    synced.area = areaId;
    synced.controlledArea = areaId;
  } else if (haAreaSyncTarget === "controlled") {
    synced.controlledArea = areaId;
  } else {
    synced.area = areaId;
  }

  delete synced.createdAt;
  return synced;
}


function normalizeDomains(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .filter(value => typeof value === "string")
        .map(value => value.trim().toLowerCase()).filter(Boolean))].sort();
}

function enrichDevices(devices, entries) {
    const byId = new Map((entries || []).map(entry => [entry.entry_id, entry.domain]));
    return devices.map(device => {
        const ids = Array.isArray(device.config_entries) ? device.config_entries : [];
        return { ...device,
            integrationDomains: normalizeDomains(ids.map(id => byId.get(id))),
            integrationMembershipResolved: entries !== null && ids.length > 0 && ids.every(id => byId.has(id))
        };
    });
}

function isIntegrationExcluded(device, exclusions) {
    const domains = normalizeDomains(device?.integrationDomains);
    return device?.integrationMembershipResolved === true && domains.length > 0 &&
        domains.every(domain => exclusions.includes(domain));
}

async function cleanupRemovedFiles(removed, retained, apiUrl) {
    const keep = new Set(retained.flatMap(device => (device.files || []).map(file => file.path)));
    const paths = new Set(removed.flatMap(device => (device.files || []).map(file => file.path)).filter(Boolean));
    const failures = [];
    for (const filePath of paths) {
        if (keep.has(filePath)) continue;
        try {
            const response = await fetch(`${apiUrl}?path=${encodeURIComponent(filePath)}`, { method: "DELETE" });
            if (!response.ok && response.status !== 404) failures.push(filePath);
        } catch (_error) {
            failures.push(filePath);
        }
    }
    return failures;
}

function buildStorageDevicesUpdate(storage, haDevices, allowedLabels) {
  storage = structuredClone(storage);
  const integrationExclusions = normalizeDomains(storage.settings?.haExcludedIntegrations);
  const registryById = new Map((haDevices || []).map(device => [device.id, device]));
  const blockedIds = new Set((haDevices || []).filter(device =>
    isIntegrationExcluded(device, integrationExclusions)).map(device => device.id));
  const previousBlocked = Array.isArray(storage.integration_excluded_devices) ? storage.integration_excluded_devices : [];
  // Retain known exclusions until membership can be resolved again.
  for (const id of previousBlocked) {
    const device = registryById.get(id);
    if (integrationExclusions.length && (!device || !device.integrationMembershipResolved)) blockedIds.add(id);
  }
  const removedDevices = [];

  const haAreaSyncTarget = getHaAreaSyncTarget(storage.settings);
  const brandRegistry = createBrandOptionRegistry(storage.settings);
  const excludedDeviceIds = getExcludedDeviceIds(storage);
  const existingDevices = Array.isArray(storage.devices) ? storage.devices : [];
  const existingById = new Map(
    existingDevices
      .filter((device) => device && typeof device === "object")
      .map((device) => [normalizeString(device.id), device])
      .filter(([id]) => Boolean(id))
  );
  const existingByHaId = new Map();
  existingDevices.forEach((device) => {
    if (!device || typeof device !== "object") return;
    const linkedIds = getLinkedHaDeviceIds(device);
    linkedIds.forEach((haId) => {
      if (!haId || existingByHaId.has(haId)) return;
      existingByHaId.set(haId, device);
    });
  });

  const sourceDevices = (haDevices || []).filter((device) => device && typeof device === "object");
  const sourceDevicesAfterExclusions = [];
  const autoExcludedOnCreateIds = new Set();
  let excludedDevicesCount = 0;

  for (const sourceDevice of sourceDevices) {
    const id = normalizeString(sourceDevice?.id);
    if (!id) continue;

    if (blockedIds.has(id)) continue;

    // Existing devices are never auto-excluded by sync rules.
    if (existingById.has(id)) {
      sourceDevicesAfterExclusions.push(sourceDevice);
      continue;
    }

    if (excludedDeviceIds.has(id)) {
      excludedDevicesCount += 1;
      continue;
    }

    if (shouldAutoExcludeOnCreate(sourceDevice)) {
      autoExcludedOnCreateIds.add(id);
      excludedDevicesCount += 1;
      continue;
    }

    sourceDevicesAfterExclusions.push(sourceDevice);
  }

  const sourceById = new Map(
    sourceDevicesAfterExclusions
      .map((device) => [normalizeString(device?.id), device])
      .filter(([id, device]) => Boolean(id) && Boolean(device))
  );

  const syncedIds = new Set();
  const nextDevices = [];
  let unlinkedDevicesCount = 0;
  let createdDevicesCount = 0;

  for (const existingDevice of existingDevices) {
    if (!existingDevice || typeof existingDevice !== "object") {
      continue;
    }
    const id = normalizeString(existingDevice.id);
    if (!id) {
      nextDevices.push(existingDevice);
      continue;
    }

    const linkedHaIds = getLinkedHaDeviceIds(existingDevice);
    const membershipIds = [...new Set([...linkedHaIds, ...(registryById.has(id) ? [id] : [])])];
    if (membershipIds.length && membershipIds.every(haId => blockedIds.has(haId))) {
      removedDevices.push(existingDevice);
      continue;
    }
    const directSource = sourceById.get(id);
    let sourceDevice = directSource || null;
    if (!sourceDevice && linkedHaIds.length > 0) {
      for (const haId of linkedHaIds) {
        const candidate = sourceById.get(haId);
        if (candidate) {
          sourceDevice = candidate;
          break;
        }
      }
    }

    if (sourceDevice) {
      nextDevices.push(
        buildSyncedDevice(sourceDevice, existingDevice, haAreaSyncTarget, allowedLabels, brandRegistry)
      );
      if (directSource) {
        syncedIds.add(id);
      }
      linkedHaIds.forEach((haId) => {
        if (sourceById.has(haId)) {
          syncedIds.add(haId);
        }
      });
      syncedIds.add(normalizeString(sourceDevice.id));
      continue;
    }

    // A missing linked registry entry is unresolved, not an instruction to
    // forget links on a record partly excluded by integration preferences.
    if (membershipIds.some(haId => blockedIds.has(haId))) {
      nextDevices.push(existingDevice);
      continue;
    }
    const wasLinkedToHa = Boolean(existingDevice.homeAssistant);
    const retainedDevice = {
      ...existingDevice,
      homeAssistant: false,
      haDeviceIds: [],
    };
    nextDevices.push(retainedDevice);
    if (wasLinkedToHa) {
      unlinkedDevicesCount += 1;
    }
  }

  for (const sourceDevice of sourceDevicesAfterExclusions) {
    const id = normalizeString(sourceDevice?.id);
    if (!id || syncedIds.has(id)) continue;
    const existingDevice = existingById.get(id) || existingByHaId.get(id);
    nextDevices.push(
      buildSyncedDevice(sourceDevice, existingDevice, haAreaSyncTarget, allowedLabels, brandRegistry)
    );
    createdDevicesCount += 1;
  }

  const nextExcludedDevices = [...excludedDeviceIds];
  for (const id of autoExcludedOnCreateIds) {
    if (excludedDeviceIds.has(id)) continue;
    excludedDeviceIds.add(id);
    nextExcludedDevices.push(id);
  }

  for (const removed of removedDevices) {
    globalThis.clearReferencesToDevice(nextDevices, removed.id);
  }
  const removedIds = new Set(removedDevices.map(device => device.id));
  const nextStorage = {
    ...storage,
    devices: nextDevices,
    integration_excluded_devices: [...blockedIds],
    ...(Array.isArray(storage.isps) ? { isps: storage.isps.map(isp =>
      removedIds.has(isp?.gatewayDeviceId) ? { ...isp, gatewayDeviceId: "" } : isp) } : {}),
    excluded_devices: nextExcludedDevices,
  };

  const nextSettings = brandRegistry.buildNextSettings();
  if (nextSettings) {
    nextStorage.settings = nextSettings;
  }

  return {
    nextStorage,
    removedDevices,
    stats: {
      deviceCount: nextDevices.length,
      haAreaSyncTarget,
      excludedDevicesCount,
      autoExcludedCount: autoExcludedOnCreateIds.size,
      unlinkedDevicesCount,
      createdDevicesCount,
      addedBrandCount: brandRegistry.getAddedCount(),
    },
  };
}


globalThis.HaSyncModel = { buildStorageDevicesUpdate, getLinkedHaDeviceIds, enrichDevices, isIntegrationExcluded, normalizeDomains, cleanupRemovedFiles };
})();
