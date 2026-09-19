import test from "node:test";
import assert from "node:assert/strict";
import "../src/js/data-consistency.js";
import "../src/js/ha-sync-model.js";
const { enrichDevices, buildStorageDevicesUpdate: sync, cleanupRemovedFiles } = globalThis.HaSyncModel;
const entries = [{ entry_id: "a", domain: "mqtt" }, { entry_id: "b", domain: "zha" }, { entry_id: "c", domain: "mqtt" }];
const ha = (id, ids = ["a"], extra = {}) => enrichDevices([{ id, name: id, config_entries: ids, ...extra }], entries)[0];
const storage = (domains = [], devices = []) => ({ settings: { haExcludedIntegrations: domains }, devices });

test("legacy defaults and new domains remain included", () => {
    assert.equal(sync({ devices: [] }, [ha("one")]).nextStorage.devices.length, 1);
    assert.equal(sync(storage(["mqtt"]), [ha("new", ["b"])]).nextStorage.devices.length, 1);
});

test("multiple configured instances share a domain", () => {
    const result = sync(storage(["mqtt"]), [ha("one"), ha("two", ["c"])]);
    assert.deepEqual(result.nextStorage.devices, []);
    assert.deepEqual(result.nextStorage.integration_excluded_devices, ["one", "two"]);
    assert.deepEqual(result.nextStorage.excluded_devices, []);
});

test("a shared device requires all integrations unchecked", () => {
    const device = ha("shared", ["a", "b"]);
    assert.equal(sync(storage(["mqtt"]), [device]).nextStorage.devices.length, 1);
    assert.equal(sync(storage(["mqtt", "zha"]), [device]).nextStorage.devices.length, 0);
});

test("existing records are removed with reference and gateway cleanup without mutating input", () => {
    const input = storage(["mqtt"], [
        { id: "one", homeAssistant: true, notes: "custom", files: [{ path: "one/a.pdf" }] },
        { id: "manual", wifiAccessPointId: "one", zigbeeLinkedDeviceIds: ["one"], ports: [{ connectedTo: "one", connectedToPort: "port1" }] }
    ]);
    input.isps = [{ id: "isp", gatewayDeviceId: "one" }];
    const result = sync(input, [ha("one")]);
    assert.equal(result.removedDevices.length, 1);
    assert.equal(result.nextStorage.devices.length, 1);
    assert.equal(result.nextStorage.devices[0].wifiAccessPointId, "");
    assert.deepEqual(result.nextStorage.devices[0].zigbeeLinkedDeviceIds, []);
    assert.equal(result.nextStorage.devices[0].ports[0].connectedToPort, "");
    assert.equal(result.nextStorage.isps[0].gatewayDeviceId, "");
    assert.equal(input.devices[1].wifiAccessPointId, "one");
});

test("linked inventory survives while any linked HA device remains eligible", () => {
    const record = { id: "local", homeAssistant: true, haDeviceIds: ["one", "two"], notes: "keep" };
    const result = sync(storage(["mqtt"], [record]), [ha("one"), ha("two", ["b"])]);
    assert.equal(result.nextStorage.devices.length, 1);
    assert.equal(result.nextStorage.devices[0].notes, "keep");
    assert.deepEqual(result.nextStorage.devices[0].haDeviceIds, ["one", "two"]);
    assert.equal(sync(storage(["mqtt", "zha"], [record]), [ha("one"), ha("two", ["b"])]).removedDevices.length, 1);
});

test("unknown, missing and partially resolved memberships never cause new removal", () => {
    for (const device of [ha("one", []), ha("one", ["unknown"]), ha("one", ["a", "unknown"]), ...enrichDevices([{ id: "one", config_entries: ["a"] }], null)]) {
        assert.equal(sync(storage(["mqtt"], [{ id: "one", homeAssistant: true }]), [device]).removedDevices.length, 0);
    }
    const linked = { id: "local", homeAssistant: true, haDeviceIds: ["one", "missing"] };
    assert.equal(sync(storage(["mqtt"], [linked]), [ha("one")]).removedDevices.length, 0);
});

test("rechecking imports fresh data and preserves independent exclusions", () => {
    let result = sync(storage(["mqtt"], [{ id: "one", notes: "deleted", homeAssistant: true }]), [ha("one"), ha("manual")]);
    result.nextStorage.excluded_devices = ["manual"];
    result.nextStorage.settings.haExcludedIntegrations = [];
    result = sync(result.nextStorage, [ha("one"), ha("manual")]);
    assert.deepEqual(result.nextStorage.devices.map(device => device.id), ["one"]);
    assert.equal(result.nextStorage.devices[0].notes, undefined);
    assert.deepEqual(result.nextStorage.excluded_devices, ["manual"]);
    assert.deepEqual(result.nextStorage.integration_excluded_devices, []);
});

test("automatic exclusions still apply after re-enabling an integration", () => {
    const result = sync(storage(), [ha("system", ["a"], { manufacturer: "Home Assistant" })]);
    assert.deepEqual(result.nextStorage.devices, []);
    assert.deepEqual(result.nextStorage.excluded_devices, ["system"]);
});

test("saved exclusions survive missing metadata without new imports", () => {
    const input = { ...storage(["mqtt"]), integration_excluded_devices: ["one"] };
    const result = sync(input, [{ id: "one" }]);
    assert.deepEqual(result.nextStorage.integration_excluded_devices, ["one"]);
    assert.deepEqual(result.nextStorage.devices, []);
});

