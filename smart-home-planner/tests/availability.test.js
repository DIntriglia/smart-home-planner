import test from "node:test";
import assert from "node:assert/strict";
import "../src/js/ha-availability.js";
const { buildSnapshot, summarize } = globalThis.HaAvailability;
const now = 1800000000000;
const device = { id: "one", homeAssistant: true };
function snapshot(values) {
    return buildSnapshot(values.map((_, i) => ({ device_id: "one", entity_id: `sensor.${i}` })),
        values.map((state, i) => ({ entity_id: `sensor.${i}`, state, last_changed: new Date(now - 180000).toISOString() })), now);
}
test("availability treats off and zero as available and unknown conservatively", () => {
    assert.equal(summarize(device, snapshot(["off", "0"]), 120, now).state, "available");
    assert.equal(summarize(device, snapshot(["unknown", "unavailable"]), 120, now).state, "unknown");
    assert.equal(summarize(device, snapshot(["on", "unavailable"]), 120, now).state, "partial");
    assert.equal(summarize(device, snapshot(["unavailable"]), 120, now).state, "unavailable");
});
test("grace period and stale/disconnected snapshots suppress diagnostic alarms", () => {
    const data = snapshot(["unavailable"]);
    assert.equal(summarize(device, data, 120, now).actionable, true);
    assert.equal(summarize(device, data, 300, now).actionable, false);
    assert.equal(summarize(device, data, 0, now + 121000).state, "unknown");
    assert.equal(summarize(device, {...data, connected:false}, 0, now).state, "unknown");
    assert.equal(summarize({id:"one"}, data, 0, now).state, "unknown");
});
test("disabled and action entities are excluded; values and attributes never enter cache", () => {
    const data = buildSnapshot([{device_id:"one",entity_id:"sensor.a",disabled_by:"user"},
        {device_id:"one",entity_id:"button.b"},{device_id:"one",entity_id:"sensor.c",name:"Temperature"}],
        [{entity_id:"sensor.c",state:"private-value",attributes:{secret:"secret"}}], now);
    assert.equal(data.entities.length, 1);
    assert.equal(data.entities[0].state, "available");
    assert.equal(JSON.stringify(data).includes("private-value"), false);
    assert.equal(JSON.stringify(data).includes("secret"), false);
});
test("multi-device records aggregate linked entities, never mutate planner status", () => {
    const record = {id:"local",haDeviceIds:["one","two"],homeAssistant:true,status:"working"};
    const data = snapshot(["unavailable"]);
    data.entities.push({deviceId:"two",entityId:"switch.two",state:"available"});
    assert.equal(summarize(record,data,0,now).state,"partial");
    assert.equal(record.status,"working");
});


test("missing, malformed, future and empty observations remain unknown", () => {
    for (const data of [null, {connected:true,checkedAt:now,entities:{}}, {connected:true,checkedAt:now,entities:[null]},
        {connected:true,checkedAt:now+60000,entities:[]}, snapshot([])]) {
        assert.equal(summarize(device,data,0,now).state,"unknown");
    }
    const missing = buildSnapshot([{device_id:"one",entity_id:"sensor.missing"}],[],now);
    assert.equal(summarize(device,missing,0,now).unknown,1);
});


test("fully disabled devices are not monitored, even with stale or unavailable entities", () => {
    const disabled = { ...device, haDisabledState: "disabled", status: "working" };
    for (const data of [null, snapshot([]), snapshot(["unavailable"]), { ...snapshot(["unavailable"]), checkedAt: 1 }]) {
        const info = summarize(disabled, data, 0, now);
        assert.equal(info.state, "not-monitored");
        assert.equal(info.actionable, false);
        assert.equal(info.affected.length, 0);
    }
    assert.equal(disabled.status, "working");
    assert.equal(summarize({ ...disabled, homeAssistant: false }, null, 0, now).state, "unknown");
});

test("partially disabled records still monitor enabled entities; re-enabling resumes monitoring", () => {
    assert.equal(summarize({...device,haDisabledState:"mixed"},snapshot(["unavailable"]),0,now).actionable,true);
    assert.equal(summarize({...device,haDisabledState:"enabled"},snapshot(["on"]),0,now).state,"available");
    assert.equal(summarize({...device,haDisabledState:"mixed"},snapshot([]),0,now).state,"unknown");
});


test("event-only Matter devices use current HA state rather than last event age", () => {
    const registry = [
        {device_id:"one",entity_id:"event.button_one"},
        {device_id:"one",entity_id:"event.button_two"},
        {device_id:"one",entity_id:"event.disabled",disabled_by:"user"},
        {device_id:"one",entity_id:"button.identify"}
    ];
    const oldTimestamp = new Date(now - 4 * 86400000).toISOString();
    const data = buildSnapshot(registry, registry.map(entity => ({
        entity_id:entity.entity_id, state:oldTimestamp, last_changed:oldTimestamp
    })), now);
    const info = summarize(device, data, 120, now);
    assert.equal(info.state, "available");
    assert.equal(info.available, 2);
    assert.equal(info.total, 2);
    assert.equal(JSON.stringify(data).includes(oldTimestamp), false);
    assert.equal(summarize(device, data, 120, now + 121000).state, "unknown");
});

test("event entities preserve unavailable, unknown and missing states", () => {
    const registry = [{device_id:"one",entity_id:"event.button"}];
    for (const state of ["unavailable", "unknown", undefined]) {
        const states = state === undefined ? [] : [{entity_id:"event.button",state,
            last_changed:new Date(now - 180000).toISOString()}];
        const info = summarize(device, buildSnapshot(registry, states, now), 120, now);
        assert.equal(info.state, state === "unavailable" ? "unavailable" : "unknown");
        assert.equal(info.total, 1);
        assert.equal(info.actionable, state === "unavailable");
    }
    const mixed = buildSnapshot([...registry, {device_id:"one",entity_id:"sensor.temperature"}], [
        {entity_id:"event.button",state:new Date(now - 86400000).toISOString()},
        {entity_id:"sensor.temperature",state:"unavailable",last_changed:new Date(now - 180000).toISOString()}
    ], now);
    assert.equal(summarize(device, mixed, 120, now).state, "partial");
});
