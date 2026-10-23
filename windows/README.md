# Windows companion setup (prototype)

Requirements: Windows 10/11, Python 3.10+ available as python.exe, and Chrome or Edge.

## 1. Load extension

1. Open chrome://extensions (Chrome) or edge://extensions (Edge).
2. Enable Developer mode.
3. Choose Load unpacked and select this repository's extension directory.
4. Copy the extension ID shown by the browser.

## 2. Register native host

Open PowerShell in the repository folder. For Chrome:

    Set-ExecutionPolicy -Scope Process Bypass
    .\windows\install.ps1 -ExtensionId "YOUR_EXTENSION_ID" -Browser Chrome -WorkspaceRoot "$HOME\ChatGPTWorkspace"

For Edge, use -Browser Edge. Replace the placeholder with the actual extension ID shown by the browser.

The installer copies companion.py under LocalAppData, creates the workspace directory if needed, writes a native host manifest, and registers it under the current user's registry hive. It does not require Administrator rights. Inspect the script before running it.

## 3. Test the connection

Reload the extension, refresh ChatGPT, and ask ChatGPT to emit the following format:

    {"version":1,"op":"health"}

Place it in a fenced code block marked redbridge. Click Review task, then Execute on Windows. Health is non-destructive and does not require an approval flag.

Next, try {"version":1,"op":"list_files","path":"."}. Workspace file operations, test execution, and process launches require an explicit confirmation dialog. After a result arrives, use Insert result into ChatGPT, then manually submit it to the conversation.

## Supported operations

- health
- list_files
- read_file
- write_file
- run_pytest
- run_process (explicitly approved executable with an argument array)

Example: {"version":1,"op":"run_process","executable":"git","args":["status","--short"],"cwd":".","timeout_seconds":30}

The bridge never concatenates model-generated command text or sets shell=True. However, an approved process may be a shell/interpreter that executes its arguments as code. Inspect every argument and use a disposable workspace.

## Troubleshooting

- Confirm the extension ID matches the host manifest's allowed_origins.
- Confirm the registry key exists under HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chatgpt.windowsbridge or the corresponding Edge key.
- The manifest path must point to the actual Python executable, and its first argument must be the copied companion.py.
- Inspect chrome://extensions for service worker errors and the browser console for content-script errors.
- Native host stdout is reserved for the binary Native Messaging protocol. Diagnostic messages must go to stderr.
- If tests are run, the selected workspace may execute project code. Use a disposable test workspace first.

This is an early prototype; do not expose the native host to untrusted extensions or use it for sensitive workspaces.
