# ChatGPT Assistant for Windows

This project is a Windows companion intended to give a **normal ChatGPT conversation** access to real local development tools, without switching to Codex or a separate AI conversation.

The GitHub repository is the communication channel between ChatGPT and the desktop app:

1. ChatGPT uses the user's existing ChatGPT GitHub integration to commit a structured request file to the configured repository.
2. The Windows app polls that repository, validates the request, and shows a native approval dialog.
3. After approval, the app runs the requested operation on the selected Windows workspace using the current Windows user's permissions.
4. The app commits the real result to the repository and submits the result back into the same ChatGPT conversation.
5. ChatGPT uses that result to decide what to do next. This repeats until the task is complete.

**These are separate GitHub connections.** ChatGPT's existing GitHub integration writes request files and reads repository content. The app's own GitHub OAuth connection only lets the Windows app poll the queue and write results. Its credential is not exposed to ChatGPT as a tool and is never inserted into chat.

## Current implementation status

- The repository-backed request/result protocol and Windows poller are being implemented on the `feature/repository-backed-local-bridge` branch.
- The local tool backend already supports workspace inspection, file edits, Git inspection/changes, shell commands, tests, and planning.
- Local operations arriving through the repository queue require a native, per-request approval.
- The queue keeps a local execution ledger, avoids blindly rerunning requests after a crash, and publishes an `indeterminate` result when it cannot prove whether an interrupted command completed.
- The configured bridge repository must be private unless you explicitly enable public-repository use in Accounts. Results can contain source code and command output.
- The app still embeds the ChatGPT web page in its current window. **The requested lightweight, viewport-only conversation mirror is not implemented yet.** The existing same-conversation result injection also depends on ChatGPT's page composer and may need adjustments when ChatGPT changes its DOM. Do not treat a CI build as proof that the mirror or interactive workflow has been manually validated.

## Request/result protocol

The default request and result folders on the configured branch are:

- Requests: `.chatgpt-bridge/requests/<call_id>.json`
- Results: `.chatgpt-bridge/results/<call_id>.json`

Each request filename uses a unique `call_id` without the `.json` suffix. The request body is JSON, not a GitHub Actions workflow:

```json
{
  "protocol": "chatgpt-windows-bridge/request-v1",
  "call_id": "inspect-src-001",
  "tool": "read_file",
  "args": {
    "path": "src/index.js"
  },
  "description": "Inspect the entry point",
  "created_at": "2026-10-24T00:00:00Z"
}
```

The result file uses protocol `chatgpt-windows-bridge/result-v1` and includes the same call ID, status, timestamp, actual tool report, and (where useful) the request/result paths. A result is committed before the app tries to deliver it to ChatGPT. The local ledger and pending-result cache allow a result publication to be retried without rerunning the local operation.

The app handles one request at a time, in filename order. Every repository-originated request requires native confirmation, even for a read-only tool. A collaborator's ability to create a request does not by itself grant that person permission to inspect or change the local machine.

Never put passwords, API keys, personal access tokens, private keys, or other secrets into request JSON files. Avoid routing local command output to a public repository. A private repo is strongly recommended.

## Local development tools

Workspace/files:

- `project_status`, `environment_info`, `list_dir`, `directory_tree`, `glob_file_search`
- `read_file`, `file_info`, `search`, `discover_instructions`
- `init`, `write_file`, `apply_patch`, `create_directory`, `move_path`, `delete_path`

Git:

- `git_status`, `git_diff`, `git_log`, `git_show`, `git_branches`, `git_changed_files`
- `git_create_branch`, `git_switch_branch`, `git_commit`

Execution/planning:

- `shell`, `run_tests`, `update_plan`, `get_capabilities`

Paths are relative to the workspace selected in the app. The current implementation uses that selected folder for local execution; select the actual project checkout, not a generic empty workspace. Shell commands execute as the signed-in Windows user and are **not sandboxed**. Review each approval request carefully.

## Sign in and configure the bridge

Requirements: Windows 10/11, Node.js 22+, npm, Git for Windows, and internet access.

Run locally:

```powershell
npm install
npm start
```

Open **Accounts**, then configure the GitHub OAuth App client ID (with Device Flow enabled), sign in, and set the bridge repository and branch. The OAuth grant requests `repo` and `read:user`; review and grant permissions on GitHub itself. The token is encrypted using Electron's Windows-backed `safeStorage`.

The Accounts window displays the poller status. An idle status means that the app is connected and waiting for a request. For development use, enable the bridge instructions in the current ChatGPT conversation with `/tools`; this sends a normal message into that thread explaining the request/result protocol. This activation step is still manual in the current branch and should be automated before calling the workflow seamless.

## Familiar local commands

These commands can be typed directly into the embedded ChatGPT composer:

- `/status` or `/pwd` — inspect the selected workspace and Git state.
- `/env` — show non-secret runtime and machine information.
- `/ls [path]`, `/tree [path]`, `/find <glob>`, `/read <path>`, `/info <path>`, `/search <text>`.
- `/git`, `/diff`, `/log`, `/branches`, `/changed`.
- `/mkdir <path>`, `/mv <source> <destination>`, `/rm <path>`.
- `/branch <name>`, `/switch <name>`, `/commit <message>`.
- `/test [command]`, `/exec <PowerShell command>` (local execution requires approval).
- `/github` — check the app-side repository bridge.
- `/workspace` — choose the local workspace; `/tools` — send the bridge instructions to this conversation.
- `/plan [task]`, `/review`, `/help`.

The legacy fenced `assistant_tool` convention is not an execution path anymore. If ChatGPT emits one instead of committing a request through its GitHub integration, the app refuses to execute it and replies with instructions for the repository protocol.

## Safety

The selected workspace is the default filesystem boundary. Path traversal and symlink escapes are rejected. Reading credential-looking files, file changes, deletes, branch/commit changes, shell commands, and tests require native approval. For a repository queue request, the app requires approval for every tool regardless of its usual local policy. PowerShell can still access locations outside the workspace under the current user's permissions; the workspace boundary is not an OS sandbox.

Repository requests/results are GitHub commits and can trigger the configured repository's workflows. Prefer configuring a dedicated bridge branch if your repository automation is sensitive to every commit. The app currently defaults the branch field to `main`; it does not automatically create a branch.

## Build

```powershell
npm run check
npm test
npm run dist:win
```

GitHub Actions runs syntax checks, tests, and an unsigned Windows NSIS installer build. A successful CI run verifies those automated checks; it does not verify interactive ChatGPT sign-in, the page DOM bridge, native prompts on your Windows machine, or the not-yet-implemented lightweight mirror.

- App repository: https://github.com/hashin9973-ux/idk
- Build workflow: https://github.com/hashin9973-ux/idk/actions
- Releases: https://github.com/hashin9973-ux/idk/releases
- Test/release-plan repository: https://github.com/hashin9973-ux/qdqwg
