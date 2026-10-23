# Browser extension (Manifest V3)

Load this folder unpacked in Chrome or Edge, then register the native host using windows/install.ps1.

The content script detects a redbridge code fence in an assistant message. The user explicitly reviews and executes it. Supported examples:

    {"version":1,"op":"health"}

    {"version":1,"op":"list_files","path":"."}

    {"version":1,"op":"read_file","path":"README.md"}

    {"version":1,"op":"write_file","path":"notes.txt","content":"A test note"}

    {"version":1,"op":"run_pytest","test_path":"tests"}

    {"version":1,"op":"run_process","executable":"git","args":["status","--short"],"cwd":".","timeout_seconds":30}

Put one request in a fenced code block marked redbridge. After an operation, Insert result into ChatGPT inserts the structured report into the composer. The user must review and submit it manually.

run_process launches an explicitly approved executable with a list of arguments, without shell-string concatenation. A shell interpreter can still execute commands if you pass those arguments, so review them carefully.

This first integration intentionally avoids auto-clicking Send. ChatGPT's page DOM is not a stable API and can change. If task detection stops working, inspect selectors in content.js.
