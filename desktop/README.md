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

## Trust boundaries

- The worker checks the mailbox every 2 seconds by default to minimize request/result latency. GitHub remains asynchronous, so a slow command or an unapproved operation may still take longer.
- Up to three independent mailbox requests can run at once. Inside a `batch`, independent steps can run concurrently (`maxConcurrency` 1–8, default 4); `$ref` dependencies, conflicting workspace paths, and operations with unknown side effects preserve the required order. Results remain in the submitted step order, and queued steps skipped after a failure are marked `skipped`.
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
