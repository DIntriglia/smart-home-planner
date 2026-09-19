import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import "../src/js/data-consistency.js";
import "../src/js/ha-sync-model.js";

async function workerFixture() {
    let source = await fs.readFile(new URL("../registry-sync.js", import.meta.url), "utf8");
    source = source.replace(/^import .*;\n/gm, "");
    source = source.slice(0, source.indexOf("main().catch"));
    const files = new Map();
    const state = { storage: { devices: [], settings: {} }, etag: '"1"', writes: [], requests: [], conflict: false, failEntries: false };
    const conn = {
        async sendMessagePromise({ type }) {
            state.requests.push(type);
            if (type === "config_entries/get") {
                if (state.failEntries) throw new Error("unavailable");
                return [{ entry_id: "mqtt-entry", domain: "mqtt", data: { secret: "not-persisted" } }];
            }
            if (type === "config/device_registry/list") return [{ id: "one", config_entries: ["mqtt-entry"], name: "One" }];
            return [];
        },
        async subscribeMessage(callback, message) { state.subscription = { callback, message }; },
        async subscribeEvents() {},
        addEventListener(event, callback) { state[event] = callback; }
    };
    const context = vm.createContext({
        HaSyncModel: globalThis.HaSyncModel, path, process: { env: { SUPERVISOR_TOKEN: "test" } },
        WebSocket: class {}, createConnection: async () => conn, console: { log() {} }, setTimeout,
        fs: {
            async mkdir() {},
            async writeFile(name, content) { files.set(name, content); },
            async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
            async readFile(name) { if (!files.has(name)) throw Object.assign(new Error("Missing"), { code: "ENOENT" }); return files.get(name); }
        },
        fetch: async (url, options = {}) => {
            if (options.method === "DELETE") { state.deleted = true; return { ok: true, status: 204 }; }
            if (options.method !== "PUT") return { ok: true, headers: { get: () => state.etag }, json: async () => structuredClone(state.storage) };
            state.writes.push(options);
            if (state.conflict) {
                state.conflict = false;
                state.etag = '"2"';
                state.storage.settings = { haExcludedIntegrations: [], concurrent: "keep" };
                return { ok: false, status: 409, json: async () => ({ code: "storage_conflict" }) };
            }
            assert.equal(options.headers["If-Match"], state.etag);
            state.storage = JSON.parse(options.body);
            return { ok: true, status: 204 };
        }
    });
    vm.runInContext(source + "\nglobalThis.worker = { connectAndRun, syncAll, syncStorageDevicesFromRegistry, drain: () => registryQueue.get('all') };", context);
    return { worker: context.worker, state, files, conn };
}

test("startup, reconnect and config-entry subscription refresh sanitized membership", async () => {
    const { worker, state, files } = await workerFixture();
    await worker.connectAndRun();
    assert.equal(state.subscription.message.type, "config_entries/subscribe");
    assert.deepEqual(JSON.parse(files.get("/data/integrations.json")), [{ entry_id: "mqtt-entry", domain: "mqtt" }]);
    const cached = JSON.parse(files.get("/data/devices.json"))[0];
    assert.deepEqual(cached.config_entries, ["mqtt-entry"]);
    assert.deepEqual(cached.integrationDomains, ["mqtt"]);
    assert.equal(cached.integrationMembershipResolved, true);
    const before = state.requests.filter(type => type === "config_entries/get").length;
    state.ready(); await worker.drain();
    state.subscription.callback(); await worker.drain();
    assert.equal(state.requests.filter(type => type === "config_entries/get").length, before + 2);
});

test("membership failure preserves existing devices and marks metadata unresolved", async () => {
    const { worker, state, conn, files } = await workerFixture();
    state.storage = { devices: [{ id: "one", homeAssistant: true, notes: "keep" }], settings: { haExcludedIntegrations: ["mqtt"] } };
    state.failEntries = true;
    await worker.syncAll(conn);
    assert.equal(state.storage.devices[0].notes, "keep");
    assert.equal(JSON.parse(files.get("/data/devices.json"))[0].integrationMembershipResolved, false);
});

test("ETag retry rebuilds against latest preferences and never cleans up rejected deletion", async () => {
    const { worker, state } = await workerFixture();
    state.storage = { devices: [{ id: "one", homeAssistant: true, notes: "keep", files: [{ path: "one/file" }] }], settings: { haExcludedIntegrations: ["mqtt"] } };
    state.conflict = true;
    await worker.syncStorageDevicesFromRegistry([{ id: "one", integrationDomains: ["mqtt"], integrationMembershipResolved: true }]);
    assert.equal(state.writes.length, 2);
    assert.equal(state.writes[0].headers["X-SHP-Allow-Empty"], "1");
    assert.equal(state.writes[1].headers["X-SHP-Allow-Empty"], undefined);
    assert.equal(state.storage.settings.concurrent, "keep");
    assert.equal(state.storage.devices[0].notes, "keep");
    assert.equal(state.deleted, undefined);
});
