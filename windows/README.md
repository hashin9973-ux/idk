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

Click the extension's toolbar icon and choose **Test local connection**. A successful check confirms that the browser can start the registered host and receive a valid health response. If it fails, inspect the diagnostic message before continuing.

Then reload the extension, refresh ChatGPT, and ask ChatGPT to emit the following format:

    {"version":1,"op":"health"}

Place it in a fenced code block marked redbridge. Click Review task, then Execute on Windows. Health is non-destructive and does not require an approval flag.

Next, try {"version":1,"op":"list_files","path":"."}. Workspace file operations, test execution, and process launches require an explicit confirmation dialog. After a result arrives, use Insert result into ChatGPT, then submit it manually. The toolbar popup has an optional Auto-submit execution reports to ChatGPT setting; it submits only if the composer is empty and does not approve follow-up Windows tasks.

## Supported operations

- health
- list_files
- read_file
- write_file
- write_files (reviewed batch of up to 20 files)
- run_pytest
- run_process (explicitly approved executable with an argument array)

Example: {"version":1,"op":"write_files","files":[{"path":"src/one.py","content":"# first"},{"path":"src/two.py","content":"# second"}]}

Batch writes stage content and backup copies before replacing targets. Rollback is attempted on a replacement error but multi-file changes are not a filesystem-atomic transaction.

Example: {"version":1,"op":"run_process","executable":"git","args":["status","--short"],"cwd":".","timeout_seconds":30}

The bridge never concatenates model-generated command text or sets shell=True. However, an approved process may be a shell/interpreter that executes its arguments as code. It runs with the current Windows user's permissions and can access files outside the configured workspace; only its working directory is constrained. Inspect every argument and use a disposable workspace.

## Troubleshooting

- Confirm the extension ID matches the host manifest's allowed_origins.
- Confirm the registry key exists under HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chatgpt.windowsbridge or the corresponding Edge key.
- The manifest path must point to the actual Python executable, and its first argument must be the copied companion.py.
- Inspect chrome://extensions for service worker errors and the browser console for content-script errors.
- Native host stdout is reserved for the binary Native Messaging protocol. Diagnostic messages must go to stderr.
- If tests are run, the selected workspace may execute project code. Use a disposable test workspace first. The pytest operation requires pytest installed in the Python interpreter selected by the installer; the companion does not install packages automatically.

This is an early prototype; do not expose the native host to untrusted extensions or use it for sensitive workspaces.