test("resolved membership changes and reconnection allow newly eligible devices", () => {
    const input = { ...storage(["mqtt"]), integration_excluded_devices: ["one"] };
    assert.equal(sync(input, [ha("one", ["b"])]).nextStorage.devices.length, 1);
});

test("attachment cleanup is deduplicated, retains shared files and reports failures", async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push([url, options.method]);
        return { ok: !url.includes("failed"), status: url.includes("failed") ? 500 : 204 };
    };
    try {
        const removed = [{ files: [{ path: "one/a b.pdf" }, { path: "shared" }, { path: "failed" }, { path: "failed" }] }];
        const failures = await cleanupRemovedFiles(removed, [{ files: [{ path: "shared" }] }], "/ingress/api/device-files");
        assert.deepEqual(failures, ["failed"]);
        assert.deepEqual(calls, [["/ingress/api/device-files?path=one%2Fa%20b.pdf", "DELETE"], ["/ingress/api/device-files?path=failed", "DELETE"]]);
    } finally { globalThis.fetch = original; }
});

test("partially excluded records retain unresolved links for the next sync", () => {
    const record = { id: "local", homeAssistant: true, haDeviceIds: ["one", "missing"] };
    const first = sync(storage(["mqtt"], [record]), [ha("one")]);
    assert.deepEqual(first.nextStorage.devices[0].haDeviceIds, ["one", "missing"]);
    const second = sync(first.nextStorage, [ha("one"), ha("missing")]);
    assert.equal(second.removedDevices.length, 1);
});

test("browser storage normalization preserves integration exclusions during unrelated saves", async () => {
    const { readFile } = await import("node:fs/promises");
    const { runInNewContext } = await import("node:vm");
    const source = await readFile(new URL("../src/js/common.js", import.meta.url), "utf8");
    const helpers = source.slice(source.indexOf("function buildDefaultStorage()"), source.indexOf("async function loadHaRegistry"));
    const actual = runInNewContext(helpers + '\nJSON.stringify(mergeStorage({ integration_excluded_devices: ["one"], settings: { haExcludedIntegrations: ["mqtt"] } }))');
    assert.deepEqual(JSON.parse(actual).integration_excluded_devices, ["one"]);
    assert.deepEqual(JSON.parse(actual).settings.haExcludedIntegrations, ["mqtt"]);
});


test("source domains are refreshed and custom field text survives registry sync", () => {
    const record = { id: "local", homeAssistant: true, haDeviceIds: ["one", "two"], customFields: { matter: "0012-3456" } };
    const result = sync(storage([], [record]), [ha("one"), ha("two", ["b"])]);
    assert.deepEqual(result.nextStorage.devices[0].haIntegrationDomains, ["mqtt", "zha"]);
    assert.equal(result.nextStorage.devices[0].source, "homeAssistant");
    assert.equal(result.nextStorage.devices[0].customFields.matter, "0012-3456");
    assert.equal(record.haIntegrationDomains, undefined);
    const offline = sync(result.nextStorage, []);
    assert.deepEqual(offline.nextStorage.devices[0].haIntegrationDomains, ["mqtt", "zha"]);
    assert.equal(offline.nextStorage.devices[0].source, "homeAssistant");
});

test("partial metadata retains prior domains without mutating retained records", () => {
    const record = { id: "local", homeAssistant: true, haDeviceIds: ["one", "missing"], haIntegrationDomains: ["zha"] };
    const result = sync(storage(["mqtt"], [record]), [ha("one")]);
    assert.deepEqual(result.nextStorage.devices[0].haIntegrationDomains, ["mqtt", "zha"]);
    assert.deepEqual(record.haIntegrationDomains, ["zha"]);
});


test("HA disabled state updates without changing planner status", () => {
    const record = { id: "one", homeAssistant: true, status: "not-working", customFields: { code: "0012" } };
    const disabled = sync(storage([], [record]), [ha("one", ["a"], { disabled_by: "user" })]).nextStorage;
    assert.equal(disabled.devices[0].haDisabledState, "disabled");
    assert.equal(disabled.devices[0].status, "not-working");
    const enabled = sync(disabled, [ha("one", ["a"], { disabled_by: null })]).nextStorage;
    assert.equal(enabled.devices[0].haDisabledState, "enabled");
    assert.equal(enabled.devices[0].status, "not-working");
    assert.equal(record.haDisabledState, undefined);
    assert.equal(sync(enabled, []).nextStorage.devices[0].haDisabledState, "unknown");
});

test("multiple linked devices distinguish all, some and unknown disabled state", () => {
    const record = { id: "local", homeAssistant: true, haDeviceIds: ["one", "two"] };
    const state = (registry) => sync(storage([], [record]), registry).nextStorage.devices[0].haDisabledState;
    const disabled = ha("one", ["a"], { disabled_by: "integration" });
    assert.equal(state([disabled, ha("two", ["b"], { disabled_by: "user" })]), "disabled");
    assert.equal(state([disabled, ha("two", ["b"], { disabled_by: null })]), "mixed");
    assert.equal(state([disabled]), "mixed");
    assert.equal(state([ha("one", ["a"], { disabled_by: null })]), "unknown");
    assert.equal(state([ha("one"), ha("two")]), "unknown");
});
