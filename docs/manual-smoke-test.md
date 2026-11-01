# Manual Windows Smoke Test

This test verifies the real OneDrive-to-Windows-to-OneDrive synchronization path. Temporary-folder tests and GitHub CI cannot prove device-level synchronization.

## Before starting

- Install/start the Windows Bridge app.
- Confirm the OneDrive client is signed in and the existing Bridge folder is hydrated locally.
- In app settings, select the existing local OneDrive-synchronized Bridge folder itself, not the OneDrive root and not a runtime subfolder.
- Confirm the mailbox root contains only AGENT.md, TOOLS.md, STATUS.md, SCREEN.md and the five permitted folders: request, claims, result, messages and sandbox storage.
- Do not delete or recreate Bridge/raw or unrelated OneDrive content.

## 1. Verify mailbox initialization

The app should initialize only the five permitted folders. It must not create runtime, bridge, context, state, agents, sessions, tasks, projects, vision, artifacts or docs subfolders. STATUS.md should show a fresh worker heartbeat and the selected workspace. TOOLS.md should be generated from the actual registered worker catalog. AGENT.md should describe the same flat structure. SCREEN.md should clearly say Observe is disabled or show a fresh observation.

## 2. Bootstrap a session through OneDrive

Create a new globally unique request ID and publish this immutable JSON request:

- Path: Bridge/request/agent-000/<request-id>.json
- protocol: chatgpt-local-repo-bridge/v1
- request_id: the generated request ID
- created_at: current UTC timestamp
- tool: session_start
- args: {}

Do not include a session_id in the bootstrap request. Wait for the matching claim and result:

- Bridge/claims/agent-000/<request-id>.json
- Bridge/result/agent-000/<request-id>.json

Verify the result is completed and contains the app-generated session_id and agent_id. The session ID must be opaque; ChatGPT must not generate it. Verify the app's local persistent settings contain the session/agent registry and that no session records or tombstones were created in OneDrive.

## 3. Execute a read-only Windows request

Use the returned agent_id and session_id. Publish a new immutable request under Bridge/request/<agent-id>/<request-id>.json. Include the exact session_id at the top level, a fresh request_id, created_at, tool=environment_info, and args={}.

Wait for matching files under Bridge/claims/<agent-id>/ and Bridge/result/<agent-id>/. Confirm the result reports the Windows host environment and the matching request ID. Verify that no execution occurred in OneDrive or on GitHub Actions.

## 4. Verify artifacts and approvals

Request a small workspace file read, then a bounded output artifact if supported. Confirm agent-specific artifacts are written only under Bridge/sandbox storage/<agent-id>/. Test an approval-gated operation and verify that the native Windows approval prompt appears unless the user explicitly enabled the app's auto-accept setting.

## 5. Verify messages and multiple agents

Start a second agent through its own session_start request in request/agent-000/ with a fresh request ID. Verify it receives a distinct app-issued agent_id/session_id. Send an agent-to-agent message and a user-to-agent message. Confirm records are stored under messages/<recipient-agent-id>/ and read receipts use the .read.json suffix.

## 6. Verify lifecycle and Observe

Test pause, resume, disconnect, revoke, delete and optional mailbox wipe. Confirm session authority remains local, there is no time-based expiration, and the 10,000-session cap evicts the oldest last-activity session only when required.

Enable Observe and verify SCREEN.md updates with window/control/text context, timestamps and freshness. Confirm no private screenshot bytes, tunnel credentials or password field values are published. Disable Observe and verify SCREEN.md explicitly reports disabled/no current frame.

## Acceptance criteria

- Only the four root Markdown files and five allowed folders exist at the Bridge root.
- Request, claim and result records are partitioned by agent and match request IDs.
- Session IDs are generated and persisted by the Windows app, not OneDrive.
- STATUS.md, SCREEN.md, AGENT.md and TOOLS.md are maintained by their owning app services.
- The Windows app executes tools locally and preserves approval, workspace, path and symlink protections.
- A real request and matching result synchronize in both directions through the user's OneDrive client.
