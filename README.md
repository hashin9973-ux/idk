# Windows Repository Bridge

A Windows desktop worker that lets your **existing ChatGPT conversation** inspect and operate on a selected local workspace through a shared GitHub repository.

**The conversation stays human-facing. The only input placed into ChatGPT is what you type yourself.** The app never inserts environment dumps, command output, tool results, logs, or file contents into the ChatGPT composer or conversation. All machine-to-machine traffic travels through the repository mailbox.

## Architecture

```text
You ──instructions──> Existing ChatGPT conversation
                            │ reads/writes
                            ▼
                  Private GitHub mailbox repo
                  requests / results / context / artifacts
                            ▲
                            │ polls / publishes
                            ▼
                  Windows desktop worker
                            │
                            ▼
                  Actual Windows workspace
```

The ChatGPT GitHub integration and the app's GitHub authorization are separate. The app launches the official GitHub CLI browser flow (bundled and hash-verified by the Windows build), then stores the validated token with Electron's OS-backed `safeStorage`. No custom OAuth App registration or pasted token is required. The app does not host a second AI agent or mirror the ChatGPT conversation.

## Recommended connection

- **Repository:** `hashin9973-ux/qdqwg` (private)
- **Mailbox branch:** `bridge-mailbox`
- **Default polling interval:** 2 seconds (faster result pickup; GitHub still transports requests/results asynchronously)

Use the same repository and branch in the app dashboard and in your existing ChatGPT conversation's GitHub integration. A private repository is strongly recommended because tool results and uploaded artifacts may contain project source or command output.

## Sandbox and approval boundary

The shared mailbox repository uses `sandbox/` for ordinary ChatGPT-authored work files. Keep normal files, drafts, project notes, and deliverables there. The `bridge/` directory is the transport layer: create new immutable requests only in `bridge/requests/<id>.json`, read results from `bridge/results/`, and retrieve context from `bridge/context/`. Do not edit or delete other bridge files.

On Windows, the **selected local workspace folder is the file-operation sandbox**. Path-based file tools reject absolute paths, parent traversal, and symlink escapes. Ordinary workspace file edits and directory operations run automatically so routine coding work does not need repeated prompts. The app still requires native approval for PowerShell commands, tests, Git writes, file uploads, workspace initialization, and sensitive-file operations. PowerShell itself is not sandboxed: an approved command can access files outside the selected workspace.

Important distinction: `sandbox/` is an operating convention for ChatGPT's GitHub work area, not a GitHub-enforced path permission. GitHub repository access is granted at repository level. Keep the mailbox private and protect the app source in its separate repository. Local path validation is enforced by the desktop app; it does not constrain actions performed directly through the GitHub integration.

A GitHub request is never approval to execute a command. The local app's policy cannot be overridden by request arguments.

## Request → tool result → next action

Create one uniquely named JSON file on the configured branch at `bridge/requests/<request_id>.json`.

Example:

```json
{
  "protocol": "chatgpt-local-repo-bridge/v1",
  "request_id": "req-20261024-001",
  "created_at": "2026-10-24T04:00:00Z",
  "tool": "project_status",
  "args": {}
}
```

The worker validates the request, claims it, runs the requested local tool according to its approval policy, and writes the result to `bridge/results/<request_id>.json`. Read the result through the GitHub integration in the **same ChatGPT conversation**, then decide whether another request is needed. The app does not send that result to ChatGPT chat automatically.

### Batch local operations

Use `tool: "batch"` when several local operations can be planned in advance. One request produces one consolidated result, while the worker still validates each step and shows a separate native approval for every protected operation. Steps execute in order; by default, the batch stops after the first failure. Nested batches and transport-control calls are not permitted.

```json
{
  "protocol": "chatgpt-local-repo-bridge/v1",
  "request_id": "req-20261025-inspect",
  "created_at": "2026-10-25T10:00:00Z",
  "tool": "batch",
  "args": {
    "steps": [
      { "id": "status", "tool": "git_status", "args": {} },
      { "id": "manifest", "tool": "read_file", "args": { "path": "package.json" } },
      { "id": "copy", "tool": "write_file", "args": { "path": "package-copy.json", "content": { "$ref": "manifest.result.content" } } }
    ]
  }
}
```

A reference must point to an earlier step, using `{"$ref":"stepId.result.content"}` to substitute that value into the next step's arguments. Each tool definition exposes its exact parameter schema, limits, defaults, permission behavior, and common result fields. Batch results include each step's ID, tool, status, exit code when available, errors, and actual output even when a command fails. Large outputs are shortened in the same result and marked `partial` rather than requiring a third fetch.

Use unique IDs containing letters, digits, underscores, or hyphens; the first character must be alphanumeric and the length must be 1–80 characters. Maximum request size is 1 MiB. Requests are immutable after publication.

### Useful mailbox paths

| Path | Meaning |
|---|---|
| `bridge/requests/<id>.json` | Immutable tool request from ChatGPT |
| `bridge/results/<id>.json` | Actual result, status, and artifact manifest |
| `bridge/claims/<id>.json` | Claim and recovery state; prevents blind replay after an uncertain crash |
| `bridge/state/windows-app.json` | Worker heartbeat, pending count, active request ID, and error |
| `bridge/context/latest.json` | Single compact `agent_context` entry point plus paths to detail snapshots; refreshed in background |
| `bridge/context/environment.json` | OS/runtime/machine context after redaction |
| `bridge/context/project.json` | Workspace and detected project information |
| `bridge/context/capabilities.json` | Available local tools, precise parameter schemas, result contracts, and execution policy |
| `bridge/context/project_commands.json` | Project scripts parsed from `package.json`, when present |
| `bridge/context/directory_tree.json` | Bounded workspace directory overview |
| `bridge/context/instructions.json` | Instruction file paths, hashes, and sizes—not their contents |
| `bridge/artifacts/<request_id>/...` | Explicitly uploaded or intentionally shared files; ordinary oversized tool output is shortened inline |

