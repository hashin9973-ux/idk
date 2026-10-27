# AGENTS.md — Colab vision subsystem

These instructions apply to files in `vision/`, especially `vision_worker.ipynb`. Follow the root `../AGENTS.md` for overall architecture, workspace and approval boundaries, coding conventions, and verification.

## Purpose and boundaries
The Colab notebook is the authenticated visual-analysis backend for the Windows computer tool. It should minimize time to the first useful visual report, return coordinate-aware concise output, keep the model warm when the runtime stays alive, and avoid unrelated repository/mailbox changes.

## Connection and model lifecycle
- After the Windows app authenticates the temporary public endpoint, the notebook's registration acknowledgement itself enables vision and starts background model loading. The app also calls `/activate` as an idempotent confirmation; a crash between these requests must not leave the model idle. Do not require a second manual `computer(action=enable)` call after a successful connection.
- Distinguish tunnel connected, model loading, model ready, inference in progress, inactive (explicitly disabled), and errors. Never report ready until the model and projector are loaded and the local llama-server health check succeeds.
- Use a random in-memory bearer key in the endpoint path plus the Authorization header. Keep the full endpoint ephemeral and private; never persist it to mailbox files/logs/settings, commit it, print it to request/result records, or ask the user for GitHub credentials or Colab Secrets.
- Clipboard detection is convenience only; manual paste must use the same strict HTTPS URL validation, health check, and registration acknowledgement. Do not use app URI handoff, browser-to-localhost calls, or require Local Network Access permission.

## Fast visual context
- Prefer concise responses with actionable pixel-coordinate boxes and center points; include the screenshot frame dimensions from the desktop service. Use confidence/uncertainty for ambiguous targets rather than claiming pixel-perfect model perception.
- Keep screenshot size under the existing direct HTTPS request limit. Use a shorter generation budget and reasonable context size for fast visual state checks. Preserve request ID and screenshot SHA-256 matching, and do not send duplicate inference when a job is pending.
- Cache compiled server binaries/shared libraries and model files on the existing Google Drive cache where safe, then restore the executable to local runtime storage before execution. If cache restoration fails or required server flags are unavailable, fail clearly rather than silently executing an invalid binary.
- The notebook only performs visual inference. Mouse/keyboard input is executed locally by the Windows app and never sent to Colab.

## Security and user control
- The user explicitly asked for automatic activation after connecting Colab; do not auto-launch Colab or create a public tunnel without an explicit connect request.
- `disable` prevents new screenshot analysis but does not shut down the runtime or unload a loaded model.
- Do not add screenshots or tunnel secrets as GitHub artifacts. Only the corresponding analysis report returns through the normal matched computer tool result.

## Notebook integrity and verification
- Preserve valid Jupyter notebook JSON and code-cell source representation; clear saved cell outputs so a short-lived endpoint never leaks into the repository.
- Run `npm run check` and `npm test`, and verify the Python source embedded in notebook code cells compiles. Distinguish static verification and CI from a live Colab GPU/inference test.
- Do not claim a live tunnel, GPU, model load, inference, or end-to-end screenshot worked unless directly tested.
