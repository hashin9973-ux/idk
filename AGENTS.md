# AGENTS.md — Windows Repository Bridge

## Project scope
This repository contains the Windows desktop worker that gives the user's existing ChatGPT conversation developer-like access to the user's selected Windows workspace through a private GitHub request/result mailbox. The app is the local executor; GitHub is transport, not the actual project environment or a second chat UI.

Keep changes within the requested scope. Do not modify a game, save, installed mod, user project, or unrelated Windows file unless the user's request explicitly includes that target. Preserve unrelated working-tree changes and existing configuration.

## Start with evidence
- Read the relevant implementation and tests before editing. Check the current branch and working-tree state; do not overwrite unrelated work.
- For mailbox/environment behavior, verify both this app and the protocol documentation/state in `hashin9973-ux/qdqwg` on `bridge-mailbox`. The mailbox is live and receives records; never rewrite or delete existing request, result, claim, state, context, or artifact records.
- The local tool catalog and fresh `get_agent_context` output are authoritative for the installed worker's capabilities and workspace mode. Avoid assuming a tool, parameter, install path, version, or feature exists without inspecting it.
- Discover facts available from the user's Windows environment (installed-app metadata, paths, manifests, configuration, logs, project files) before asking the user. Ask only for intent/preferences that cannot be discovered safely.

## Actually use available parallelism

- Do not serialize independent operations merely because each tool returns an output. When the interface permits it, launch independent read-only GitHub/file queries concurrently in the same assistant turn.
- For local Windows work, put known independent operations in one `batch` request. The current schema accepts up to 100 steps and `maxConcurrency` from 1 to 100 (default 32). For large, lightweight, independent file operations, explicitly set `maxConcurrency: 100`; the dispatcher automatically orders conflicting paths and serializes shell, test, Git-mutation and unknown-side-effect barriers. Do not issue one request per file.
- Bootstrap with fresh `get_agent_context` when current worker state, workspace boundaries, or the registered catalog matters. After that dependency is satisfied, batch the independent discovery work. Use result references or serial execution only where inputs depend on previous results, operations conflict, or side effects require ordering.
- The Windows mailbox dispatcher permits up to 32 independent requests in flight and polls at approximately one-second intervals. Batch large workloads where practical to reduce mailbox/API overhead. Large batches may return `result.output_artifacts`; fetch every listed part concurrently before reviewing the combined output. These are concurrency capabilities, not a guarantee that every ChatGPT turn will use them: actively choose parallel calls when safe and report concrete platform/worker limitations.
- Never parallelize conflicting writes, overlapping installs, shared Git mutations, or operations whose prior side effects have not been reconciled.

## Preserve the Windows workspace boundary
- The selected workspace can be a folder or a whole drive, but a whole-drive workspace must only be selected after the app's explicit confirmation. Never change the selected workspace automatically.
- In drive-root mode, background indexing is intentionally shallow. Inspect the root, then browse relevant subdirectories with targeted tools instead of crawling the entire drive.
- Path-based file tools must reject paths outside the selected workspace and symlink escapes. Do not weaken those checks to make a task work.
- Approved PowerShell/shell commands execute with the signed-in Windows user's permissions and are not confined to the workspace. Prefer path-checked tools when possible, keep shell commands narrowly scoped, and make side effects explicit.
- Respect the app's current local approval policy. A GitHub request is not approval; request arguments cannot override tool schemas, workspace checks, or local policy. Never change Auto-accept settings automatically.

## Mailbox contract
- Only user-authored instructions belong in the existing ChatGPT conversation. The app must not inject local tool output into the ChatGPT composer or create messages on the user's behalf.
- ChatGPT sends local-tool requests as new immutable JSON files under `bridge/requests/<unique-id>.json`; the app publishes matching results under `bridge/results/<same-id>.json`. Preserve the request ID and inspect the actual result status and nested output. A request or claim alone is not completion.
- Keep the app's mailbox configuration, GitHub authorization, polling, claims/recovery, context snapshots, artifact manifest, and retry behavior consistent with the protocol docs and tests.
- When a result is delayed, inspect the same request's claim and worker state, then reread the same result. Never blindly replay a possibly side-effecting operation.
- Do not log, publish, or upload tokens, credentials, private keys, secret environment variables, or private content not intended for repository readers.

