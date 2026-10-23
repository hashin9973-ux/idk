const HOST_NAME = "com.chatgpt.windowsbridge";
const ALLOWED_CHAT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

function senderIsAllowed(sender) {
  try {
    const url = new URL(sender?.url || sender?.tab?.url || "");
    if (url.protocol === "https:" && ALLOWED_CHAT_HOSTS.has(url.hostname)) return true;
    // The extension's own popup can run non-destructive diagnostics. Content-script
    // senders have the ChatGPT page URL and must pass the origin allowlist above.
    return url.protocol === "chrome-extension:" &&
      url.hostname === chrome.runtime.id &&
      url.pathname === "/popup.html";
  } catch { return false; }
}

function nativeRequest(payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    try { port = chrome.runtime.connectNative(HOST_NAME); }
    catch { reject(new Error("Could not start native host. Check installer and extension ID.")); return; }
    timer = setTimeout(() => finish(new Error("Native host response timed out.")), 130000);
    port.onMessage.addListener((message) => finish(null, message));
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) finish(new Error("Native host disconnected. Check manifest, Python path, and extension ID."));
      else if (!settled) finish(new Error("Native host disconnected without a result."));
    });
    try { port.postMessage(payload); }
    catch { finish(new Error("Could not send request to native host.")); }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!senderIsAllowed(sender)) {
    sendResponse({ ok: false, error: "Requests are accepted only from the ChatGPT site." });
    return false;
  }
  if (!message || message.type !== "REDBRIDGE_EXECUTE" || typeof message.taskJson !== "string") {
    sendResponse({ ok: false, error: "Invalid extension message." });
    return false;
  }
  if (message.taskJson.length > 1000000) {
    sendResponse({ ok: false, error: "Task is too large." });
    return false;
  }
  let task;
  try { task = JSON.parse(message.taskJson); }
  catch { sendResponse({ ok: false, error: "Task is not valid JSON." }); return false; }
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    sendResponse({ ok: false, error: "Task must be a JSON object." }); return false;
  }
  if (task.op !== "health") {
    if (message.approved !== true) { sendResponse({ ok: false, error: "Explicit approval required." }); return false; }
    task.approved = true;
  }
  nativeRequest(task)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});