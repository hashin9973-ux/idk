# Architecture and milestones

## Data flow

1. ChatGPT may emit a task in a fenced redbridge code block.
2. The extension content script detects that block and adds a Review task button. Detection is a convenience; DOM integration may need adjustment as ChatGPT's UI changes.
3. The user reviews the JSON and clicks Execute on Windows. No task executes merely because text appeared in a conversation.
4. The extension service worker calls the registered Chrome/Edge Native Messaging host.
5. The Python companion validates the schema and performs one supported operation inside the configured workspace.
6. The companion returns a structured result. The extension displays it and offers Insert result into ChatGPT. By default, the user reviews and submits the report. An opt-in popup setting can auto-submit a returned report when the composer is empty; it never approves the next Windows task.
7. ChatGPT can then reason from the actual result and request another iteration.

## Process execution model

The bridge never concatenates a model-produced command string or launches a process with shell=True. Alongside health, list_files, read_file, write_file, and run_pytest, the host supports run_process: a user-approved executable plus an array of argument strings. The selected working directory must remain inside the configured workspace. Process duration and retained stdout/stderr are bounded, and timed-out process trees are terminated where supported.

This is still powerful: an approved executable can itself be a shell or script interpreter, and its arguments can execute code. The process runs with the current Windows user's permissions and is not sandboxed to the configured workspace; it may read or change files elsewhere. Only the process working directory is constrained. The extension displays the executable and arguments for review, but the user must inspect them carefully. Use a disposable workspace and do not approve opaque or unexpected tasks. run_pytest is a convenience operation for Python test runs.

## Local setup

See windows/README.md and run windows/install.ps1 from a PowerShell terminal after loading the unpacked extension. The installer copies the host into LocalAppData and registers it for the selected browser. The extension ID must match the one shown by the browser.

## Security boundaries

- Host manifest grants Native Messaging to one exact extension ID.
- Companion workspace root is selected locally and is not supplied by task JSON.
- Paths are resolved and checked to remain inside that root, including symlink resolution.
- Unknown operations and extra keys are rejected.
- Task and file sizes are bounded; test runtime and retained output are bounded.
- Workspace reads/writes, test execution, and process launches require a visible user gesture in the extension.
- The extension inserts results into the composer by default; optional auto-submit is off by default, skips non-empty drafts, and never approves the next task.
- The companion uses no GitHub token and never treats a public GitHub repo as an executable command queue.
- Initial support is text-file oriented; do not use it for secrets or sensitive workspaces.

This is a security-conscious prototype, not a hardened remote administration product. Review before using on valuable workspaces.

## Milestones

### M1 — local vertical slice
- Extension detects reviewed task blocks.
- Native host supports bounded file operations and approved process execution, returning real results.
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
