// Integration preferences and inventory are committed in one ETag-protected write.
let haIntegrationDomains = [];
let haIntegrationsBusy = false;
let haIntegrationsLoaded = false;

function setHaIntegrationsBusy(busy) {
    haIntegrationsBusy = busy;
    document.querySelectorAll('input[name="ha-area-sync-target"]').forEach(input => { input.disabled = busy; });
    document.querySelectorAll("#ha-integrations-section button, #ha-integrations-list input")
        .forEach(element => { element.disabled = busy || (!haIntegrationsLoaded && element.id !== "ha-integrations-retry"); });
}

async function initializeHaIntegrations() {
    document.getElementById("ha-integrations-search").addEventListener("input", renderHaIntegrations);
    document.getElementById("ha-integrations-retry").addEventListener("click", loadHaIntegrations);
    document.getElementById("ha-integrations-select").addEventListener("click", () => changeHaIntegrations([], true, true));
    document.getElementById("ha-integrations-deselect").addEventListener("click", () => changeHaIntegrations(haIntegrationDomains, false, true));
    await loadHaIntegrations();
}

async function loadHaIntegrations() {
    if (haIntegrationsBusy) return;
    setHaIntegrationsBusy(true);
    try {
        const response = await fetch(buildAppUrl("api/ha/integrations"), { cache: "no-store" });
        if (!response.ok) throw new Error("Integration metadata is unavailable. Refresh after Home Assistant connects.");
        const entries = await response.json();
        if (!Array.isArray(entries)) throw new Error("Invalid integration metadata.");
        haIntegrationDomains = HaSyncModel.normalizeDomains([
            ...entries.map(entry => entry.domain), ...HaSyncModel.normalizeDomains(settings.haExcludedIntegrations)
        ]);
        haIntegrationsLoaded = true;
        renderHaIntegrations();
    } catch (error) {
        haIntegrationsLoaded = false;
        document.getElementById("ha-integrations-status").textContent = error.message;
    } finally {
        setHaIntegrationsBusy(false);
    }
}

function renderHaIntegrations() {
    const exclusions = HaSyncModel.normalizeDomains(settings.haExcludedIntegrations);
    const search = document.getElementById("ha-integrations-search").value.trim().toLowerCase();
    const domains = haIntegrationDomains.filter(domain => domain.includes(search));
    const list = document.getElementById("ha-integrations-list");
    list.replaceChildren();
    for (const domain of domains) {
        const label = document.createElement("label");
        label.className = "ha-integration-option";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.className = "ui-switch";
        input.checked = !exclusions.includes(domain);
        input.disabled = haIntegrationsBusy;
        input.addEventListener("change", () => changeHaIntegrations([domain], input.checked));
        label.append(input, document.createTextNode(domain));
        list.append(label);
    }
    document.getElementById("ha-integrations-status").textContent = haIntegrationDomains.length
        ? `${haIntegrationDomains.length - exclusions.length} of ${haIntegrationDomains.length} integrations selected.${domains.length ? "" : " No matches."}`
        : "No Home Assistant integrations found.";
}

async function changeHaIntegrations(domains, checked, bulk = false) {
    if (haIntegrationsBusy || !haIntegrationsLoaded) return;
    // Bulk actions apply to the entire list, including saved but absent domains.
    const selectAll = bulk && checked;
    const deselectAll = bulk && !checked;
    setHaIntegrationsBusy(true);
    let saved = false;
    try {
        await enqueueStorageWrite(async () => {
            const [response, devicesResponse] = await Promise.all([
                fetch(STORAGE_API_URL, { cache: "no-store" }),
                fetch(buildAppUrl("api/ha/devices"), { cache: "no-store" })
            ]);
            if (!response.ok || !devicesResponse.ok) throw new Error("Unable to load current inventory. Nothing was changed.");
            const current = await response.json();
            const devices = await devicesResponse.json();
            const etag = response.headers.get("ETag");
            if (!etag || !Array.isArray(devices)) throw new Error("Inventory metadata is incomplete. Nothing was changed.");
            const exclusions = new Set(HaSyncModel.normalizeDomains(current.settings?.haExcludedIntegrations));
            if (selectAll) exclusions.clear();
            else if (deselectAll) haIntegrationDomains.forEach(domain => exclusions.add(domain));
            else domains.forEach(domain => checked ? exclusions.delete(domain) : exclusions.add(domain));
            const next = { ...current, settings: { ...current.settings, haExcludedIntegrations: [...exclusions].sort() } };
            const result = HaSyncModel.buildStorageDevicesUpdate(next, devices);
            if (result.removedDevices.length) {
                const confirmed = await showConfirm(
                    `Remove ${result.removedDevices.length} device(s) from inventory? Their notes, attachments, and connections will be deleted. Rechecking imports fresh records. Home Assistant devices are unchanged.`,
                    { title: "Exclude integrations", confirmText: "Remove devices" }
                );
                if (!confirmed) return;
            }
            // Capture the matching snapshot only after the confirmation; PUT rejects
            // any intervening worker or browser write rather than overwriting it.
            storageEtag = etag;
            await putStoragePayload(result.nextStorage, { allowEmpty: result.removedDevices.length > 0 });
            storageCache = mergeStorage(result.nextStorage);
            settings = normalizeSettings(result.nextStorage.settings);
            saved = true;
            const failures = await HaSyncModel.cleanupRemovedFiles(result.removedDevices, result.nextStorage.devices, buildAppUrl("api/device-files"));
            showMessage(failures.length
                ? `Integrations saved, but ${failures.length} attachment(s) could not be deleted.`
                : "Integrations saved and inventory updated.", failures.length ? "error" : "success");
        });
    } catch (error) {
        showMessage(error.message || "Unable to save integrations.", "error");
        settings = await loadSettings();
    } finally {
        setHaIntegrationsBusy(false);
        renderHaIntegrations();
        if (saved) await renderExcludedDevicesManagement();
    }
}
