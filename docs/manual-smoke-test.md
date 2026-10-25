# Manual Windows Smoke Test

Use this checklist after downloading the Windows installer from the latest successful [working-branch CI build](https://github.com/hashin9973-ux/idk/actions/workflows/validate.yml). The Actions run's **Artifacts** section contains the `Windows-Repository-Bridge-...` ZIP; extract it to get the installer.

This is a manual test because GitHub Actions cannot prove the app can connect to the user's actual Windows machine or that the ChatGPT GitHub integration can read the same mailbox.

## Before starting

- Use a **private** copy of `hashin9973-ux/qdqwg` and the dedicated `bridge-mailbox` branch.
- Ensure the configured workspace contains only harmless test files. On first launch this is `Documents/ChatGPTWorkspace`; an existing `workspaceRoot` setting is preserved. Do not use the real Cyberpunk modding workspace for the first run.
- No custom GitHub OAuth App or client ID should be needed. If GitHub is not connected, click the **GitHub not connected** status row; the bundled GitHub CLI opens the official device-authorization page in your default browser. Complete the device flow.
- Keep secrets, tokens, credentials, private keys, and confidential source material out of the workspace files you intend to upload.

## 1. Start and verify environment publication

1. Launch the Windows Repository Bridge and wait for the two status rows to appear.
2. If needed, click **GitHub not connected** and complete the official GitHub CLI device flow in your browser. Do not register a separate OAuth App or enter a client ID.
3. Verify **Worker online** appears after authorization and internet connectivity are available; no Start Worker action should be required. If offline, verify the app continues retrying and updates status after connectivity returns.
4. In GitHub, open `bridge/context/latest.json` on the `bridge-mailbox` branch.
5. Confirm the index points to the environment, project, capabilities, directory tree, and instruction inventory snapshots.
6. Inspect the snapshots. Confirm instruction contents are not included in the initial inventory and obvious local user/home/temp paths are redacted.
7. Click `−` to minimize. Verify the window disappears but the system-tray icon remains and the worker keeps polling. Click the tray icon to reopen the status window.

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
- [ ] Minimizing hides the status window to the tray without stopping the worker; tray click restores it.
- [ ] Quit stops the worker and removes the tray icon; no output is inserted into the ChatGPT conversation.

Automated tests and a successful installer build are necessary but not substitutes for this smoke test.


## Optional Colab vision smoke test

1. With GitHub connected, call vision_status; it should report inactive if vision has never been enabled.
2. Call vision_activate and follow the notebook URL. Add QDQWG_TOKEN in Colab Secrets and run the notebook worker cell. A new model cache requires several gigabytes of Drive space and a one-time llama.cpp build.
3. Poll vision_status until it says ready and confirms model_loaded: true. Opening the notebook alone is not readiness.
4. Call vision_analyze_screenshot with {"source":"desktop","waitMs":0}. Confirm the returned status is pending or report-available and record the same request_id.
5. If pending, call vision_wait with that exact request_id. Confirm report_available, input_image.sha256 and result request ID match the queued request, and report_path points to bridge/vision/reports/<request_id>.txt.
6. Call vision_deactivate. Confirm enabled:false and runtime_kept_alive:true; do not expect Colab or its browser tab to close.
7. Test recoverable statuses by intentionally disconnecting Colab and verify that the app says disconnected, not report-available. Restore the runtime and re-run the worker cell.

These manual integration checks require a real Google account, a permitted Colab runtime/GPU and a repository-scoped token. Unit tests use a fake mailbox/API and are not a live Colab test.


Vision privacy note: the screenshot is committed to `qdqwg` as a temporary artifact. The worker attempts to delete its current branch path after processing, but that deletion does not erase older Git commits. Only use vision when repository access and retained history are acceptable.
