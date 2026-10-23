# ChatGPT Windows Bridge

A prototype extension and Windows companion for an existing ChatGPT conversation. ChatGPT proposes a constrained task; the user reviews and approves it; the local host performs it and returns the actual result for the conversation to inspect.

## Current MVP

- Chrome / Edge Manifest V3 extension that detects a redbridge code block in an assistant response.
- Native Messaging host implemented in Python.
- Operations: health, list_files, read_file, write_file, write_files, run_pytest, and run_process.
- Workspace-root path validation, strict request fields, file and message size limits, bounded listing/output, test timeout.
- Local task execution results can be inserted into the ChatGPT composer and submitted manually. An opt-in popup setting can auto-submit a result when the composer is empty; it never approves the next Windows task.
- A GitHub Actions workflow is included for Linux and Windows validation.

This is deliberately a first vertical slice, not yet an unrestricted machine controller. It does not concatenate command strings or run processes with shell=True, but the approved run_process operation can launch shell/interpreter programs when explicitly requested. Such a process runs with the current Windows user's permissions and is not sandboxed to the workspace; only its working directory is constrained. Carefully review every executable and argument. It does not automatically approve follow-up tasks.

## Quick start

1. Read docs/architecture.md and windows/README.md.
2. Load the extension directory as an unpacked extension in Chrome or Edge.
3. Copy the extension ID shown by the browser.
4. Register the host from PowerShell:

   ```powershell
   .\windows\install.ps1 -ExtensionId "YOUR_EXTENSION_ID" -Browser Chrome -WorkspaceRoot "$HOME\ChatGPTWorkspace"
   ```

5. Reload the extension and refresh ChatGPT. Use the extension toolbar popup's **Test local connection** button to verify the Native Messaging host before attempting workspace tasks.
6. For a harmless end-to-end smoke test, clone [qdqwg](https://github.com/hashin9973-ux/qdqwg) and set WorkspaceRoot to its fixtures/workspace folder (details in windows/README.md). For a reliable workflow in a conversation, paste the prompt from [docs/chatgpt-prompt.md](docs/chatgpt-prompt.md). Then ask ChatGPT to emit a code block with the language redbridge and a JSON task inside. Start with:

   ```redbridge
   {"version":1,"op":"health"}
   ```

7. Click Review task for Windows, inspect the payload, then execute. For workspace operations, explicitly approve the confirmation dialog.
8. To let ChatGPT reason from the actual result, click Insert result into ChatGPT and submit it manually. Alternatively, enable Auto-submit execution reports in the extension popup; it sends only the returned report when the composer is empty, and every follow-up Windows operation still requires your approval.

## Supported requests

List files in the configured workspace:

```redbridge
{"version":1,"op":"list_files","path":"."}
```

Read a small UTF-8 file:

```redbridge
{"version":1,"op":"read_file","path":"README.md"}
```

Write one file after review:

```redbridge
{"version":1,"op":"write_file","path":"bridge-smoke.txt","content":"Created by an approved bridge test."}
```

Write multiple files in one reviewed batch (up to 20 paths; total content up to 512 KiB):

```redbridge
{"version":1,"op":"write_files","files":[{"path":"src/one.txt","content":"first"},{"path":"src/two.txt","content":"second"}]}
```

The parent directories must already exist. The companion stages each file first and attempts rollback if replacing one fails; a multi-file update is not a filesystem-atomic transaction.

Run pytest in a disposable workspace:

```redbridge
{"version":1,"op":"run_pytest","test_path":"tests"}
```

Run a reviewed process with argument-array semantics:

```redbridge
{"version":1,"op":"run_process","executable":"git","args":["status","--short"],"cwd":".","timeout_seconds":30}
```

See docs/protocol.md for exact limits and response semantics.

## Repository roles

- App development: https://github.com/hashin9973-ux/idk
- Test/final environment: https://github.com/hashin9973-ux/qdqwg

The qdqwg repository is public test material, not a live task queue. Do not put secrets or private execution output in it.

## Security notes

This is an early prototype. Use a disposable workspace first. File reads and writes are constrained to the locally configured workspace; workspace reads/writes, batch writes, tests, and process launches require a visible click/confirmation. A process launched through run_process can access other paths with the current Windows user's permissions, depending on the executable and arguments. Tests execute code from the selected workspace. Never place secrets in task blocks or share sensitive workspace contents in chat. Native host permissions are granted to the exact extension ID registered at install time.

The result reports the local operation status and actual test exit code. A successful commit is not proof that the Windows-side action ran.