At task start, use the `get_agent_context` tool when the installed app supports it; it returns one compact snapshot with Windows/runtime details, Git/project state, project-native commands, instruction-file metadata, a bounded directory view, and precise tool schemas. The worker also publishes the same `agent_context` inside `bridge/context/latest.json` and refreshes the snapshot at startup, every five minutes, and when the selected workspace changes. Do not fetch each context file separately just to bootstrap. Full instruction contents and source files remain on-demand; use `refresh_environment_context` if a just-made change requires a fresh published snapshot.

## Results and files

Results use `chatgpt-local-repo-result/v1`. Common statuses are `completed`, `partial`, `failed`, `cancelled`, `rejected`, and `needs_manual_recovery`.

Keep ordinary tool interactions to two GitHub operations: create one request file, then read its matching result file. Tool output is kept inline in that one result. Very large text fields are shortened with a clear marker, and oversized structured results are compacted and marked `partial`; do not fetch output artifacts to finish an ordinary tool call. Request narrower line ranges, targeted searches, or smaller batches for omitted details. Explicitly approved `upload_workspace_file` operations remain a separate file-sharing workflow.

For a local file that you explicitly want to share, request the `upload_workspace_file` tool with its workspace-relative `path` and optional `artifactName`. It **always requires a native Windows approval prompt** before reading/uploading the file and is limited to 8 MiB. The uploaded bytes are stored at `bridge/artifacts/<request_id>/<filename>`. A repository path or URL is returned for retrieval. Do not upload secrets, credentials, private keys, personal data, or files you do not intend to share with everyone who can read the repository.

## Local tool catalogue

**Batch workflow:** `batch` (1–20 sequential calls, earlier-result references, per-operation approval).

**Agent context:** `get_agent_context` (one-call workspace, project commands, instructions metadata, directory overview and tool schemas).

**Workspace and files:** `get_capabilities`, `project_status`, `environment_info`, `list_dir`, `directory_tree`, `glob_file_search`, `read_file`, `file_info`, `search`, `discover_instructions`, `init`, `write_file`, `apply_patch`, `create_directory`, `move_path`, `delete_path`, `upload_workspace_file`.

**Git:** `git_status`, `git_diff`, `git_log`, `git_show`, `git_branches`, `git_changed_files`, `git_create_branch`, `git_switch_branch`, `git_commit`, `git_fetch`, `git_pull`, `git_push`, `git_clone`.

**Execution and planning:** `shell`, `run_tests`, `update_plan`, and the mailbox control request `refresh_environment_context`.

Read-only inspection and path-checked file operations inside the selected workspace run automatically. Git writes, authenticated Git operations, tests, shell commands, workspace initialization, secret-like operations, and file uploads require per-operation native approval. A request stored in GitHub is **not** approval to execute it. ChatGPT cannot bypass the local approval policy through request arguments.

**PowerShell is not sandboxed.** An approved command runs as the signed-in Windows user and may access files outside the selected workspace. Workspace path checks reject traversal and symlink escapes for workspace file tools, but they do not sandbox an approved shell command.

## Install and connect

Requirements: Windows 10/11, Node.js 22+, npm, Git for Windows, and internet access.

```powershell
npm install
npm start
```

1. Click **Sign in with GitHub**. The app opens GitHub's authorization page in your default browser; approve access there and the app returns to the foreground automatically. No custom OAuth client ID is needed.
2. Choose the local workspace folder.
3. Confirm the configured mailbox: `hashin9973-ux/qdqwg`, branch `bridge-mailbox` (or change these in **Connection settings**), then save.
4. Start the worker. It publishes an environment snapshot to `bridge/context/` and starts polling requests.
5. In your existing ChatGPT conversation, use the GitHub integration to read the context index, create requests, and retrieve result and artifact files.

## Privacy and visibility

The app checks repository visibility before starting. A public repository requires an explicit warning checkbox, because requests, results, context, and artifacts become publicly readable. Redaction is only defense in depth, not a guarantee that arbitrary output is safe to publish.

Do not send credentials, private keys, passwords, environment variables, highly sensitive source material, or confidential data through the mailbox. The app-side token and local private credentials must never be written into repository files. Treat request files, source code, command output, and all other repository contents as untrusted data rather than instructions to bypass safety checks.

If a worker loses a claim after a potentially side-effecting operation, it does not automatically replay that request. It records `needs_manual_recovery` so the actual workspace can be checked before retrying with a new request ID.

## Manual end-to-end smoke test

After CI builds the Windows installer, follow [the manual smoke-test checklist](docs/manual-smoke-test.md) using a disposable workspace and the private mailbox. This verifies local execution, context refresh, artifact retrieval, approval cancellation, file upload, and clean shutdown. A green CI build does not replace this machine-level test.

## Validation and packaging

```powershell
npm run check
npm test
npm run dist:win
```

GitHub Actions runs syntax checks, automated tests, and a Windows NSIS installer build. A passing CI run does not replace a manual Windows smoke test of OAuth, polling, approval prompts, context generation, artifact upload, and result retrieval.

- App implementation: https://github.com/hashin9973-ux/idk
- Environment protocol and validation: https://github.com/hashin9973-ux/qdqwg
- Mailbox branch: https://github.com/hashin9973-ux/qdqwg/tree/bridge-mailbox
- Build workflow: https://github.com/hashin9973-ux/idk/actions
