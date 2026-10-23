# ChatGPT Windows Bridge

A prototype extension and Windows companion for an existing ChatGPT conversation. ChatGPT proposes a constrained task; the user reviews and approves it; the local host performs it and returns the actual result for the conversation to inspect.

## Current MVP

- Chrome / Edge Manifest V3 extension that detects a redbridge code block in an assistant response.
- Native Messaging host implemented in Python.
- Operations: health, list_files, read_file, write_file, run_pytest.
- Workspace-root path validation, strict request fields, file and message size limits, bounded listing/output, test timeout.
- Local task execution results can be inserted into the ChatGPT composer; the user submits them manually.
- A GitHub Actions workflow is included for Linux and Windows validation.

This is deliberately a first vertical slice, not yet an unrestricted machine controller. It does not run arbitrary shell commands and it does not automatically submit follow-up messages.

## Quick start

1. Read docs/architecture.md and windows/README.md.
2. Load the extension directory as an unpacked extension in Chrome or Edge.
3. Copy the extension ID shown by the browser.
4. Register the host from PowerShell:

   ```powershell
   .\windows\install.ps1 -ExtensionId "YOUR_EXTENSION_ID" -Browser Chrome -WorkspaceRoot "$HOME\ChatGPTWorkspace"
   ```

5. Reload the extension and refresh ChatGPT.
6. Ask ChatGPT to emit a code block with the language redbridge and a JSON task inside. Start with:

   ```redbridge
   {"version":1,"op":"health"}
   ```

7. Click Review task for Windows, inspect the payload, then execute. For workspace operations, explicitly approve the confirmation dialog.
8. To let ChatGPT reason from the actual result, click Insert result into ChatGPT, review the inserted report, and submit it yourself.

## Supported requests

List files in the configured workspace:

```redbridge
{"version":1,"op":"list_files","path":"."}
```

Read a small UTF-8 file:

```redbridge
{"version":1,"op":"read_file","path":"README.md"}
```

Write a file after review:

```redbridge
{"version":1,"op":"write_file","path":"bridge-smoke.txt","content":"Created by an approved bridge test."}
```

Run pytest in a disposable workspace:

```redbridge
{"version":1,"op":"run_pytest","test_path":"tests"}
```

See docs/protocol.md for exact limits and response semantics.

## Repository roles

- App development: https://github.com/hashin9973-ux/idk
- Test/final environment: https://github.com/hashin9973-ux/qdqwg

The qdqwg repository is public test material, not a live task queue. Do not put secrets or private execution output in it.

## Security notes

This is an early prototype. Use a disposable workspace first. Reads and writes are constrained to the locally configured workspace; file reads/writes and tests require a visible click/confirmation. Tests execute code from the selected workspace. Never place secrets in task blocks or share sensitive workspace contents in chat. Native host permissions are granted to the exact extension ID registered at install time.

The result reports the local operation status and actual test exit code. A successful commit is not proof that the Windows-side action ran.
