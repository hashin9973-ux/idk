# ChatGPT Assistant Overlay

A compact Windows desktop app that embeds the real ChatGPT website, can collapse into a draggable orb, and exposes a local coding-tool backend to the **same ChatGPT conversation**. ChatGPT can inspect a selected workspace, edit files, run commands after native approval, inspect Git history, and call the connected GitHub API. Results are returned to the embedded conversation so ChatGPT can continue from real output rather than guessing.

## What it includes

- Persistent ChatGPT web sign-in inside an embedded Chromium session; no OpenAI API key is needed for the website session.
- A separate Accounts window to open ChatGPT sign-in and connect GitHub using GitHub OAuth Device Flow.
- Windows secure credential storage for the GitHub OAuth token. The token is not exposed to the renderer or inserted into chat.
- 30 local tool endpoints across workspace inspection, file editing, Git, command execution, planning, and GitHub REST API access.
- A selected local workspace with path-traversal and symlink-escape checks.
- Native, per-operation approval for writes, moves, deletes, patch application, branch/commit changes, tests, shell commands, and GitHub API writes.
- A structured `assistant_tool` request convention that lets the embedded ChatGPT page ask the app to run a tool and then receive the real result in the same conversation.
- GitHub Actions checks, tests, and a Windows NSIS installer build.

## Run locally

Requirements: Windows 10/11, Node.js 22 or newer (Node 24 recommended), npm, Git for Windows, and internet access.

From the repository root:

    npm install
    npm start

The first run opens the ChatGPT website. Sign in normally. Choose the project folder with the folder button in the title bar. The default workspace is the `ChatGPTWorkspace` directory inside your Documents folder.

## Sign in to ChatGPT and GitHub

Click the person/accounts button in the title bar.

**ChatGPT:** Sign-in happens on the embedded ChatGPT website. The app persists that website session separately from its local UI. It does not read or store ChatGPT passwords or session tokens.

**GitHub:** Create a GitHub OAuth App in GitHub Developer settings, enable *Device Flow*, and enter its client ID in the Accounts window. Select **Save client ID**, then **Sign in with GitHub**. GitHub opens its official device verification page; enter the one-time code shown in the app and authorize the requested `repo` and `read:user` scopes. Review those permissions in GitHub before granting them. The app encrypts the access token with Electron's OS-backed `safeStorage` and offers a sign-out action that removes the saved token.

The app's `github_api` tool uses the authorized token for approved GitHub REST requests. The GitHub API bridge has an explicit route allowlist and blocks sensitive security/account-management endpoints. GET requests are read-only; each POST, PUT, PATCH, or DELETE request requires a separate native approval. The OAuth token is not written to Git remote URLs or passed as a command-line argument. Local `git push` and authenticated clone operations use the normal Git Credential Manager configuration on the machine.

## Use local tools in the same ChatGPT conversation

1. Open the overlay and choose the repository folder.
2. In the ChatGPT conversation, type `/tools` and press Enter to give ChatGPT the local tool instructions.
3. Describe the task normally. ChatGPT can emit a fenced `assistant_tool` block when it needs local access.
4. The app validates the requested tool and arguments, shows a native approval prompt when needed, runs the local operation, and inserts its actual result into the same ChatGPT conversation.
5. ChatGPT can then inspect the result and make the next tool call.

Example request (ChatGPT emits this, not something you need to type):

    ```assistant_tool
    {"version":1,"tool":"read_file","args":{"path":"src/index.js"},"call_id":"read-src"}
    ```

This protocol is a local bridge convention, **not native first-party tool registration in the ChatGPT website**. The desktop app detects the structured block in ChatGPT's page and returns the tool result as a follow-up message in that same conversation. The bridge currently handles one tool call per assistant response; ChatGPT decides the next action after each result. Since it integrates with the website's DOM, ChatGPT site changes can require bridge updates.

## Local tool catalogue

The local tool registry exposes the following endpoints through `get_capabilities`.

**Workspace and files:** `project_status`, `environment_info`, `list_dir`, `directory_tree`, `glob_file_search`, `read_file`, `file_info`, `search`, `discover_instructions`, `init`, `write_file`, `apply_patch`, `create_directory`, `move_path`, `delete_path`.

**Git:** `git_status`, `git_diff`, `git_log`, `git_show`, `git_branches`, `git_changed_files`, `git_create_branch`, `git_switch_branch`, `git_commit`.

**Execution and planning:** `shell`, `run_tests`, `update_plan`.

**GitHub account/API:** `github_status`, `github_api`.

Use paths relative to the selected workspace. Reads of secret-like filenames require approval. All file mutations and risky execution have a native approval prompt. GitHub writes have their own approval prompt even after GitHub sign-in. The app does not silently run arbitrary tool calls with elevated permissions.

## Familiar slash commands

Type one of these directly in the ChatGPT composer:

- `/status` or `/pwd` — project summary and Git state.
- `/env` — non-secret runtime and machine information.
- `/ls [path]` or `/tree [path]` — list entries or display a directory tree.
- `/find <glob>` — discover files, e.g. `/find src/**/*.js`.
- `/read <path>` or `/info <path>` — read a text file or inspect metadata.
- `/search <text>` or `/instructions [paths]` — search contents or discover `AGENTS.md` guidance.
- `/git`, `/diff`, `/log`, `/branches`, `/changed` — Git inspection.
- `/mkdir <path>`, `/mv <source> <destination>`, `/rm <path>` — filesystem changes.
- `/branch <name>`, `/switch <name>`, `/commit <message>` — Git changes, each requiring approval.
- `/test [command]` and `/exec <PowerShell command>` — test or command execution (approval required).
- `/github` — check GitHub connection.
- `/workspace` — choose the project folder.
- `/tools` — send local-tool instructions to the current ChatGPT conversation.
- `/plan [task]`, `/review`, and `/help` — planning, review, and help.

## Safety boundaries

The selected workspace is the default filesystem boundary. Path traversal and symlink escapes are rejected. Direct reads of credential-looking files need approval; content search skips those files. File edits and patches are staged atomically when possible. Results include actual exit status and output, with output limits.

PowerShell is **not sandboxed**: an approved command runs with the current Windows user's permissions and may access files outside the selected workspace. Review each command before approving it. This application is unsigned, so SmartScreen may warn when installing it.

## Build the Windows installer

    npm run dist:win

The installer is emitted under `dist`. The GitHub Actions workflow runs syntax checks and tests, builds an unsigned NSIS installer, uploads it as a workflow artifact, and publishes pre-releases for non-PR builds:

- Releases: https://github.com/hashin9973-ux/idk/releases
- Build workflow: https://github.com/hashin9973-ux/idk/actions

## Repository roles

- App development: https://github.com/hashin9973-ux/idk
- Test and release validation plan: https://github.com/hashin9973-ux/qdqwg
