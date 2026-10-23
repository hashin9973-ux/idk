const button = document.getElementById("test-connection");
const state = document.getElementById("state");
const details = document.getElementById("details");
const raw = document.getElementById("raw-result");

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
