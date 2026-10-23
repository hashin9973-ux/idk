const button = document.getElementById("test-connection");
const state = document.getElementById("state");
const details = document.getElementById("details");
const raw = document.getElementById("raw-result");

const autoSubmit = document.getElementById("auto-submit-results");
const settingStatus = document.getElementById("setting-status");

chrome.storage.local.get({ autoSubmitResults: false }, (settings) => {
  if (chrome.runtime.lastError) {
    settingStatus.textContent = "Could not load saved setting.";
    return;
  }
  autoSubmit.checked = settings.autoSubmitResults === true;
});

autoSubmit.addEventListener("change", () => {
  const value = autoSubmit.checked;
  chrome.storage.local.set({ autoSubmitResults: value }, () => {
    if (chrome.runtime.lastError) {
      settingStatus.textContent = "Could not save setting. Check extension permissions.";
      autoSubmit.checked = !value;
      return;
    }
    settingStatus.textContent = value
      ? "Enabled. Only returned reports auto-submit; next Windows tasks still require approval."
      : "Disabled. Results remain manual.";
  });
});

button.addEventListener("click", async () => {
  button.disabled = true;
  state.textContent = "Testing…";
  details.textContent = "Contacting the registered Native Messaging host.";
  raw.hidden = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "REDBRIDGE_EXECUTE",
      taskJson: JSON.stringify({ version: 1, op: "health" }),
      approved: false
    });
    if (!response?.ok || !response.result?.ok) {
      throw new Error(response?.error || response?.result?.error || "The local host returned an unsuccessful response.");
    }
    const data = response.result.data || {};
    state.textContent = "Connected";
    details.textContent = "Host: " + (data.host || "unknown") +
      " · protocol v" + (data.protocol_version || response.result.version || "?") +
      " · " + (data.operations?.length || 0) + " operations advertised";
    raw.textContent = JSON.stringify(response.result, null, 2);
    raw.hidden = false;
  } catch (error) {
    state.textContent = "Not connected";
    details.textContent = (error?.message || String(error)) +
      " Check the installer, Python path, selected browser, and extension ID.";
  } finally {
    button.disabled = false;
  }
});
