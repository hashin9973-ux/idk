# Manual Windows Smoke Test

Use this checklist after downloading the Windows installer from the latest successful [working-branch CI build](https://github.com/hashin9973-ux/idk/actions/workflows/validate.yml). The Actions run's **Artifacts** section contains the `Windows-Repository-Bridge-...` ZIP; extract it to get the installer.

This is a manual test because GitHub Actions cannot prove the app can connect to the user's actual Windows machine or that the ChatGPT GitHub integration can read the same mailbox.

## Before starting

- Use a **private** copy of `hashin9973-ux/qdqwg` and the dedicated `bridge-mailbox` branch.
- Create a disposable local workspace containing only harmless test files. Do not use the real Cyberpunk modding workspace for the first run.
- Confirm the GitHub OAuth client ID is configured and the app can sign in through the main screen. The login opens the default browser; approve the device request there and confirm the app returns to the foreground.
- Keep secrets, tokens, credentials, private keys, and confidential source material out of the workspace files you intend to upload.

## 1. Start and verify environment publication

1. Launch the Windows Repository Bridge.
2. Choose the disposable workspace folder.
3. Expand **Connection settings**, set owner `hashin9973-ux`, repository `qdqwg`, and branch `bridge-mailbox`, then save. Configure the GitHub OAuth client ID here if this is the first run.
4. Sign in with GitHub from the main screen. Complete approval in the browser and verify the app returns to the foreground.
5. Start the worker.
6. In GitHub, open `bridge/context/latest.json` on the `bridge-mailbox` branch.
7. Confirm the index points to the five snapshots: environment, project, capabilities, directory tree, and instruction inventory.
8. Inspect the snapshots. Confirm instruction contents are not included in the initial inventory and obvious local user/home/temp paths are redacted.

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

1. Wait for the worker to discover the request (the polling interval is approximately 15 seconds).
2. Read `bridge/results/req-smoke-project-status-001.json` through the GitHub integration.
3. Verify the result references the same request ID and reports `completed`.
4. Check that the result corresponds to the selected disposable workspace.

Expected outcome: the request is executed locally and its result is returned as a repository file. No local output is injected into the ChatGPT composer or conversation.

## 3. Test refresh and large-output retrieval

1. Create a second request using tool `refresh_environment_context` and `args: {}`, with a unique request ID.
2. Read its result and confirm `bridge/context/latest.json` has a newer `generated_at` timestamp.
3. Create a harmless text file over 12 KiB in the disposable workspace and request a bounded `read_file` on it.
4. Read the result JSON. Verify the result has an artifact manifest and the full text is available under `bridge/artifacts/<request_id>/...`.
5. Retrieve the artifact through GitHub and compare its size/hash to the manifest.

Expected outcome: the inline result is a preview, while the complete tool output is retrievable through GitHub.

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

## 5. Stop and confirm recovery state

1. Stop the worker in the desktop app.
2. Verify the shared state file reports `stopped`.
3. Confirm the app did not send output into the ChatGPT conversation.
4. If any request is `needs_manual_recovery`, inspect the disposable workspace and claim/result files before attempting another request. Never replay an uncertain side-effecting request with the same ID.

## Acceptance criteria

- [ ] The app connects to the private repo and dedicated branch.
- [ ] Environment index and all named snapshots are published.
- [ ] A read-only request produces a result file for the same ID.
- [ ] Context refresh updates the snapshot index.
- [ ] Large text is externalized and retrievable with size/hash metadata.
- [ ] Workspace file edits run automatically without escaping the selected folder.
- [ ] A declined shell command remains unexecuted and returns `cancelled`.
- [ ] File upload requires a local approval and returns the exact bytes.
- [ ] Stop state is published; no output is inserted into the ChatGPT conversation.

Automated tests and a successful installer build are necessary but not substitutes for this smoke test.
