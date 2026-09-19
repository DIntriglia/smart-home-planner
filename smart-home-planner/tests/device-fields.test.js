import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/js/custom-fields.js", import.meta.url), "utf8");
function fixture(conflict = false) {
    const state = { data: { devices: [{ id: "manual", customFields: { existing: "0012-3456" } }], settings: { concurrent: "keep", customFieldDefinitions: [{ id: "existing", label: "Matter code" }] } } };
    const context = vm.createContext({
        console, Math, Date,
        settings: {}, storageEtag: null, storageCache: null,
        enqueueStorageWrite: task => task(), buildAppUrl: path => `/ingress/${path}`,
        fetch: async url => { assert.equal(url, "/ingress/api/storage"); return { ok: true, json: async () => structuredClone(state.data) }; },
        parseStorageEtag: () => '"fresh"',
        putStoragePayload: async data => {
            assert.equal(context.storageEtag, '"fresh"');
            if (conflict) throw new Error("Save conflict");
            state.data = JSON.parse(JSON.stringify(data));
        },
        mergeStorage: data => data, normalizeSettings: data => data
    });
    vm.runInContext(source, context);
    return { context, state };
}

test("rename and archive preserve device text and concurrent settings", async () => {
    const { context, state } = fixture();
    await context.changeCustomFieldDefinition("existing", "Matter Setup Code", true);
    assert.equal(state.data.settings.concurrent, "keep");
    assert.deepEqual(state.data.devices[0].customFields, { existing: "0012-3456" });
    assert.deepEqual(state.data.settings.customFieldDefinitions[0], { id: "existing", label: "Matter Setup Code", archived: true });
    await context.changeCustomFieldDefinition("existing", "Matter Setup Code", false);
    assert.equal(state.data.settings.customFieldDefinitions[0].archived, false);
});

test("new definitions have stable distinct IDs and invalid or duplicate names are rejected", async () => {
    const { context, state } = fixture();
    await context.changeCustomFieldDefinition(null, "Asset Tag", false);
    assert.notEqual(state.data.settings.customFieldDefinitions[1].id, "existing");
    await assert.rejects(context.changeCustomFieldDefinition(null, "matter CODE", false), /already exists/);
    await assert.rejects(context.changeCustomFieldDefinition(null, "  ", false), /1–80/);
});

test("rejected writes leave custom field definitions and inventory intact", async () => {
    const { context, state } = fixture(true);
    const before = structuredClone(state.data);
    await assert.rejects(context.changeCustomFieldDefinition("existing", "Changed", true), /conflict/);
    assert.deepEqual(state.data, before);
});

test("source filtering works without HA and includes all domains of shared devices", async () => {
    const common = await readFile(new URL("../src/js/common.js", import.meta.url), "utf8");
    const context = vm.createContext({ normalizeHaIntegrationFlag: value => value === true });
    vm.runInContext(common.slice(common.indexOf("function getDeviceHaDomains(")), context);
    assert.equal(context.getDeviceSourceLabel({}), "Manual");
    assert.equal(context.matchesDeviceSource({}, "manual"), true);
    const device = { homeAssistant: true, haIntegrationDomains: ["mqtt", "zha", "mqtt"] };
    assert.equal(context.matchesDeviceSource(device, "ha:zha"), true);
    assert.equal(context.matchesDeviceSource(device, "ha:matter"), false);
    assert.equal(context.getDeviceSourceLabel(device), "Home Assistant · mqtt, zha");
    assert.match(context.getDeviceSourceLabel({ homeAssistant: true }), /integration unknown/);
    assert.match(context.getDeviceSourceLabel({ source: "homeAssistant", haIntegrationDomains: ["mqtt"] }), /not linked/);
});
