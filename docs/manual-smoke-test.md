# Manual Windows Smoke Test

Use this checklist after downloading the Windows installer from the latest successful [working-branch CI build](https://github.com/hashin9973-ux/idk/actions/workflows/validate.yml). The Actions run's **Artifacts** section contains the `Windows-Repository-Bridge-...` ZIP; extract it to get the installer.

This is a manual test because GitHub Actions cannot prove the app can connect to the user's actual Windows machine or that the ChatGPT GitHub integration can read the same mailbox.

## Before starting

- Use a **private** copy of `hashin9973-ux/qdqwg` and the dedicated `bridge-mailbox` branch.
- Ensure the configured workspace contains only harmless test files. On first launch this is `Documents/ChatGPTWorkspace`; an existing `workspaceRoot` setting is preserved. Use a disposable project folder for the first run. Test whole-drive selection separately and verify that it shows an explicit warning and indexes only the drive root.
- No custom GitHub OAuth App or client ID should be needed. If GitHub is not connected, click the **GitHub not connected** status row; the bundled GitHub CLI opens the official device-authorization page in your default browser. Complete the device flow.
- Keep secrets, tokens, credentials, private keys, and confidential source material out of the workspace files you intend to upload.

## 1. Start and verify environment publication

1. Launch the Windows Repository Bridge and wait for the full dashboard to appear. Confirm there is no separate compact overlay window.
2. If needed, click **GitHub not connected** and complete the official GitHub CLI device flow in your browser. Do not register a separate OAuth App or enter a client ID.
3. Verify **Worker online** appears after authorization and internet connectivity are available; no Start Worker action should be required. If offline, verify the app continues retrying and updates status after connectivity returns.
4. In GitHub, open `bridge/context/latest.json` on the `bridge-mailbox` branch.
5. Confirm the index points to the environment, project, capabilities, directory tree, and instruction inventory snapshots.
6. Inspect the snapshots. Confirm instruction contents are not included in the initial inventory and obvious local user/home/temp paths are redacted.
7. Minimize or close the dashboard to the tray. Verify its window disappears, the tray icon remains, and the worker keeps polling. Reopen it from the tray and verify the last selected tab and widget layout return. Confirm an embedded page can reload after the dashboard was unloaded.

Expected outcome: the worker reports running, the mailbox has a heartbeat, and the context index and snapshot files are committed to the private branch.

## 2. Test a read-only request through the existing ChatGPT conversation

In the same ChatGPT conversation that has access to the GitHub integration, create a new file on `bridge-mailbox` at `bridge/requests/req-smoke-project-status-001.json`. If you have run this test before, replace the example ID with a fresh unique ID in both the filename and `request_id`:

```json
{
  "protocol": "chatgpt-local-repo-bridge/v1",
  "request_id": "req-smoke-project-status-001",
  "created_at": "2026-10-24T00:00:00Z",
  "tool": "project_status",
  "args": {}
}
```

Use a fresh request ID each time; never edit an existing request to retry it.

1. Wait briefly for the worker to discover the request (the configured poll interval in the current build is approximately 2 seconds; GitHub transport can add extra delay).
2. Read `bridge/results/req-smoke-project-status-001.json` through the GitHub integration.
3. Verify the result references the same request ID and reports `completed`.
4. Check that the result corresponds to the selected disposable workspace.

Expected outcome: the request is executed locally and its result is returned as a repository file. No local output is injected into the ChatGPT composer or conversation.

## 3. Test refresh and large-output retrieval

1. Create a second request using tool `refresh_environment_context` and `args: {}`, with a unique request ID.
2. Read its result and confirm `bridge/context/latest.json` has a newer `generated_at` timestamp.
3. Create a harmless text file larger than 12 KiB in the disposable workspace and request a bounded `read_file` on it.
4. Read the matching result. If it is `partial` or has `output_truncated: true`, verify the nested tool result's `ok`, `exitCode`, `stdout_truncated`, `stderr_truncated`, and `stderr`. Treat this as incomplete output, not a safety denial unless the result explicitly says rejected/cancelled or reports an approval/policy error.
5. For a large listing, issue fresh requests for stable-sorted pages of 50 entries using `Select-Object -Skip <offset> -First 50`, keeping the total count and offsets. Continue until all pages are recovered; reduce page size if any page is still truncated. Do not tell the user to run PowerShell manually when the bridge can recover the output. Ordinary oversized output is shortened inline, not saved as an artifact.

Expected outcome: large output is marked incomplete honestly, the real execution result is checked, and paginated requests recover all entries without duplicates or omissions.

## 4. Test automatic sandbox writes, approval-gated execution, and file upload

Use only harmless disposable files.

1. Submit a `write_file` request targeting a new file in the disposable workspace, using `tool: "write_file"` and `args: {"path":"sandbox-write-test.txt","content":"written inside workspace"}`.
2. Verify the request completes without a native approval dialog and the file appears inside the selected workspace.
3. Submit a `shell` request with a harmless PowerShell command that would create `approval-cancelled.txt`, such as `Set-Content -LiteralPath 'approval-cancelled.txt' -Value 'should-not-exist'`.
4. When the native Windows approval dialog appears, choose **Cancel**. Read the result and verify it is marked `cancelled`; confirm the file was not created.
5. Submit an `upload_workspace_file` request for a harmless test file, for example `tool: "upload_workspace_file"` with `args: {"path":"harmless.txt","artifactName":"uploaded-harmless.txt"}`.
6. Verify the native approval dialog appears before the file is read/uploaded. Approve once.
7. Read the result. Verify `bridge/artifacts/<request_id>/<filename>`, byte size, SHA-256, and GitHub URL are present. Retrieve the artifact and compare bytes.

Expected outcome: ordinary path-checked file operations are confined to the selected workspace; a declined shell command remains unexecuted; file upload still requires explicit approval.

## 5. Quit and verify lifecycle

1. Quit using the `×` control or the tray menu. Confirm the tray icon disappears and the worker publishes its stopped state.
2. Relaunch the app and confirm it automatically reconnects without a Start Worker button.
3. Confirm no output is injected into the ChatGPT conversation.
4. If any request is `needs_manual_recovery`, inspect the disposable workspace and claim/result files before attempting another request. Never replay an uncertain side-effecting request with the same ID.

## 6. Test speech captions and shared-folder synchronization

1. In Settings, toggle between **Autoplay speech** and **Notification with Play button**. Use **Preview caption** to check the separate caption window, placement, transparency, and theme. Confirm notification mode does not start audio before **Play** is clicked.
2. With Colab connected and TTS ready, run one short speech request in autoplay mode. Verify the caption advances with completed speech chunks and closes after playback finishes. Repeat in notification mode and verify clicking Play starts playback. A preview alone is not a TTS integration test.
3. Choose an empty folder already synchronized by a local cloud provider. Keep sync disabled initially, then enable it; inspect .windows-repository-bridge and verify one device record is written. Change the theme and a widget position, trigger **Sync now**, and verify the record updates.
4. On a second test installation/device using the same synchronized folder, verify a shared theme/tab/widget change appears there and a separate preference change merges back. Test concurrent preference edits and deletion of a shared tab. Do not include credentials, absolute workspace paths, secret URLs, or private content in test state.
5. Disable cloud sync and verify no new writes occur after disabling. Local settings should continue to save and restore.

## Acceptance criteria

- [ ] The app connects to the private repo and dedicated branch.
- [ ] Environment index and all named snapshots are published.
- [ ] A read-only request produces a result file for the same ID.
- [ ] Context refresh updates the snapshot index.
- [ ] Oversized routine tool output is clearly bounded/marked `partial` when shortened; explicitly uploaded files remain retrievable with size/hash metadata.
- [ ] Workspace file edits run automatically without escaping the selected folder.
- [ ] A declined shell command remains unexecuted and returns `cancelled`.
- [ ] File upload requires a local approval and returns the exact bytes.
- [ ] Worker auto-starts and retries when internet/GitHub is unavailable.
- [ ] The full dashboard is the only main window; no compact overlay is launched.
- [ ] Minimizing/closing to tray saves the current tab/widget layout, unloads the dashboard and embedded browser views, and leaves the worker alive.
- [ ] Reopening restores the dashboard layout and browser-tab references.
- [ ] Local settings save and restore; Save now reports completion.
- [ ] Autoplay captions, notification-mode Play, caption configuration, and chunk-progress updates work against a connected TTS service.
- [ ] Opt-in shared-folder sync safely merges multiple device records and excludes credentials, workspace paths, and temporary endpoints.
- [ ] Quit stops the worker and removes the tray icon; no output is inserted into the ChatGPT conversation.

Automated tests and a successful installer build are necessary but not substitutes for this smoke test.


## Optional computer screenshot smoke test

1. With GitHub connected, call the `computer` tool with `{"action":"status"}` to check whether Colab is connected and whether the model is ready.
2. Call `computer` with `{"action":"connect"}` to open the notebook if necessary. Connect a Colab runtime and run **Start the direct Colab vision server**. The notebook displays and tries to copy the random public endpoint automatically; the Windows app watches for the changed clipboard URL and connects directly. If browser clipboard write is blocked, click **Copy endpoint for Windows Bridge** in the notebook output. No app-link handoff, Local Network Access, GitHub token or Colab Secret is required.
3. Once Colab is connected, call `computer` with `{"action":"enable"}` and wait until it reports `model_loaded: true`. Enabling may download several gigabytes of model files and compile llama.cpp.
4. Call `computer` with `{"action":"screenshot","source":"desktop","waitMs":0}`. If it returns a pending state, call `computer` with `{"action":"wait","request_id":"<returned computer-... ID>"}` and verify the request ID and screenshot SHA-256 match.
5. Call `computer` with `{"action":"disable"}`. Confirm new screenshot requests are disabled and `runtime_kept_alive: true`; the browser tab and runtime should remain running.
6. Disconnect Colab and verify `computer(action=status)` reports disconnection rather than a successful screenshot. Restore the runtime and rerun the notebook cell.

These manual checks require a real Google account and a permitted Colab runtime/GPU. Automated tests use a fake transport and do not prove live Colab operation.

Screenshot bytes are sent directly to the authenticated temporary Colab HTTPS endpoint, not committed as a separate screenshot artifact. The resulting report is returned through the normal GitHub mailbox and may still disclose visible screen content.
