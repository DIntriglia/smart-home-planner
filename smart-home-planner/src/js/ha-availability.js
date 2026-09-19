// Shared pure availability model. Never stores entity values or changes inventory.
(() => {
    const STALE_MS = 120000;
    function buildSnapshot(registry, states, now = Date.now()) {
        const byId = new Map(states.map(entity => [entity.entity_id, entity]));
        const entities = registry.filter(entity => entity.device_id && !entity.disabled_by &&
            !["button", "input_button", "scene", "event"].includes(String(entity.entity_id).split(".")[0]))
            .map(entity => {
                const current = byId.get(entity.entity_id);
                const value = current?.state;
                const state = value === "unavailable" ? "unavailable"
                    : !current || typeof value !== "string" || value === "unknown" || value === "" ? "unknown" : "available";
                const changed = Date.parse(current?.last_changed);
                return {
                    deviceId: entity.device_id,
                    entityId: entity.entity_id,
                    name: String(entity.name || entity.original_name || entity.entity_id),
                    state,
                    unavailableSince: state === "unavailable" ? (Number.isFinite(changed) && changed <= now ? changed : now) : null
                };
            });
        return { connected: true, checkedAt: now, entities };
    }
    function summarize(device, snapshot, graceSeconds = 120, now = Date.now()) {
        const empty = { state: "unknown", total: 0, available: 0, unavailable: 0, unknown: 0, affected: [], actionable: false };
        const linked = device?.homeAssistant === true || ["true", "1", "yes"].includes(String(device?.homeAssistant).toLowerCase());
        if (linked && device.haDisabledState === "disabled") {
            return { ...empty, state: "not-monitored" };
        }
        if (!linked || !snapshot?.connected || !Number.isFinite(snapshot.checkedAt) ||
            now - snapshot.checkedAt > STALE_MS || snapshot.checkedAt > now + 5000) return empty;
        const ids = new Set(Array.isArray(device.haDeviceIds) && device.haDeviceIds.length ? device.haDeviceIds
            : Array.isArray(device.homeAssistantDeviceIds) && device.homeAssistantDeviceIds.length ? device.homeAssistantDeviceIds : [device.id]);
        const entities = (Array.isArray(snapshot.entities) ? snapshot.entities : []).filter(entity => entity && ids.has(entity.deviceId));
        const available = entities.filter(entity => entity.state === "available").length;
        const affected = entities.filter(entity => entity.state === "unavailable");
        const unavailable = affected.length;
        const unknown = entities.length - available - unavailable;
        const state = !entities.length ? "unknown" : unavailable === entities.length ? "unavailable"
            : unavailable && available ? "partial" : available === entities.length ? "available" : "unknown";
        const grace = Math.max(0, Math.min(3600, Number.isFinite(Number(graceSeconds)) ? Number(graceSeconds) : 120)) * 1000;
        return { state, total: entities.length, available, unavailable, unknown, affected,
            actionable: ["partial", "unavailable"].includes(state) && affected.some(entity =>
                Number.isFinite(entity.unavailableSince) && now - entity.unavailableSince >= grace) };
    }
    globalThis.HaAvailability = { buildSnapshot, summarize, STALE_MS };
})();
