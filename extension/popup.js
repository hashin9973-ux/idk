const byId = (id) => document.getElementById(id);
const attachButton = byId("attach");
const collapseButton = byId("collapse");
const detachButton = byId("detach");
const tabTitle = byId("tab-title");
const tabUrl = byId("tab-url");
const tabState = byId("tab-state");
const companionState = byId("companion-state");
const rawResult = byId("raw-result");

let activeTab = null;
let attached = false;
let expanded = true;
const supportedHosts = new Set(["chatgpt.com", "chat.openai.com"]);

function setBusy(busy) {
  attachButton.disabled = busy || !activeTab || !isChatGPTTab(activeTab);
  collapseButton.disabled = busy || !attached;
  detachButton.disabled = busy || !attached;
}

function isChatGPTTab(tab) {
  try {
    const url = new URL(tab?.url || "");
    return url.protocol === "https:" && supportedHosts.has(url.hostname);
  } catch { return false; }
}

function displayTab(tab) {
  activeTab = tab || null;
  if (!activeTab) {
    tabTitle.textContent = "No active tab";
    tabUrl.textContent = "Select a ChatGPT tab and reopen this popup.";
  } else {
    tabTitle.textContent = activeTab.title || "Current tab";
    tabUrl.textContent = activeTab.url || "";
  }
  if (!isChatGPTTab(activeTab)) {
    tabState.textContent = "Open ChatGPT, then click the extension.";
    attached = false;
  }
  setBusy(false);
}

async function sendTabMessage(message) {
  if (!activeTab?.id || !isChatGPTTab(activeTab)) throw new Error("Open a ChatGPT tab before using the overlay.");
  return await chrome.tabs.sendMessage(activeTab.id, message);
}

async function refreshState() {
  if (!activeTab?.id || !isChatGPTTab(activeTab)) return;
  try {
    const state = await sendTabMessage({ type: "OVERLAY_GET_STATE" });
    attached = state?.attached === true;
    expanded = state?.expanded !== false;
    tabState.textContent = !attached ? "Not attached" :
      (expanded ? "Attached · overlay open" : "Attached · collapsed to ball");
  } catch {
    attached = false;
    tabState.textContent = "Could not reach content script. Reload the ChatGPT tab, then try again.";
  }
  setBusy(false);
}

async function openOrAttach() {
  setBusy(true);
  tabState.textContent = "Attaching overlay…";
  try {
    const response = await sendTabMessage({ type: "OVERLAY_ATTACH" });
    if (!response?.ok) throw new Error(response?.error || "Overlay could not attach.");
    attached = true;
    expanded = true;
    tabState.textContent = "Attached · overlay open";
  } catch (error) {
    tabState.textContent = error?.message || String(error);
  } finally {
    setBusy(false);
  }
}

async function collapseOverlay() {
  setBusy(true);
  try {
    const response = await sendTabMessage({ type: "OVERLAY_COLLAPSE" });
    attached = response?.attached === true;
    expanded = false;
    tabState.textContent = attached ? "Attached · collapsed to ball" : "Not attached";
  } catch (error) {
    tabState.textContent = error?.message || String(error);
  } finally {
    setBusy(false);
  }
}

async function detachOverlay() {
  setBusy(true);
  try {
    const response = await sendTabMessage({ type: "OVERLAY_DETACH" });
    attached = response?.attached === true;
    expanded = false;
    tabState.textContent = "Detached from this tab";
  } catch (error) {
    tabState.textContent = error?.message || String(error);
  } finally {
    setBusy(false);
  }
}

attachButton.addEventListener("click", openOrAttach);
collapseButton.addEventListener("click", collapseOverlay);
detachButton.addEventListener("click", detachOverlay);

byId("test-connection").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  companionState.textContent = "Testing local companion…";
  rawResult.hidden = true;
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
    companionState.textContent = "Connected · protocol v" + (data.protocol_version || response.result.version || "?") +
      " · " + (data.operations?.length || 0) + " local operations";
    rawResult.textContent = JSON.stringify(response.result, null, 2);
    rawResult.hidden = false;
  } catch (error) {
    companionState.textContent = "Not connected · " + (error?.message || String(error));
  } finally {
    button.disabled = false;
  }
});

(async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    displayTab(tabs[0]);
    if (isChatGPTTab(activeTab)) await refreshState();
  } catch (error) {
    tabState.textContent = "Cannot inspect the active tab. Check extension permissions.";
    setBusy(false);
  }
})();
