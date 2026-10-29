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

Use the request ID to inspect `bridge/requests/<request-id>.json`, `bridge/claims/<request-id>.json`, and `bridge/results/<request-id>.json` on the configured mailbox branch. A request file means ChatGPT/its GitHub integration committed the request; a matching claim means the local worker claimed it; the result records validation, execution, and any tool error. If no request file exists, the Windows worker never received that request through this mailbox, so investigate the upstream request creation or ChatGPT/GitHub integration rather than describing it as a local execution block. If the GitHub create-file call reports HTTP 409 for a branch-head conflict, read back that exact request path first; if it exists, continue with the same request, and if it is absent, refresh the branch and retry the same ID/path. Never create a second ID to work around an uncertain write.

## Output and installer verification discipline

Keep shell diagnostics compact; do not return full process command lines, environment snapshots, transcripts, or unbounded logs. Report only necessary state/hash/exit fields. For large output that must be preserved, read every artifact part named in the result manifest and check `artifact_errors` rather than relying on a preview.

For downloads or installers, persist a small stage/status marker and capture asset size/hash, installer exit code, before/after app archive hashes and running app state. If the outer shell times out while a launched child may still be running, reconcile the original status marker with a fresh read-only request before retrying. Do not overlap installs or claim success from a launch, a changed worker ID, or a published installer URL alone.

## Observe-first interactive desktop loop

When Observe is already on, read the newest `bridge/vision/observe.json` frame directly before taking any screen action; do not wait for a new context bootstrap or run `computer(action=status)` just to inspect the passive feed. Then use **Observe → justified input → matching result → fresh Observe → next input** until the requested state is verified. Publish real requests with the GitHub integration's create-file/write operation. If request creation fails, quote the observed error; if a result is missing, inspect that exact request's claim/state and reread the same result instead of replaying it. Use `computer(action=sequence, mode="fast")` to batch known adjacent actions; do one action then reread Observe when the next action depends on the changed screen. Avoid status calls and explanatory narration between inputs.

Observe currently gives window/control/UI Automation evidence and changed-screen fingerprints, not guaranteed OCR or full screenshot pixels. It cannot verify text that its controls explicitly mark unreadable. Use the Colab screenshot path only when pixels or model interpretation are needed, and follow its separate explicit-activation/readiness rules.

## Trust boundaries

- The worker scheduler wakes on an approximately one-second timer, but new-request discovery scans the bounded request-directory Git tree every five seconds. It no longer waits for the path-filtered commits endpoint before scanning; a slow query there previously could block the poll loop and make the five-second recovery interval ineffective. `requestPolling` telemetry reports the last tree scan duration/count and last poll duration. GitHub MCP write/read latency and ChatGPT turn latency remain separate; compare the actual request commit time, claim time, and result `timing_ms` to diagnose them.
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


## Separate dashboard and embedded Colab browser

The compact overlay remains available. Open the separate Dashboard from the arrow button in the overlay or from the tray menu. The dashboard has Main and Settings tabs at the bottom; the Settings tab can be closed and restored with the + control. Dashboard widgets can be moved and resized with invisible resize edges and snap to a fine positioning grid.

Settings reuse the app's GitHub sign-in, workspace selection, Observe sampling, and repository bridge configuration. Repository changes are refused while any requests are active or queued and the previous configuration is restored if a replacement cannot be started. Public mailbox use requires an explicit checkbox. TTS volume scales local 16-bit PCM samples before playback.

Quick Colab connect opens the existing notebook in an embedded tab using the app's existing automatic clipboard endpoint watcher and authenticated HTTPS registration. Remote web content runs in an isolated WebContentsView with no application preload or Node integration. The optional background-focus compatibility mode disables Chromium background throttling and makes document visibility/focus APIs report active; it does not focus the native window or synthesize input, and some sites may use other focus signals. Low-memory mode unloads inactive web tabs instead, so the two options are mutually exclusive. The app measures the embedded renderer's private memory, but 100 MB is a best-effort target, not a guaranteed cap; Chromium and Colab can exceed it.


## Dashboard color themes

The dashboard Settings tab includes a local color-theme selector: Midnight (default), Light, Ocean, Forest, Sunset, Rose, and High contrast. The selected theme is persisted in the app's settings and restored at dashboard startup. Theme names are validated in the main process; theme choices only affect the dashboard's visual presentation.