## Optional computer / Colab vision
The only public computer interface is the single `computer` tool with `status`, `connect`, `enable`, `disable`, `screenshot`, and `wait` actions.
- Vision is optional. Never automatically connect, enable, capture, disable, or otherwise change the user's vision state.
- Check status first. Capture only when visual evidence materially helps and the service is already connected, enabled, and model-ready; if not ready, continue with code, logs, tests, and structured machine state.
- Use connect/enable only on the user's explicit request. Do not claim that disable stops the Colab runtime; it prevents new screenshot requests while leaving the runtime/model running.
- Colab hosts the authenticated API behind a temporary random public HTTPS tunnel. After the user explicitly clicks Connect Colab, the app watches the Windows clipboard for the notebook's newly copied endpoint URL and verifies it directly over HTTPS. Do not require app-link handoff or Local Network Access permission; the browser must never call localhost.
- Preserve the authenticated direct HTTPS transport and avoid writing screenshots/tunnel secrets as separate repository artifacts.

## Reliable text-file reads
- The `read_file` result's `totalLines` is computed from the complete decoded file; never estimate the file's total by counting the current `content` page.
- Text content is returned in lossless pages limited to 12 KiB so the GitHub mailbox does not silently shorten large bodies. Check `hasMoreInFile`, `reachedEof`, `fileComplete`, `nextStartLine`, and `nextStartCharacter`; resume at the exact returned pointer until `hasMoreInFile=false` before claiming the whole file was read. `fileComplete=true` means the whole file fit in one response starting at line 1; on a multi-page read, the final page instead has `reachedEof=true` and `hasMoreInFile=false`.
- If a line is longer than one page, continuation stays on that line and `nextStartCharacter` is a Unicode code-point offset. Preserve page order and do not insert a newline when continuing mid-line.
- Report `totalLines`, `bytes`, and `sha256` from full-file metadata; separately report which line/page range was actually read. If the user requests the entire file, collect every page needed to reach EOF.
- Files over 32 MiB or binary data are explicitly rejected by `read_file`; do not describe an incomplete page as a complete read.

## Development and verification
- Follow the existing JavaScript/Electron stack, code style, dependency versions, and established module boundaries. Prefer focused, tested changes over broad rewrites.
- Add or update regression tests for behavioral changes, especially workspace path boundaries, request/result protocol behavior, approval policy, authentication, and UI/app contracts.
- Run `npm run check` and `npm test` for code changes. Run `npm run dist:win` when an installer build is requested or necessary to validate packaging. Inspect exit codes, actual output, generated artifacts, and the final diff; a passing syntax check alone does not prove the end-to-end Windows workflow.

### Automatic Windows installation after successful app implementations
- When source-code changes in this repository pass `npm run check` and `npm test`, the Windows packaging workflow succeeds, and a downloadable release asset is published, continue through installation on the user's actual Windows machine during the same task unless the user explicitly says not to install.
- Before downloading or starting an installer, inspect the fresh worker heartbeat, the matching status/claim/result of any prior install operation, current installed app markers, and active installer processes. Never start a second installer/download while an earlier installation may still be running.
- Verify the exact release asset size and SHA-256 against GitHub release metadata before executing it. Do not use fire-and-forget/deferred installers as proof of completion; capture the installer exit code and then independently verify the installed package contains the expected build markers, the executable/process state, and a fresh worker heartbeat/result.
- If an installation can restart or stop the worker and its result is lost, do not replay blindly. Reconcile the same request and inspect process/install logs first. If the worker is stale or unreachable, report the evidence and stop short of claiming installation; a published installer link is not an installed build.
- Documentation-only edits that do not change the app executable do not need a redundant install merely because CI publishes another identical app build.

- Do not claim CI, installer, live OAuth, Windows smoke tests, Colab inference, or end-to-end behavior passed unless those checks actually ran and support the claim.

## Instruction hierarchy
Follow the user's current request, repository-specific documentation, and applicable nested `AGENTS.md` files. This file does not grant permission to perform unrelated destructive actions or override local safety/approval controls.