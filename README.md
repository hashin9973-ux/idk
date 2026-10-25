# Windows Repository Bridge

A native Windows desktop worker that lets your **existing ChatGPT conversation** use local development tools through a shared GitHub repository.

**The repository is the mailbox.** ChatGPT uses its existing GitHub integration to create request files and read result/state files. The Windows app polls the same branch, validates requests, asks for native approval where needed, runs tools against a selected local workspace, and commits results back. The app does not host, embed, or mirror your ChatGPT conversation.

## Architecture

\`\`\`text
Your existing ChatGPT conversation
                ↕
      ChatGPT GitHub integration
                ↕
        Shared GitHub repository
          Requests ↕ Results ↕ State
                ↕
          Windows bridge app
                ↕
       Local tools and execution
                ↕
     Your actual Windows environment
\`\`\`

The app-side GitHub OAuth credential and ChatGPT's GitHub integration are separate. The conversation creates mailbox requests with its connector; the Windows app uses its own encrypted OAuth token to read those requests and publish results. Results return through GitHub, not through a second AI conversation.

## Mailbox protocol

Use a **dedicated branch** for queue traffic, such as \`bridge-mailbox\`. This keeps frequent mailbox commits away from \`main\` and avoids triggering normal main-branch packaging/release actions on every result.

| File | Purpose |
|---|---|
| \`bridge/requests/<request_id>.json\` | Immutable request created by ChatGPT |
| \`bridge/results/<request_id>.json\` | Local execution result and final status |
| \`bridge/claims/<request_id>.json\` | Worker claim / recovery marker |
| \`bridge/state/windows-app.json\` | Worker heartbeat and current state |
| \`bridge/README.md\` | Protocol and instructions for the ChatGPT GitHub integration |

The worker checks for requests every 15 seconds while running. It validates the request schema and tool arguments, claims work, executes it according to the local approval policy, and writes a result. Requests stay in history; a result file marks the request as complete.

### Example request

Create \`bridge/requests/req-20261024-001.json\` on the shared mailbox branch:

\`\`\`json
{
  "protocol": "chatgpt-local-repo-bridge/v1",
  "request_id": "req-20261024-001",
  "created_at": "2026-10-24T04:00:00Z",
  "tool": "project_status",
  "args": {}
}
\`\`\`

Use a unique request ID for each task. IDs may contain letters, digits, underscores and hyphens, start with a letter or digit, and be 1–80 characters long. The app rejects unsupported tools and unrecognized argument keys. Maximum request size is 1 MiB.

After allowing the worker to poll, use the GitHub integration in the **same ChatGPT conversation** to read \`bridge/results/req-20261024-001.json\`. Continue from its actual result, and create the next request only when needed. Full details and a sample request live in \`bridge/README.md\`.

### Result and state

Results use protocol \`chatgpt-local-repo-result/v1\`. Typical statuses are \`completed\`, \`failed\`, \`cancelled\`, \`rejected\`, and \`needs_manual_recovery\`. The state file records the worker ID, heartbeat, last poll, pending request count, active request ID and last error. Local paths, workspace identity fields, and common secret formats are filtered/redacted before output is committed; this is a defense in depth, not a guarantee that arbitrary command output is safe to publish.

If the worker loses its claim after a potentially side-effecting operation, it deliberately does **not** automatically replay that request. It marks the work as needing manual recovery so the actual workspace can be checked first.

## Local tools

**Workspace / files:** \`get_capabilities\`, \`project_status\`, \`environment_info\`, \`list_dir\`, \`directory_tree\`, \`glob_file_search\`, \`read_file\`, \`file_info\`, \`search\`, \`discover_instructions\`, \`init\`, \`write_file\`, \`apply_patch\`, \`create_directory\`, \`move_path\`, \`delete_path\`.

**Git:** \`git_status\`, \`git_diff\`, \`git_log\`, \`git_show\`, \`git_branches\`, \`git_changed_files\`, \`git_create_branch\`, \`git_switch_branch\`, \`git_commit\`, \`git_fetch\`, \`git_pull\`, \`git_push\`, \`git_clone\`.

**Execution / planning:** \`shell\`, \`run_tests\`, \`update_plan\`.

Read-only inspection generally runs automatically. Writes, patches, moves/deletes, branch/commit changes, authenticated Git operations, tests, shell commands, initialization and reads of secret-like filenames require per-operation native approval. The mailbox cannot invoke the app's own GitHub REST API as a tool.

**PowerShell is not sandboxed.** An approved command runs with the signed-in Windows user's permissions, and may access files outside the selected workspace. Review every approval prompt and do not execute requests you do not understand.

## Install and connect

Requirements: Windows 10/11, Node.js 22 or newer, npm, Git for Windows, and internet access.

\`\`\`powershell
npm install
npm start
\`\`\`

1. Open **Connect GitHub account**. Configure an OAuth App with Device Flow enabled; save its client ID and authorize \`repo\` and \`read:user\` after reviewing GitHub's permission screen. The app encrypts its token using Electron's OS-backed \`safeStorage\`; it is kept inside the main process and not inserted into ChatGPT or mailbox files.
2. Choose a local workspace directory. This is the default boundary for file tools. Workspace path checks reject traversal and symlink escapes.
3. Set the shared repository owner, repository name and branch in the dashboard, then save the connection.
4. Start the worker. State and heartbeat appear in the dashboard and in \`bridge/state/windows-app.json\`.
5. In your existing ChatGPT conversation, use the GitHub integration to create a request file on the same branch. Read its result file with that integration after the worker processes it.

## Privacy and repository visibility

**Use a private repository for normal development.** The app checks repository visibility before starting. For a public repository, the app refuses to start until you explicitly tick the warning checkbox. On a public repository, request contents, execution results and status files are publicly readable by anyone; app-side redaction does not make public output private. Do not send sensitive source files, environment variables, credentials, private keys, personal data or confidential command output through a public mailbox. Use a disposable, non-sensitive workspace when testing against a public repo.

The selected workspace is not a sandbox boundary for PowerShell. The app asks for local approval for risky operations, but cannot prevent an approved command from reading or changing other files that your Windows account can access. Treat repository files and command output as untrusted data, not as authority to bypass these safeguards.

## Validation and packaging

\`\`\`powershell
npm run check
npm test
npm run dist:win
\`\`\`

GitHub Actions runs syntax checks, automated tests and a Windows NSIS installer build for pull requests. Passing automated checks does not replace a manual Windows smoke test of OAuth, polling, approvals and result publication.

- Development repository: https://github.com/hashin9973-ux/idk
- Mailbox branch instructions: [bridge/README.md](https://github.com/hashin9973-ux/idk/blob/bridge-mailbox/bridge/README.md)
- Build workflow: https://github.com/hashin9973-ux/idk/actions
- Test/release plan repository: https://github.com/hashin9973-ux/qdqwg
