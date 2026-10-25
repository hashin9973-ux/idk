# Windows Repository Bridge — desktop app

This app is a local Windows worker for your existing ChatGPT conversation. ChatGPT remains in your normal browser; requests, results, environment context, and explicitly uploaded files travel through a private GitHub repository branch.

## First-time setup

1. Start the app. The default mailbox is `hashin9973-ux/qdqwg` on branch `bridge-mailbox`; the settings panel lets you change it.
2. Click **Sign in with GitHub**. The app launches the official GitHub CLI browser authorization flow. Approve the permissions on GitHub; the app imports the validated token into Windows-backed Electron `safeStorage`. No custom OAuth App registration, client ID, client secret, personal access token, or pasted credential is required.
3. Choose the local workspace folder.
4. Click **Start worker**. Keep using your existing ChatGPT conversation and its GitHub integration to create mailbox requests and read results.

The installer bundles GitHub CLI v2.103.2 and verifies the archive SHA-256 before packaging it, so you do not need to install the CLI separately. GitHub's authorization consent screen determines the scopes granted to the GitHub CLI OAuth application; review it before approving. The app's own GitHub API routes are restricted to the configured mailbox repository and supported `bridge/` paths. **Disconnect app** clears the app's encrypted token; it does not sign you out of the separate GitHub CLI profile.

ChatGPT does not need a separate login inside this worker. **Sign in to ChatGPT** opens `https://chatgpt.com/auth/login/` in the default browser. This app does not access ChatGPT cookies or credentials and does not inject results into ChatGPT messages.

## Trust boundaries

- The worker checks the mailbox every 2 seconds by default to minimize request/result latency. GitHub remains asynchronous, so a slow command or an unapproved operation may still take longer.
- A private repository is strongly recommended because requests, results, context, and artifacts live in that repository.
- Read-only workspace inspection normally runs without approval. File changes, Git writes, shell commands, tests, and uploads require native Windows approval.
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
