# Architecture and milestones

## Data flow

1. ChatGPT may emit a task in a fenced redbridge code block.
2. The extension content script detects that block and adds a Review task button. Detection is a convenience; DOM integration may need adjustment as ChatGPT's UI changes.
3. The user reviews the JSON and clicks Execute on Windows. No task executes merely because text appeared in a conversation.
4. The extension service worker calls the registered Chrome/Edge Native Messaging host.
5. The Python companion validates the schema and performs one supported operation inside the configured workspace.
6. The companion returns a structured result. The extension displays it and offers Insert result into ChatGPT. The user reviews and submits the report; the extension does not auto-send messages.
7. ChatGPT can then reason from the actual result and request another iteration.

## Why not shell commands?

Arbitrary command execution from model-produced text is too broad for an initial bridge. The first host supports only health, list_files, read_file, write_file, and run_pytest. Tests themselves are code execution and therefore still require explicit user approval. run_pytest uses the current Python interpreter and -m pytest, without a shell, and limits duration/output.

## Local setup

See windows/README.md and run windows/install.ps1 from a PowerShell terminal after loading the unpacked extension. The installer copies the host into LocalAppData and registers it for the selected browser. The extension ID must match the one shown by the browser.

## Security boundaries

- Host manifest grants Native Messaging to one exact extension ID.
- Companion workspace root is selected locally and is not supplied by task JSON.
- Paths are resolved and checked to remain inside that root, including symlink resolution.
- Unknown operations and extra keys are rejected.
- Task and file sizes are bounded; test runtime and retained output are bounded.
- File reads/writes and test execution require a visible user gesture in the extension.
- The extension inserts results into the composer but does not automatically submit them.
- The companion uses no GitHub token and never treats a public GitHub repo as an executable command queue.
- Initial support is text-file oriented; do not use it for secrets or sensitive workspaces.

This is a security-conscious prototype, not a hardened remote administration product. Review before using on valuable workspaces.

## Milestones

### M1 — local vertical slice
- Extension detects reviewed task blocks.
- Native host supports narrow operations and returns real results.
- Path, request, output, and timeout limits.
- Unit tests for validation and path handling.

### M2 — workflow ergonomics
- Better ChatGPT DOM adapters, operation previews, diff display, result insertion.
- Backup/diff workflow for writes and richer test configurations.
- Structured project capability discovery.

### M3 — semi-automatic iterations
- Explore a reliable task/result relay that does not depend on fragile page automation.
- Add queue leases, replay protection, authorization policy, and a durable audit log.
- Keep the user able to pause, inspect, and revoke access.
