# AGENTS.md — Colab vision subsystem

These instructions apply to files in `vision/`, especially `vision_worker.ipynb`. Follow the root `../AGENTS.md` for overall app architecture, workspace and approval boundaries, coding conventions, and verification.

## Purpose and boundaries
The notebook provides optional visual evidence to the Windows Repository Bridge; it is not the default path for file discovery or debugging. Use source, logs, tests, and structured environment results first. Vision is useful only when visible UI or graphical state materially affects the task.

## Preserve the connection architecture
- Keep the desktop app's ChatGPT-facing surface as one `computer` tool with actions `status`, `connect`, `enable`, `disable`, `screenshot`, and `wait`. Do not reintroduce exposed legacy `vision_*` actions.
- Colab hosts the authenticated API behind a temporary random Cloudflare HTTPS tunnel. The notebook displays and copies a single endpoint URL whose path contains the ephemeral high-entropy access key. After the user clicks Connect Colab, the Windows app watches the clipboard for a changed `https://*.trycloudflare.com/<secret>` endpoint and verifies it over authenticated HTTPS. The notebook attempts to copy automatically and provides a Copy endpoint fallback if browser clipboard write is blocked. Do not use app URI handoff, pairing codes, browser-to-localhost calls, or require Local Network Access permission. Do not ask users to paste a GitHub token or Colab Secret.
- Keep tunnel credentials ephemeral and high-entropy. The endpoint URL itself is a temporary bearer capability: show it only in the user's active Colab cell output and clipboard, never write it to repository files, request/result records, logs, saved settings, or other artifacts. Expose only the required health/control/analysis endpoints.
- Screenshots go directly to the authenticated Colab service. Do not add a separate GitHub screenshot artifact or commit screen contents to the mailbox. Only the returned report travels through the normal matched tool result.

## User-controlled vision state
- Never connect, enable, screenshot, disable, load a model, mount a drive, or trigger multi-gigabyte model downloads automatically.
- `status` is the read-only readiness check. Capture only after an explicit visual request or a task where visual evidence materially helps, and only when the Colab service is connected, vision is enabled, and the model is ready.
- `connect` may open Colab but does not load the model. `enable` is a user-controlled, potentially expensive setup step and may mount Google Drive/download model weights. Use connect/enable only when the user explicitly asks.
- `disable` prevents new screenshot requests; it must not unexpectedly terminate Colab, unload the model, or change other runtime state.
- If inference is pending, preserve its request ID and resume with `wait`; never duplicate a screenshot because the first response is delayed.

## Notebook integrity and verification
- Preserve valid Jupyter notebook JSON and code-cell source representation. Keep the desktop app's notebook validation passing.
- Inspect the existing notebook cells and matching desktop service/tests before changing protocol names, dependencies, model settings, paths, or runtime lifecycle.
- After changes, run the root repository's `npm run check` and `npm test`; add regression coverage for desktop-side contract changes. Clearly distinguish local syntax/contract checks from a live Colab GPU/inference test.
- Do not claim a live connection, model load, GPU availability, inference, or end-to-end screenshot worked unless it was actually exercised and the result supports that claim.