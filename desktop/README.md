# Desktop application notes

The app embeds the real ChatGPT website in a persistent Electron session and connects the current ChatGPT conversation to local tools through the app-owned `assistant_tool` fence convention.

## Run and verify

```powershell
npm install
npm run check
npm test
npm start
```

## Tool flow

Type `/tools` into the embedded ChatGPT composer. ChatGPT can then emit one fenced `assistant_tool` JSON request per assistant response. The app validates the request, applies the relevant approval policy, runs the local operation, and posts the actual result back into the same conversation. ChatGPT chooses the next operation after inspecting the result.

This is a website-DOM bridge, not native tool registration inside the ChatGPT web product. Site UI changes can affect detection and need compatibility fixes.

## Local tool families

- Workspace inspection: project/environment status, directories and trees, glob search, ranged file reads, metadata, full-text search, and `AGENTS.md` discovery.
- File operations: initialize instructions, atomic writes, multi-file patch, directory creation, move, and delete.
- Git: status, diffs, history, show, branches, changed files, branch creation/switching, and commits.
- Execution: PowerShell and test commands, both behind native approval.
- Planning: local plan state.
- GitHub: OAuth Device Flow, connection status, and an allowlisted REST bridge. Non-GET requests need native approval.

## Accounts

The titlebar Accounts button opens a separate local window. ChatGPT sign-in occurs on the embedded website and uses its persistent web session. GitHub sign-in uses an OAuth App with Device Flow enabled; its client ID is configured in the Accounts window. The app requests `repo` and `read:user` scopes and stores the OAuth token encrypted with Electron `safeStorage`. It does not expose credentials to renderer JavaScript or place them in chat.

## Approval / trust model

Filesystem paths are relative to the selected workspace; traversal and symlink escape are rejected. Sensitive-looking files are excluded from search and require approval to read. Mutations, Git changes, shell commands, tests, and GitHub API writes require per-operation approval.

PowerShell is not sandboxed and runs as the current Windows user. Git network operations (such as `git push`) use the machine's existing Git Credential Manager; the app's encrypted token is used only by its GitHub REST bridge.
