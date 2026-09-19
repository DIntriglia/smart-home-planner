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
