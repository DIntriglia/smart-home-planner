// Shared pure availability model. Never stores entity values or changes inventory.
(() => {
    const STALE_MS = 120000;
    function buildSnapshot(registry, states, now = Date.now()) {
        const registryByDevice = new Map();
        for (const entity of registry) {
            if (!entity.device_id) continue;
            const entries = registryByDevice.get(entity.device_id) || [];
            entries.push(entity);
            registryByDevice.set(entity.device_id, entries);
        }
        const allEntitiesDisabledDeviceIds = [...registryByDevice]
            .filter(([, entries]) => entries.every(entity => Boolean(entity.disabled_by)))
            .map(([id]) => id);
        const byId = new Map(states.map(entity => [entity.entity_id, entity]));
        const entities = registry.filter(entity => entity.device_id && !entity.disabled_by &&
            !["button", "input_button", "scene"].includes(String(entity.entity_id).split(".")[0]))
            .map(entity => {
                const current = byId.get(entity.entity_id);
                const value = current?.state;
                // Ring chimes expose a sound action without an on/off state; cameras do report state.
                const stateless = entity.platform === "ring" && String(entity.entity_id).startsWith("siren.")
                    && String(entity.unique_id || "").endsWith("-siren") && value === "unknown";
                const state = stateless ? "stateless" : value === "unavailable" ? "unavailable"
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
        return { connected: true, checkedAt: now, entities, allEntitiesDisabledDeviceIds };
    }
    function summarize(device, snapshot, graceSeconds = 120, now = Date.now()) {
        const empty = { state: "unknown", total: 0, available: 0, unavailable: 0, unknown: 0, affected: [], unknownEntities: [], warnings: [], actionable: false };
        const linked = device?.homeAssistant === true || ["true", "1", "yes"].includes(String(device?.homeAssistant).toLowerCase());
        if (linked && device.haDisabledState === "disabled") {
            return { ...empty, state: "not-monitored", reason: "device-disabled" };
        }
        if (!linked || !snapshot?.connected || !Number.isFinite(snapshot.checkedAt) ||
            now - snapshot.checkedAt > STALE_MS || snapshot.checkedAt > now + 5000) return empty;
        const ids = new Set(Array.isArray(device.haDeviceIds) && device.haDeviceIds.length ? device.haDeviceIds
            : Array.isArray(device.homeAssistantDeviceIds) && device.homeAssistantDeviceIds.length ? device.homeAssistantDeviceIds : [device.id]);
        const allDisabledIds = new Set(Array.isArray(snapshot.allEntitiesDisabledDeviceIds)
            ? snapshot.allEntitiesDisabledDeviceIds : []);
        if (ids.size && [...ids].every(id => allDisabledIds.has(id))) {
            return { ...empty, state: "not-monitored", reason: "entities-disabled" };
        }
        const linkedEntities = (Array.isArray(snapshot.entities) ? snapshot.entities : []).filter(entity => entity && ids.has(entity.deviceId));
        const warnings = linkedEntities.filter(entity => entity.state === "stateless");
        const entities = linkedEntities.filter(entity => entity.state !== "stateless");
        const unknownEntities = entities.filter(entity => !["available", "unavailable"].includes(entity.state));
        const available = entities.filter(entity => entity.state === "available").length;
        const affected = entities.filter(entity => entity.state === "unavailable");
        const unavailable = affected.length;
        const unknown = entities.length - available - unavailable;
        const state = !entities.length ? (warnings.length ? "available" : "unknown") : unavailable === entities.length ? "unavailable"
            : unavailable && available ? "partial" : available === entities.length ? "available" : "unknown";
        const grace = Math.max(0, Math.min(3600, Number.isFinite(Number(graceSeconds)) ? Number(graceSeconds) : 120)) * 1000;
        return { state, total: entities.length, available, unavailable, unknown, affected, unknownEntities, warnings,
            actionable: ["partial", "unavailable"].includes(state) && affected.some(entity =>
                Number.isFinite(entity.unavailableSince) && now - entity.unavailableSince >= grace) };
    }
    function diagnosticSummary(info, now = Date.now()) {
        if (info.state === "not-monitored") return "Not monitored";
        if (!info.total) return "Unknown — no current entity data";
        const allUnavailable = info.unavailable === info.total;
        const status = allUnavailable ? "All monitored entities unavailable"
            : info.unavailable ? "Some entities unavailable" : info.unknown ? "Some entity states unknown" : "Available";
        const counts = [[info.available, "available"], [info.unavailable, "unavailable"], [info.unknown, "unknown"]]
            .filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
        let text = [status, ...counts].join(" · ");
        const times = info.affected.map(entity => entity.unavailableSince);
        if (times.length && times.every(time => Number.isFinite(time) && time <= now)) {
            // An all-entity outage starts when the last entity becomes unavailable.
            const since = allUnavailable ? Math.max(...times) : Math.min(...times);
            const minutes = Math.floor((now - since) / 60000);
            const duration = minutes < 1 ? "less than a minute" : minutes < 60
                ? `${minutes} minute${minutes === 1 ? "" : "s"}` : minutes < 1440
                ? `${Math.floor(minutes / 60)} hour${Math.floor(minutes / 60) === 1 ? "" : "s"}`
                : `${Math.floor(minutes / 1440)} day${Math.floor(minutes / 1440) === 1 ? "" : "s"}`;
            text += allUnavailable ? ` · All unavailable for ${duration}` : ` · Longest entity outage: ${duration}`;
        }
        return text;
    }
    globalThis.HaAvailability = { buildSnapshot, summarize, diagnosticSummary, STALE_MS };
})();
