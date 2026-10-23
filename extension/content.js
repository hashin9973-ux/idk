(() => {
  "use strict";
  const TICK = String.fromCharCode(96);
  const DOUBLE_TICK = TICK.repeat(3);
  const knownBlocks = new WeakSet();
  let activeCard = null;
  let styleInstalled = false;

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function installStyle() {
    if (styleInstalled) return;
    styleInstalled = true;
    const style = document.createElement("style");
    style.dataset.redbridgeUi = "1";
    style.textContent = [
      ".redbridge-launch{margin:6px 0;padding:6px 10px;border:1px solid #888;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:12px}",
      ".redbridge-card{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:min(620px,calc(100vw - 36px));max-height:78vh;overflow:auto;background:var(--main-surface-primary,#fff);color:var(--text-primary,#111);border:1px solid var(--border-medium,#888);border-radius:12px;box-shadow:0 8px 36px #0005;padding:14px;font:14px/1.45 system-ui,sans-serif}",
      ".redbridge-header,.redbridge-actions{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap}",
      ".redbridge-card button{padding:7px 10px;border:1px solid #888;border-radius:7px;background:transparent;color:inherit;cursor:pointer}",
      ".redbridge-card button:disabled{opacity:.55;cursor:wait}",
      ".redbridge-preview,.redbridge-status{white-space:pre-wrap;overflow-wrap:anywhere;max-height:32vh;overflow:auto;padding:10px;background:var(--bg-tertiary,#eee);border-radius:8px;font:12px/1.5 ui-monospace,monospace}",
      ".redbridge-card p{font-size:13px}",
      ".redbridge-run{font-weight:650}",
      ".redbridge-status[hidden]{display:none}"
    ].join("\n");
    (document.head || document.documentElement).append(style);
  }

  function getAssistantPreBlocks() {
    return Array.from(document.querySelectorAll('[data-message-author-role="assistant"] pre'))
      .filter((node) => node.isConnected && !node.closest("[data-redbridge-ui]"));
  }

  function taskSource(pre) {
    const code = pre.querySelector("code");
    const codeText = (code?.innerText || pre.innerText || "").trim();
    const className = (code?.className || "");
    if (className.includes("language-redbridge")) return codeText;
    // Fallback if a site version exposes the literal fence in a preformatted block.
    const start = codeText.indexOf(DOUBLE_TICK + "redbridge");
    if (start >= 0) {
      const bodyStart = codeText.indexOf("\n", start);
      const end = codeText.indexOf(DOUBLE_TICK, bodyStart + 1);
      if (bodyStart >= 0 && end > bodyStart) return codeText.slice(bodyStart + 1, end).trim();
    }
    return null;
  }

  function addTaskButtons() {
    for (const pre of getAssistantPreBlocks()) {
      if (knownBlocks.has(pre)) continue;
      const source = taskSource(pre);
      if (!source) continue;
      knownBlocks.add(pre);
      const button = el("button", "Review task for Windows", "redbridge-launch");
      button.type = "button";
      button.addEventListener("click", () => openReview(source));
      pre.insertAdjacentElement("afterend", button);
    }
  }

  function closeCard() {
    if (activeCard) activeCard.remove();
    activeCard = null;
  }

  function openReview(raw) {
    installStyle();
    closeCard();
    const card = el("section", undefined, "redbridge-card");
    card.dataset.redbridgeUi = "1";
    const header = el("div", undefined, "redbridge-header");
    header.append(el("strong", "ChatGPT Windows Bridge"), el("button", "Close"));
    header.lastChild.addEventListener("click", closeCard);
    const note = el("p", "Review the exact request before running it. This grants the local companion access to the configured workspace for the selected operation.");
    const preview = el("pre", raw, "redbridge-preview");
    const status = el("pre", "", "redbridge-status");
    status.hidden = true;
    const actions = el("div", undefined, "redbridge-actions");
    const run = el("button", "Execute on Windows", "redbridge-run");
    const cancel = el("button", "Cancel");
    actions.append(run, cancel);
    cancel.addEventListener("click", closeCard);
    run.addEventListener("click", async () => {
      let task;
      try {
        task = JSON.parse(raw);
        validateTask(task);
      } catch (error) {
        status.hidden = false;
        status.textContent = "Task rejected: " + (error.message || "invalid task");
        return;
      }
      if (task.op !== "health") {
        const approved = window.confirm("Approve local operation?\n\n" + describeTask(task) + "\n\nProceed only if you trust the requested operation and have reviewed every field.");
        if (!approved) return;
      }
      run.disabled = true;
      run.textContent = "Running…";
      status.hidden = false;
      status.textContent = "Contacting the local Windows companion…";
      try {
        const reply = await chrome.runtime.sendMessage({
          type: "REDBRIDGE_EXECUTE",
          taskJson: JSON.stringify(task),
          approved: task.op !== "health"
        });
        if (!reply?.ok) throw new Error(reply?.error || "No result from extension.");
        const report = JSON.stringify(reply.result, null, 2);
        status.textContent = report;
        actions.querySelector(".redbridge-insert")?.remove();
        const insert = el("button", "Insert result into ChatGPT", "redbridge-insert");
        insert.addEventListener("click", () => {
          const resultText = "Windows execution result reported by the local companion:\n" +
            DOUBLE_TICK + "json\n" + report + "\n" + DOUBLE_TICK;
          if (!insertIntoComposer(resultText)) {
            status.textContent += "\n\nCould not locate the ChatGPT composer. Copy the result above and paste it into the conversation.";
          }
        });
        actions.append(insert);
      } catch (error) {
        status.textContent = "Bridge error: " + (error.message || String(error)) +
          "\n\nNo successful execution is claimed. Check extension service worker and Native Messaging setup.";
      } finally {
        run.disabled = false;
        run.textContent = "Execute on Windows";
      }
    });
    card.append(header, note, preview, actions, status);
    document.body.append(card);
    activeCard = card;
  }

  function validateTask(task) {
    if (!task || typeof task !== "object" || Array.isArray(task)) throw new Error("Expected a JSON object.");
    if (task.version !== 1) throw new Error("version must be 1.");
    const schemas = {
      health: ["version", "id", "op"],
      list_files: ["version", "id", "op", "path"],
      read_file: ["version", "id", "op", "path"],
      write_file: ["version", "id", "op", "path", "content"],
      write_files: ["version", "id", "op", "files"],
      run_pytest: ["version", "id", "op", "test_path"],
      run_process: ["version", "id", "op", "executable", "args", "cwd", "timeout_seconds"]
    };
    const allowed = schemas[task.op];
    if (!allowed) throw new Error("Unsupported operation.");
    for (const key of Object.keys(task)) {
      if (!allowed.includes(key)) throw new Error("Unknown field: " + key);
    }
    for (const key of ["path", "test_path"]) {
      if (key in task && (typeof task[key] !== "string" || task[key].length > 1024)) {
        throw new Error(key + " must be a short relative path.");
      }
    }
    if (task.op === "write_file" &&
        (typeof task.content !== "string" || new TextEncoder().encode(task.content).length > 262144)) {
      throw new Error("content must be UTF-8 text up to 256 KiB.");
    }
    if (task.op === "write_files") {
      if (!Array.isArray(task.files) || task.files.length < 1 || task.files.length > 20) {
        throw new Error("files must be an array of 1 to 20 file entries.");
      }
      const seen = new Set();
      let totalBytes = 0;
      for (const file of task.files) {
        if (!file || typeof file !== "object" || Array.isArray(file) ||
            Object.keys(file).some((key) => !["path", "content"].includes(key)) ||
            typeof file.path !== "string" || !file.path.trim() || file.path.length > 1024 ||
            typeof file.content !== "string") {
          throw new Error("Each file entry must contain only a relative path and string content.");
        }
        if (file.path.startsWith("/") || file.path.startsWith("\\\\") ||
            file.path.split(/[\\\\/]+/).includes("..") || /^[A-Za-z]:/.test(file.path)) {
          throw new Error("Batch file paths must be relative and stay inside the workspace.");
        }
        if (seen.has(file.path.toLowerCase())) throw new Error("Duplicate path in batch: " + file.path);
        seen.add(file.path.toLowerCase());
        const size = new TextEncoder().encode(file.content).length;
        if (size > 262144) throw new Error("Each file is limited to 256 KiB: " + file.path);
        totalBytes += size;
        if (totalBytes > 524288) throw new Error("Combined batch contents exceed 512 KiB.");
      }
    }
    if (task.op === "run_process") {
      if (typeof task.executable !== "string" || !task.executable.trim() || task.executable.length > 2048) {
        throw new Error("executable must be a program name or path.");
      }
      const args = task.args ?? [];
      if (!Array.isArray(args) || args.length > 128 || args.some((arg) => typeof arg !== "string" || arg.length > 8192)) {
        throw new Error("args must be an array of at most 128 strings, each at most 8192 characters.");
      }
      const total = task.executable.length + args.reduce((sum, arg) => sum + arg.length, 0);
      if (total > 65536) throw new Error("combined executable and arguments are too large.");
      if (task.timeout_seconds !== undefined &&
          (!Number.isInteger(task.timeout_seconds) || task.timeout_seconds < 1 || task.timeout_seconds > 120)) {
        throw new Error("timeout_seconds must be an integer between 1 and 120.");
      }
    }
  }

  function describeTask(task) {
    switch (task.op) {
      case "list_files": return "List directory: " + (task.path || ".");
      case "read_file": return "Read file: " + task.path;
      case "write_file": return "Write/overwrite file: " + task.path + " (" + new TextEncoder().encode(task.content).length + " bytes)";
      case "write_files":
        return "Write " + task.files.length + " files as one reviewed batch:\\n" +
          task.files.map((file) => "- " + file.path + " (" + new TextEncoder().encode(file.content).length + " bytes)").join("\\n") +
          "\\nThe companion stages all files first and attempts rollback if a replacement fails.";
      case "run_pytest": return "Run Python pytest in configured workspace: " + (task.test_path || ".");
      case "run_process":
        return "Launch program: " + task.executable + "\nArguments: " + JSON.stringify(task.args || []) +
          "\nWorking directory: " + (task.cwd || ".") + "\nTimeout: " + (task.timeout_seconds || 120) + " seconds" +
          "\nNote: inspect every argument; a shell executable can interpret its arguments as commands.";
      default: return "Operation: " + task.op;
    }
  }

  function insertIntoComposer(text) {
    const editor = document.querySelector("#prompt-textarea") ||
      document.querySelector('[contenteditable="true"][data-testid*="prompt"]') ||
      document.querySelector("textarea");
    if (!editor) return false;
    editor.focus();
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const start = editor.selectionStart ?? editor.value.length;
      const end = editor.selectionEnd ?? editor.value.length;
      const value = editor.value.slice(0, start) + text + editor.value.slice(end);
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")?.set;
      if (setter) setter.call(editor, value); else editor.value = value;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.setSelectionRange(start + text.length, start + text.length);
      return true;
    }
    if (editor.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const inserted = document.execCommand("insertText", false, text);
      if (!inserted) {
        range.insertNode(document.createTextNode(text));
      }
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return true;
    }
    return false;
  }

  const observer = new MutationObserver(() => addTaskButtons());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  addTaskButtons();
})();