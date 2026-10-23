# Browser extension (Manifest V3)

Load this folder unpacked in Chrome or Edge, then register the native host using windows/install.ps1. The extension toolbar popup has a **Test local connection** button for a non-destructive Native Messaging health check. It reports the host's advertised protocol version and supported operations.

The content script detects a redbridge code fence in an assistant message. The user explicitly reviews and executes it. Supported examples:

    {"version":1,"op":"health"}

    {"version":1,"op":"list_files","path":"."}

    {"version":1,"op":"read_file","path":"README.md"}

    {"version":1,"op":"write_file","path":"notes.txt","content":"A test note"}

    {"version":1,"op":"write_files","files":[{"path":"a.txt","content":"one"},{"path":"b.txt","content":"two"}]}

    {"version":1,"op":"run_pytest","test_path":"tests"}

    {"version":1,"op":"run_process","executable":"git","args":["status","--short"],"cwd":".","timeout_seconds":30}

Put one request in a fenced code block marked redbridge. After an operation, Insert result into ChatGPT inserts the structured report into the composer. By default, the user reviews and submits it manually. In the toolbar popup, the optional Auto-submit execution reports to ChatGPT setting submits a returned report automatically only when the composer is empty. It never approves the next Windows task.

write_files applies a reviewed batch of up to 20 files (512 KiB combined content maximum); the companion stages files first and attempts rollback if a replacement fails. A batch is not a filesystem-atomic transaction.

run_process launches an explicitly approved executable with a list of arguments, without shell-string concatenation. A shell interpreter can still execute commands if you pass those arguments. It runs with the current Windows user's permissions and may access files outside the workspace, so review the command, every argument, and any path carefully.

Automatic Send clicks are opt-in and default off. When enabled, the extension submits only a returned execution report and only if the composer is empty; the next task still requires a separate user approval. This behavior depends on ChatGPT's page DOM and send-button selectors, which can change. If task detection or submission stops working, inspect selectors in content.js and switch the setting off.
