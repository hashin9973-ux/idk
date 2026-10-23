# ChatGPT Windows Bridge

Early implementation of a local Windows companion and browser extension intended to let an existing ChatGPT conversation request constrained local work and receive real execution results.

## Current milestone

1. A Chrome/Edge extension page connects to a registered Windows Native Messaging host.
2. The host supports a small set of explicit operations inside a configured workspace.
3. Each request that reads file contents, writes a file, or starts a test process requires a visible user action in the extension.
4. Results include status, exit code where relevant, and bounded stdout/stderr; the UI can copy a report into the active ChatGPT conversation.
5. Broader page integration and automated iteration come after the local protocol is proven.

## Security baseline

- Never execute arbitrary shell text from a prompt or repository file.
- Use argument arrays and `shell=False`; no command-string evaluation.
- Constrain paths to the configured workspace and reject traversal.
- Bound request sizes, file sizes, output sizes, and process duration.
- Do not commit API tokens, private file contents, or runtime logs.
- A commit is not proof that a Windows action ran. Trust only a local execution result.

See `docs/architecture.md`, `docs/protocol.md`, and `windows/README.md`.