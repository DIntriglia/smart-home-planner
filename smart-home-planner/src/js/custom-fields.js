// Stable field IDs keep device values intact when labels change or fields are archived.
function getCustomFieldDefinitions(settings) {
    const fields = settings?.customFieldDefinitions;
    return Array.isArray(fields) ? fields.filter(field => field && typeof field.id === "string" && typeof field.label === "string") : [];
}

let customFieldValues = {};
function renderDeviceCustomFields(settings, values) {
    const container = document.getElementById("device-custom-fields");
    if (!container) return;
    customFieldValues = Object.fromEntries(Object.entries(values || {}).filter(([, value]) => typeof value === "string"));
    container.replaceChildren();
    for (const field of getCustomFieldDefinitions(settings)) {
        if (field.archived && !customFieldValues[field.id]) continue;
        const group = document.createElement("div");
        group.className = "form-group";
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.id = `custom-field-${field.id}`;
        label.htmlFor = input.id;
        label.textContent = field.label + (field.archived ? " (archived)" : "");
        input.type = "text";
        input.value = customFieldValues[field.id] || "";
        input.readOnly = Boolean(field.archived);
        input.addEventListener("input", () => { customFieldValues[field.id] = input.value; });
        group.append(label, input);
        container.append(group);
    }
    if (!container.childElementCount) {
        const hint = document.createElement("p");
        hint.textContent = "Add custom text fields in Settings → Device Options.";
        container.append(hint);
    }
}

function readDeviceCustomFields() {
    return { ...customFieldValues };
}

async function changeCustomFieldDefinition(id, label, archived) {
    const name = String(label || "").trim();
    if (!name || name.length > 80) throw new Error("Enter a field name of 1–80 characters.");
    await enqueueStorageWrite(async () => {
        const response = await fetch(buildAppUrl("api/storage"), { cache: "no-store" });
        if (!response.ok) throw new Error("Unable to load current settings.");
        const snapshot = await response.json();
        const fields = getCustomFieldDefinitions(snapshot.settings).map(field => ({ ...field }));
        if (fields.some(field => field.id !== id && field.label.toLowerCase() === name.toLowerCase())) {
            throw new Error("A custom field with that name already exists.");
        }
        if (id) {
            const field = fields.find(field => field.id === id);
            if (!field) throw new Error("This field has changed. Reload Settings and try again.");
            field.label = name;
            field.archived = Boolean(archived);
        } else {
            fields.push({ id: `field-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`, label: name, archived: false });
        }
        snapshot.settings = { ...snapshot.settings, customFieldDefinitions: fields };
        storageEtag = parseStorageEtag(response);
        await putStoragePayload(snapshot);
        storageCache = mergeStorage(snapshot);
        settings = normalizeSettings(snapshot.settings);
    });
}

function initializeCustomFieldSettings() {
    const container = document.getElementById("custom-field-definitions");
    const message = document.getElementById("custom-field-message");
    if (!container) return;
    async function save(id, name, archived) {
        document.querySelectorAll("#custom-field-definitions button, #custom-field-add").forEach(button => { button.disabled = true; });
        try {
            await changeCustomFieldDefinition(id, name, archived);
            message.textContent = "Custom fields saved.";
            document.getElementById("custom-field-name").value = "";
            render();
        } catch (error) {
            message.textContent = error.message || "Unable to save custom fields.";
        } finally {
            document.querySelectorAll("#custom-field-definitions button, #custom-field-add").forEach(button => { button.disabled = false; });
        }
    }
    function render() {
        container.replaceChildren();
        for (const field of getCustomFieldDefinitions(settings)) {
            const row = document.createElement("div");
            row.className = "form-group custom-field-definition";
            const input = document.createElement("input");
            input.type = "text";
            input.maxLength = 80;
            input.value = field.label;
            input.setAttribute("aria-label", `Field name: ${field.label}`);
            const rename = document.createElement("button");
            rename.type = "button";
            rename.className = "btn btn-secondary";
            rename.textContent = "Rename";
            rename.addEventListener("click", () => save(field.id, input.value, field.archived));
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "btn btn-secondary";
            toggle.textContent = field.archived ? "Restore field" : "Archive field";
            toggle.addEventListener("click", () => save(field.id, input.value, !field.archived));
            row.append(input, rename, toggle);
            container.append(row);
        }
    }
    document.getElementById("custom-field-add").addEventListener("click", () => save(null, document.getElementById("custom-field-name").value, false));
    render();
}
