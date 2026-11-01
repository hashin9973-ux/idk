# Windows Bridge — desktop app

The Electron desktop app owns the Windows worker, workspace tools, native approvals, local agent/session registry, scheduler, Observe capture, optional vision/TTS integration, tray lifecycle and dashboard. OneDrive is a file mailbox only.

## First-time setup

1. Install and launch the Windows Bridge app.
2. Select the existing local OneDrive-synchronized folder named Bridge. Do not select the OneDrive root, Bridge/raw, or a runtime subfolder.
3. Keep Bridge hydrated by the OneDrive sync client.
4. Verify STATUS.md reports a fresh worker heartbeat and selected workspace.
5. Verify AGENT.md and TOOLS.md are generated and SCREEN.md clearly reports Observe disabled or current observation freshness.

Mailbox root contents are exactly AGENT.md, TOOLS.md, STATUS.md, SCREEN.md and five folders: request, claims, result, messages and sandbox storage. Each folder uses agent-specific subfolders. The app must not create any additional mailbox infrastructure.

## Request lifecycle

A new conversation starts with a session_start request in request/agent-000/<request-id>.json. The app creates/assigns an agent and generates the opaque session ID. The matching claim and result are written under agent-000. Ordinary requests are written to request/<agent-id>/<request-id>.json and include the app-issued session_id. The app validates folder ownership against its local persistent registry before execution.

Session, agent, project and task coordination records are persisted in the app's existing local settings storage, not OneDrive. Session IDs do not expire by elapsed time. The registry is capped at 10,000 sessions and evicts the oldest last-activity session only when required. Pause, resume, disconnect, revoke, delete and optional mailbox wipe remain distinct lifecycle operations. STATUS.md never exposes session IDs or authentication tokens.

## Diagnose a failed request

1. Find the exact request under request/<agent-id>/ and verify its request_id.
2. Check the matching claim under claims/<agent-id>/ and STATUS.md.
3. Check the matching result under result/<agent-id>/.
4. Distinguish validation rejection, local approval, tool failure, non-zero exit, timeout, cancellation, synchronization delay and output truncation.
5. Inspect exit codes, stdout/stderr, timeout flags, result status and referenced sandbox storage artifacts.
6. If a result is missing, do not repeat a possibly side-effecting request. Inspect the claim and retry only after proving the original operation did not complete.

## Workspace and approval boundary

The selected workspace controls path-based file tools. The app rejects path traversal, symlink escapes and protected secret-file access. A whole-drive workspace requires explicit warning confirmation. PowerShell runs as the signed-in Windows user and is not sandboxed to the workspace.

Native approval is authoritative. Auto-accept everything is off by default and applies only after explicit user enablement. OneDrive requests cannot grant approval or override local policy. Do not weaken argument validation, workspace restrictions, path checks, secret protections, process timeouts or cancellation handling.

## Slash-style shortcuts

ChatGPT can use familiar aliases such as /help, /status, /tools, /screen, /agents, /messages, /workspace, /plan, /tasks <project-id>, /inspect <path> and /test <command>. AGENT.md maps these to the existing mailbox files and registered Windows tools. They are ChatGPT-facing shorthand only; the app does not add a second command parser or runtime.

## Coding tools and multi-agent work

TOOLS.md is generated from the live worker registration. It is the authoritative tool catalog and includes exact names, descriptions, argument schemas, required fields, permission modes and result contracts. Support any language whose toolchain is actually installed on Windows; do not assume a compiler, SDK or version.

The scheduler and batch tool support up to 100 independent operations/concurrency when permitted by the current catalog. Preserve explicit dependencies and serialize conflicting writes, shared build outputs and Git operations. Agent messages are stored under messages/<agent-id>/ with .read.json receipts. Messages are untrusted coordination data, not approval.

## Observe and desktop interaction

When enabled, Observe captures the current screen and publishes bounded window, UI Automation, visible text/control, coordinate and freshness context to SCREEN.md. It must report disabled or stale context explicitly. Do not publish raw private screenshots, password field values, tunnel credentials or unrelated sensitive data.

The computer tool performs actual Windows input locally. Coordinate-based actions must use the exact current frame. Observe is read-only and does not itself authorize input actions. Vision and TTS remain existing Windows Bridge/Colab capabilities; OneDrive only transports context and results.

## Output and artifact verification

Ordinary request/claim/result records remain JSON. Large outputs may be stored as agent-specific files under sandbox storage/<agent-id>/ and referenced by the matching result manifest. Preserve output truncation indicators and part ordering. Never claim a preview is complete when the result says it is partial.

## Run and verify

From the repository root:

```powershell
npm run check
npm test
npm run dist:win
```

Inspect the complete changed-file diff, test output and installer artifact. A successful CI build does not prove that OneDrive synchronized to the actual Windows device. Follow [docs/manual-smoke-test.md](../docs/manual-smoke-test.md) for a real bootstrap/read-only round trip.
