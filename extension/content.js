(() => {
  "use strict";

  const ROOT_ID = "__chatgpt_overlay_companion_root";
  const CHAT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
  let root = null;
  let shadow = null;
  let panel = null;
  let transcript = null;
  let composer = null;
  let sendButton = null;
  let statusLine = null;
  let bubble = null;
  let unreadBadge = null;
  let observer = null;
  let syncTimer = null;
  let attached = false;
  let expanded = true;
  let sending = false;
  let routeKey = location.href;
  let lastSignature = "";
  let lastMessageKeys = new Set();
  let unreadCount = 0;
  let lastSendTime = 0;

  const $ = (selector) => shadow?.querySelector(selector) || null;

  function onChatGPT() {
    return location.protocol === "https:" && CHAT_HOSTS.has(location.hostname);
  }

  function makeElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function installStyles() {
    const style = makeElement("style");
    style.textContent = [
      ":host{all:initial;color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
      "*{box-sizing:border-box}",
      ".orb{position:fixed;right:22px;bottom:22px;z-index:2147483647;width:58px;height:58px;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#171717;color:#fff;box-shadow:0 8px 26px #0004;cursor:pointer;font-size:17px;font-weight:750;letter-spacing:-.04em}",
      ".orb:hover{transform:translateY(-1px)}",
      ".orb-mark{width:34px;height:34px;border:1.5px solid #b8f2d0;border-radius:50%;display:flex;align-items:center;justify-content:center}",
      ".unread{position:absolute;top:-3px;right:-3px;min-width:19px;height:19px;border-radius:10px;background:#ef4444;color:#fff;border:2px solid #fff;font:700 10px/15px system-ui;text-align:center;padding:0 4px}",
      ".window{position:fixed;right:18px;bottom:18px;z-index:2147483646;width:min(420px,calc(100vw - 28px));height:min(690px,calc(100vh - 36px));min-height:310px;display:flex;flex-direction:column;overflow:hidden;border:1px solid #d7d7d7;border-radius:18px;background:#fff;color:#171717;box-shadow:0 18px 64px #0003}",
      ".topbar{display:flex;align-items:center;gap:10px;padding:12px 13px;border-bottom:1px solid #ececec;background:#fff;flex:none}",
      ".brand-icon{width:32px;height:32px;flex:none;border-radius:11px;background:#171717;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800}",
      ".heading{flex:1;min-width:0}",
      ".title{font-size:13px;font-weight:750;line-height:1.2;letter-spacing:-.015em}",
      ".subtitle{font-size:11px;color:#777;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".head-actions{display:flex;gap:4px}",
      ".icon-btn{width:31px;height:31px;border:0;border-radius:9px;background:transparent;color:#555;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center}",
      ".icon-btn:hover{background:#f0f0f0;color:#111}",
      ".conversation{flex:1;min-height:0;overflow:auto;padding:14px 12px 18px;background:#fafafa;scroll-behavior:smooth}",
      ".empty{margin:22px 8px;padding:16px;border:1px dashed #d6d6d6;border-radius:13px;color:#737373;font-size:12px;line-height:1.55;background:#fff}",
      ".empty strong{display:block;color:#333;font-size:13px;margin-bottom:5px}",
      ".message{margin:0 0 13px;display:flex;flex-direction:column;gap:5px;min-width:0}",
      ".message.user{align-items:flex-end}",
      ".role{font-size:10px;color:#888;padding:0 4px;letter-spacing:.035em}",
      ".bubble{max-width:96%;width:fit-content;max-height:none;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;padding:10px 11px;border-radius:13px;font-size:12px;line-height:1.58;background:#fff;border:1px solid #e8e8e8;color:#242424}",
      ".user .bubble{background:#e8f4eb;border-color:#d4e9dc;color:#172a1d;border-bottom-right-radius:5px}",
      ".assistant .bubble{border-bottom-left-radius:5px}",
      ".bubble.streaming:after{content:' ';display:inline-block;width:5px;height:5px;margin-left:3px;border-radius:50%;background:#888;vertical-align:middle;animation:blink 1s ease-in-out infinite}",
      "@keyframes blink{50%{opacity:.2}}",
      ".bottom-status{flex:none;padding:5px 12px 0;color:#777;font-size:10px;background:#fff;min-height:20px}",
      ".composer-wrap{flex:none;background:#fff;padding:8px 10px 10px}",
      ".composer-box{border:1px solid #dedede;border-radius:14px;background:#fff;padding:9px 9px 7px;box-shadow:0 2px 7px #00000008}",
      ".composer{display:block;width:100%;min-height:48px;max-height:150px;resize:vertical;border:0;outline:none;background:transparent;color:#161616;font:12px/1.5 inherit;font-family:inherit;font-size:12px;line-height:1.5;padding:0 1px}",
      ".composer::placeholder{color:#999}",
      ".composer-controls{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px}",
      ".hint{font-size:10px;color:#999}",
      ".send{border:0;border-radius:9px;padding:8px 13px;background:#171717;color:#fff;font-size:11px;font-weight:700;cursor:pointer}",
      ".send:hover{background:#303030}",
      ".send:disabled{opacity:.45;cursor:wait}",
      ".detach{font-size:11px;color:#888;border:0;background:transparent;cursor:pointer;padding:6px 7px;border-radius:7px}",
      ".detach:hover{background:#f2f2f2;color:#333}",
      ".hidden{display:none!important}",
      "@media(prefers-color-scheme:dark){.window{background:#1f1f1f;color:#f3f3f3;border-color:#444}.topbar,.bottom-status,.composer-wrap{background:#1f1f1f;border-color:#3c3c3c}.topbar{border-bottom-color:#3c3c3c}.conversation{background:#171717}.empty{background:#202020;border-color:#444;color:#aaa}.empty strong{color:#eee}.bubble{background:#252525;border-color:#393939;color:#eee}.user .bubble{background:#203c2b;border-color:#2d513a;color:#e6f5ea}.composer-box{background:#202020;border-color:#444}.composer{color:#eee}.icon-btn{color:#bbb}.icon-btn:hover{background:#333;color:#fff}.detach:hover{background:#333;color:#fff}.send{background:#eee;color:#111}.send:hover{background:#ddd}.orb{background:#f2f2f2;color:#111}.orb-mark{border-color:#227c4c}}",
      "@media(max-width:480px){.window{right:8px;bottom:8px;width:calc(100vw - 16px);height:calc(100vh - 16px);border-radius:16px}.orb{right:14px;bottom:14px}}"
    ].join("\n");
    shadow.appendChild(style);
  }

  function createUI() {
    if (root || !document.documentElement) return;
    root = makeElement("div");
    root.id = ROOT_ID;
    root.style.all = "initial";
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = "2147483646";
    root.style.pointerEvents = "none";
    document.documentElement.appendChild(root);
    shadow = root.attachShadow({ mode: "open" });
    installStyles();

    bubble = makeElement("button", "orb");
    bubble.type = "button";
    bubble.title = "Open ChatGPT overlay";
    bubble.setAttribute("aria-label", "Open ChatGPT overlay");
    const orbMark = makeElement("span", "orb-mark", "C");
    unreadBadge = makeElement("span", "unread", "");
    unreadBadge.classList.add("hidden");
    bubble.append(orbMark, unreadBadge);
    bubble.addEventListener("click", expand);
    shadow.appendChild(bubble);

    panel = makeElement("section", "window");
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", "ChatGPT conversation overlay");

    const topbar = makeElement("header", "topbar");
    topbar.appendChild(makeElement("div", "brand-icon", "C"));
    const heading = makeElement("div", "heading");
    heading.append(
      makeElement("div", "title", "ChatGPT Overlay"),
      makeElement("div", "subtitle", "Attached to this ChatGPT tab")
    );
    const headActions = makeElement("div", "head-actions");
    const collapseButton = makeElement("button", "icon-btn", "−");
    collapseButton.type = "button";
    collapseButton.title = "Collapse to floating ball";
    collapseButton.setAttribute("aria-label", "Collapse overlay");
    collapseButton.addEventListener("click", collapse);
    const detachButton = makeElement("button", "icon-btn", "×");
    detachButton.type = "button";
    detachButton.title = "Detach overlay from this tab";
    detachButton.setAttribute("aria-label", "Detach overlay");
    detachButton.addEventListener("click", detach);
    headActions.append(collapseButton, detachButton);
    topbar.append(heading, headActions);

    transcript = makeElement("div", "conversation");
    transcript.setAttribute("aria-live", "polite");
    transcript.setAttribute("aria-label", "Mirrored ChatGPT conversation");

    const empty = makeElement("div", "empty");
    empty.dataset.emptyState = "1";
    empty.append(
      makeElement("strong", "", "This overlay mirrors your current ChatGPT conversation."),
      document.createTextNode("Messages from this tab appear here. Type below to send a message through ChatGPT.")
    );

    const statusWrap = makeElement("div", "bottom-status");
    statusLine = makeElement("span", "", "Ready · messages sync from this tab");
    statusWrap.appendChild(statusLine);

    const composerWrap = makeElement("div", "composer-wrap");
    const composerBox = makeElement("div", "composer-box");
    composer = makeElement("textarea", "composer");
    composer.setAttribute("aria-label", "Send a message to ChatGPT");
    composer.setAttribute("placeholder", "Message ChatGPT…");
    composer.setAttribute("rows", "3");
    const controls = makeElement("div", "composer-controls");
    controls.appendChild(makeElement("span", "hint", "Enter to send · Shift+Enter for a new line"));
    sendButton = makeElement("button", "send", "Send");
    sendButton.type = "button";
    sendButton.addEventListener("click", sendMessage);
    controls.appendChild(sendButton);
    composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
      }
    });
    composerBox.append(composer, controls);
    const footerControls = makeElement("div");
    footerControls.style.cssText = "display:flex;justify-content:flex-end;padding-top:3px";
    const detachLink = makeElement("button", "detach", "Detach from tab");
    detachLink.type = "button";
    detachLink.addEventListener("click", detach);
    footerControls.appendChild(detachLink);
    composerWrap.append(composerBox, footerControls);
    panel.append(topbar, transcript, statusWrap, composerWrap);
    shadow.appendChild(panel);
    root.style.pointerEvents = "none";
    // Interactive surfaces opt in; the rest of the overlay does not block the page.
    bubble.style.pointerEvents = "auto";
    panel.style.pointerEvents = "auto";
    expanded = true;
    updateVisibility();
  }

  function removeUI() {
    if (root) root.remove();
    root = null;
    shadow = null;
    panel = null;
    transcript = null;
    composer = null;
    sendButton = null;
    statusLine = null;
    bubble = null;
    unreadBadge = null;
    lastSignature = "";
    lastMessageKeys = new Set();
    unreadCount = 0;
  }

  function updateVisibility() {
    if (!root) return;
    if (panel) panel.classList.toggle("hidden", !expanded);
    if (bubble) bubble.classList.toggle("hidden", expanded);
    if (unreadBadge) {
      unreadBadge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
      unreadBadge.classList.toggle("hidden", unreadCount === 0 || expanded);
    }
  }

  function updateStatus(text) {
    if (statusLine) statusLine.textContent = text;
  }

  function expand() {
    if (!attached || !root) return;
    expanded = true;
    unreadCount = 0;
    updateVisibility();
    renderTranscript(readSourceMessages(), true);
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
    if (composer) composer.focus();
  }

  function collapse() {
    expanded = false;
    updateVisibility();
  }

  function attach() {
    if (!onChatGPT()) return { ok: false, error: "Open a ChatGPT tab before attaching the overlay." };
    if (!root) createUI();
    attached = true;
    expanded = true;
    unreadCount = 0;
    if (!observer) {
      observer = new MutationObserver(() => scheduleSync());
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-message-author-role", "data-message-id", "class"]
      });
      window.addEventListener("popstate", scheduleSync);
      window.addEventListener("hashchange", scheduleSync);
    }
    updateVisibility();
    renderTranscript(readSourceMessages(), true);
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
    updateStatus("Attached · live sync enabled");
    return { ok: true, attached: true, expanded, messageCount: transcript ? transcript.querySelectorAll(".message").length : 0 };
  }

  function detach() {
    attached = false;
    if (observer) observer.disconnect();
    observer = null;
    window.removeEventListener("popstate", scheduleSync);
    window.removeEventListener("hashchange", scheduleSync);
    if (syncTimer) window.clearTimeout(syncTimer);
    syncTimer = null;
    removeUI();
    return { ok: true, attached: false };
  }

  function currentState() {
    return {
      ok: true,
      attached,
      expanded,
      supportedTab: onChatGPT(),
      messageCount: transcript ? transcript.querySelectorAll(".message").length : 0
    };
  }

  function scheduleSync() {
    if (!attached || syncTimer) return;
    syncTimer = window.setTimeout(() => {
      syncTimer = null;
      syncConversation();
    }, 140);
  }

  function readMessageText(node) {
    const candidates = [
      "[data-message-content]",
      ".markdown",
      ".whitespace-pre-wrap",
      '[class*="message-content"]'
    ];
    for (const selector of candidates) {
      const match = node.matches(selector) ? node : node.querySelector(selector);
      if (match && (match.innerText || match.textContent || "").trim()) {
        return (match.innerText || match.textContent || "").replace(/\u00a0/g, " ").trim();
      }
    }
    return (node.innerText || node.textContent || "").replace(/\u00a0/g, " ").trim();
  }

  function readSourceMessages() {
    const selectors = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
    const nodes = Array.from(document.querySelectorAll(selectors))
      .filter((node) => !node.closest("#" + ROOT_ID) && node.isConnected);
    const messages = [];
    nodes.forEach((node, index) => {
      const role = node.getAttribute("data-message-author-role");
      const text = readMessageText(node);
      if (!text) return;
      const parent = node.closest('[data-testid^="conversation-turn-"]');
      const nativeId = node.getAttribute("data-message-id") ||
        (parent && parent.getAttribute("data-testid")) || "";
      const key = role + ":" + (nativeId || "index-" + index);
      messages.push({ key, role, text });
    });
    return messages;
  }

  function syncConversation() {
    if (!attached) return;
    if (location.href !== routeKey) {
      routeKey = location.href;
      lastSignature = "";
      lastMessageKeys = new Set();
      unreadCount = 0;
    }
    const messages = readSourceMessages();
    renderTranscript(messages, false);
  }

  function renderTranscript(messages, force) {
    if (!transcript) return;
    const signature = JSON.stringify(messages);
    if (!force && signature === lastSignature) return;
    const routeChanged = routeKey !== location.href;
    if (routeChanged) {
      routeKey = location.href;
      lastMessageKeys = new Set();
    }
    const wasNearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 70;
    const currentKeys = new Set(messages.map((message) => message.key));
    let appendedAssistant = 0;
    if (!force && expanded === false && !routeChanged) {
      for (const message of messages) {
        if (message.role === "assistant" && !lastMessageKeys.has(message.key)) appendedAssistant += 1;
      }
    }
    unreadCount = Math.min(99, unreadCount + appendedAssistant);
    const existing = new Map(
      Array.from(transcript.querySelectorAll(".message")).map((node) => [node.dataset.messageKey, node])
    );
    for (const message of messages) {
      let item = existing.get(message.key);
      if (item) existing.delete(message.key);
      else {
        item = makeElement("article", "message " + message.role);
        item.dataset.messageKey = message.key;
        item.appendChild(makeElement("div", "role", message.role === "user" ? "YOU" : "CHATGPT"));
        item.appendChild(makeElement("div", "bubble"));
      }
      const bubbleNode = item.querySelector(".bubble");
      if (bubbleNode.textContent !== message.text) bubbleNode.textContent = message.text;
      bubbleNode.classList.toggle("streaming", message.role === "assistant" && isAssistantStreaming(message));
      transcript.appendChild(item);
    }
    for (const node of existing.values()) node.remove();
    const empty = transcript.querySelector("[data-empty-state]");
    if (messages.length === 0) {
      if (!empty) {
        const emptyNode = makeElement("div", "empty");
        emptyNode.dataset.emptyState = "1";
        emptyNode.append(
          makeElement("strong", "", "This overlay mirrors your current ChatGPT conversation."),
          document.createTextNode("Messages from this tab appear here. Type below to send a message through ChatGPT.")
        );
        transcript.appendChild(emptyNode);
      }
    } else if (empty) {
      empty.remove();
    }
    lastSignature = signature;
    lastMessageKeys = currentKeys;
    updateVisibility();
    if (force || wasNearBottom) transcript.scrollTop = transcript.scrollHeight;
  }

  function isAssistantStreaming(message) {
    if (message.role !== "assistant") return false;
    const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop generating"]');
    return Boolean(stop && !stop.disabled);
  }

  function getChatGPTComposer() {
    const selectors = [
      "#prompt-textarea",
      'textarea[data-testid*="prompt"]',
      '[contenteditable="true"][data-testid*="prompt"]',
      'div[contenteditable="true"]#prompt-textarea',
      "form textarea",
      'form [contenteditable="true"]'
    ];
    for (const selector of selectors) {
      const candidate = document.querySelector(selector);
      if (candidate && !candidate.closest("#" + ROOT_ID) && candidate.isConnected) return candidate;
    }
    return null;
  }

  function getComposerText(editor) {
    if (!editor) return "";
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) return editor.value || "";
    return editor.innerText || editor.textContent || "";
  }

  function setComposerText(editor, text) {
    editor.focus();
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(editor, text);
      else editor.value = text;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (!editor.isContentEditable) return false;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch (_) {}
    if (!inserted) {
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
    }
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return true;
  }

  function getSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]'
    ];
    for (const selector of selectors) {
      const candidate = document.querySelector(selector);
      if (candidate && !candidate.closest("#" + ROOT_ID) && candidate.isConnected) return candidate;
    }
    return null;
  }

  async function waitForSendButton() {
    for (let i = 0; i < 12; i += 1) {
      const button = getSendButton();
      if (button && !button.disabled) return button;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return null;
  }

  async function sendMessage() {
    if (!attached || sending || !composer || !sendButton) return;
    const text = composer.value.trim();
    if (!text) {
      composer.focus();
      return;
    }
    const now = Date.now();
    if (now - lastSendTime < 500) return;
    const chatEditor = getChatGPTComposer();
    if (!chatEditor) {
      updateStatus("Could not find ChatGPT's composer. The overlay message has not been sent.");
      return;
    }
    if (getComposerText(chatEditor).trim()) {
      updateStatus("ChatGPT already has an unsent draft. Send or clear that draft first; nothing was overwritten.");
      return;
    }
    sending = true;
    lastSendTime = now;
    sendButton.disabled = true;
    sendButton.textContent = "Sending…";
    updateStatus("Sending through ChatGPT…");
    try {
      const inserted = setComposerText(chatEditor, text);
      if (!inserted) throw new Error("ChatGPT's composer could not accept text.");
      const nativeSend = await waitForSendButton();
      if (!nativeSend) {
        updateStatus("Text was placed in ChatGPT's composer, but its Send button was not found. Review and send it there manually.");
        return;
      }
      nativeSend.click();
      composer.value = "";
      composer.style.height = "";
      updateStatus("Sent to ChatGPT · waiting for the response");
      scheduleSync();
    } catch (error) {
      updateStatus("Could not send: " + (error?.message || String(error)));
    } finally {
      sending = false;
      sendButton.disabled = false;
      sendButton.textContent = "Send";
      composer.focus();
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;
    if (message.type === "OVERLAY_GET_STATE") {
      sendResponse(currentState());
      return false;
    }
    if (message.type === "OVERLAY_ATTACH" || message.type === "OVERLAY_SHOW") {
      const result = attach();
      sendResponse(result);
      return false;
    }
    if (message.type === "OVERLAY_COLLAPSE") {
      collapse();
      sendResponse(currentState());
      return false;
    }
    if (message.type === "OVERLAY_DETACH") {
      sendResponse(detach());
      return false;
    }
    return false;
  });

  // Content scripts exist on supported pages, but do not display the overlay until
  // the user explicitly attaches it from the toolbar popup.
})();