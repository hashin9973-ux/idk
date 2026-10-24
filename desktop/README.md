# Windows Repository Bridge — desktop app

This app is a local Windows worker for your existing ChatGPT conversation. ChatGPT remains in your normal browser; requests, results, environment context, and explicitly uploaded files travel through a private GitHub repository branch.

## First-time setup

1. In **Connection settings**, set the private mailbox repository and branch. Defaults are `hashin9973-ux/qdqwg` and `bridge-mailbox`.
2. Configure a GitHub OAuth App with Device Flow enabled, then paste its client ID into Connection settings. The app only needs the public client ID; its access token is stored with Windows-backed Electron `safeStorage`.
3. Choose the workspace folder.
4. Click **Sign in with GitHub**. The default browser opens to GitHub's device-authorization page. If already signed in, you can use that browser session to authorize access. The app detects completion and returns to the foreground.
5. Click **Start worker**. Keep typing instructions in your existing ChatGPT conversation, using its GitHub integration to create mailbox requests and read results.

ChatGPT does not need a separate login inside this worker. **Open ChatGPT** opens `https://chatgpt.com/` in the default browser. This app does not access ChatGPT cookies or credentials and does not inject results into ChatGPT messages.

## Trust boundaries

- The worker polls the configured mailbox every 15 seconds.
- A private repository is strongly recommended because requests, results, context, and artifacts live in that repository.
- Read-only workspace inspection normally runs without approval. File changes, Git writes, shell commands, tests, and uploads require native Windows approval.
- PowerShell is not sandboxed: an approved command runs with the signed-in Windows user's permissions.
- The app uses GitHub as transport. It is not a second AI agent and does not send or type messages into ChatGPT.

## Run and verify

```powershell
npm install
npm run check
npm test
npm start
```
