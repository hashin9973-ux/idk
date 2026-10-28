# Windows Repository Bridge — desktop app

This app is a local Windows worker for your existing ChatGPT conversation. ChatGPT remains in your normal browser; requests, results, environment context, and explicitly uploaded files travel through a private GitHub repository branch.

## First-time setup

1. Start the app. The default mailbox is `hashin9973-ux/qdqwg` on branch `bridge-mailbox`; the worker automatically connects when the saved GitHub sign-in and mailbox configuration are valid.
2. Click **Sign in with GitHub** if the app is not authenticated. The app launches the official GitHub CLI browser authorization flow. Approve the permissions on GitHub; the app imports the validated token into Windows-backed Electron `safeStorage`. No custom OAuth App registration, client ID, client secret, personal access token, or pasted credential is required.
3. In the status window, click the **Workspace: …** row to open the Windows folder picker. The app initially uses `Documents\ChatGPTWorkspace`. Select a project folder for narrow access, or select a drive root such as `C:\` to make the entire drive available. A warning confirmation appears before switching to an entire drive. The status row then labels it **Workspace: entire drive C:\**.
4. Continue using your existing ChatGPT conversation and its GitHub integration to create mailbox requests and read results. There is no separate ChatGPT chat interface in this worker.

The app maintains a names-only index for the selected workspace. For a normal project folder it indexes descendants; for a drive root it deliberately scans and watches only immediate children instead of crawling every file on a potentially huge drive. The current snapshot is synchronized to `bridge/context/filesystem-index.md`; `bridge/context/latest.json` points ChatGPT to it. The index contains relative paths and item types only—not file contents or absolute local paths. In drive-root mode, explore specific folders on demand with `list_dir`, `directory_tree`, `glob_file_search`, or `search` and provide their `path`. The warning confirmation is important: file tools can change or delete files anywhere inside the selected drive, while PowerShell remains unrestricted as your Windows user.

The installer bundles GitHub CLI v2.103.2 and verifies the archive SHA-256 before packaging it, so you do not need to install the CLI separately. GitHub's authorization consent screen determines the scopes granted to the GitHub CLI OAuth application; review it before approving. The app's own GitHub API routes are restricted to the configured mailbox repository and supported `bridge/` paths. **Disconnect app** clears the app's encrypted token; it does not sign you out of the separate GitHub CLI profile.

ChatGPT does not need a separate login inside this worker. **Sign in to ChatGPT** opens `https://chatgpt.com/auth/login/` in the default browser. This app does not access ChatGPT cookies or credentials and does not inject results into ChatGPT messages.

## Diagnose a failed request

Use the request ID to inspect `bridge/requests/<request-id>.json`, `bridge/claims/<request-id>.json`, and `bridge/results/<request-id>.json` on the configured mailbox branch. A request file means ChatGPT/its GitHub integration committed the request; a matching claim means the local worker claimed it; the result records validation, execution, and any tool error. If no request file exists, the Windows worker never received that request through this mailbox, so investigate the upstream request creation or ChatGPT/GitHub integration rather than describing it as a local execution block.

## Observe-first interactive desktop loop

When Observe is already on, read the newest `bridge/vision/observe.json` frame directly before taking any screen action; do not wait for a new context bootstrap or run `computer(action=status)` just to inspect the passive feed. Then use **Observe → justified input → matching result → fresh Observe → next input** until the requested state is verified. Publish real requests with the GitHub integration's create-file/write operation. If request creation fails, quote the observed error; if a result is missing, inspect that exact request's claim/state and reread the same result instead of replaying it. Use `computer(action=sequence, mode="fast")` to batch known adjacent actions; do one action then reread Observe when the next action depends on the changed screen. Avoid status calls and explanatory narration between inputs.

Observe currently gives window/control/UI Automation evidence and changed-screen fingerprints, not guaranteed OCR or full screenshot pixels. It cannot verify text that its controls explicitly mark unreadable. Use the Colab screenshot path only when pixels or model interpretation are needed, and follow its separate explicit-activation/readiness rules.

## Trust boundaries

- The worker polls the mailbox on an approximately one-second timer. The path-filtered request-commit cursor is the fast path; the worker also reconciles the request-directory Git tree every five seconds in the updated build so a stale cursor does not strand input requests for a minute. GitHub MCP write/read latency and ChatGPT turn latency are separate and can still dominate end-to-end time; use the matching request's commit time, claim time, and `timing_ms` fields to diagnose them.
- The current worker can process up to 32 independent mailbox requests at once. The published local `batch` schema supports 1–100 steps and `maxConcurrency` 1–100; these are separate limits. `$ref` dependencies, conflicting workspace paths, and side-effecting operations must remain ordered. The installed tool catalog is authoritative if a build differs.
- A private repository is strongly recommended because requests, results, context, and artifacts live in that repository.
- Read-only workspace inspection normally runs without approval. Ordinary file edits/moves/deletions inside the selected workspace normally run automatically unless a path looks sensitive. If a whole drive is selected, that includes files anywhere inside the drive. Git writes, shell commands, tests, and uploads require native Windows approval unless Auto-accept everything was explicitly enabled.
- PowerShell is not sandboxed: an approved command runs with the signed-in Windows user's permissions.
- GitHub access authorizes the mailbox transport; local work is performed by this Windows worker, not by GitHub itself.
- The app uses GitHub as transport. It is not a second AI agent and does not send or type messages into ChatGPT.

## Run and verify

```powershell
npm install
npm run check
npm test
npm start
```

On Windows, `npm start` prepares the pinned CLI helper automatically. To build the installer locally, `npm run dist:win` performs the same verified download and packages it with the app.
