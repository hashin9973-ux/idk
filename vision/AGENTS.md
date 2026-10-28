# AGENTS.md — Colab vision subsystem

These instructions apply to files in `vision/`, especially `vision_worker.ipynb`. Follow the root `../AGENTS.md` for overall architecture, workspace and approval boundaries, coding conventions, and verification.

## Purpose and boundaries
The Colab notebook is the authenticated visual-analysis backend for the Windows computer tool. It should minimize time to the first useful visual report, return coordinate-aware concise output, keep the model warm when the runtime stays alive, and avoid unrelated repository/mailbox changes.

## Connection and model lifecycle
- After the Windows app authenticates the temporary public endpoint, the notebook's registration acknowledgement itself enables vision and starts background model loading. The app also calls `/activate` as an idempotent confirmation; a crash between these requests must not leave the model idle. Do not require a second manual `computer(action=enable)` call after a successful connection.
- Distinguish tunnel connected, model loading, both required model roles ready, detailed inference in progress, passive inference in progress, inactive (explicitly disabled), and errors. Readiness requires SmolVLM2 confirmed GPU-resident and the parked Qwen alias confirmed CPU-only via Ollama `/api/ps`; report Linux swap availability separately. The original Qwen GPU instance is optional outside a detailed request and should unload after that request.
- Use a random in-memory bearer key in the endpoint path plus the Authorization header. Keep the full endpoint ephemeral and private; never persist it to mailbox files/logs/settings, commit it, print it to request/result records, or ask the user for GitHub credentials or Colab Secrets.
- Clipboard detection is convenience only; manual paste must use the same strict HTTPS URL validation, health check, and registration acknowledgement. Do not use app URI handoff, browser-to-localhost calls, or require Local Network Access permission.

## Fast visual context
- Prefer concise responses with actionable pixel-coordinate boxes and center points; include the screenshot frame dimensions from the desktop service. Use confidence/uncertainty for ambiguous targets rather than claiming pixel-perfect model perception.
- Keep the captured desktop frame at its original pixel dimensions throughout capture and transfer; reduce JPEG quality rather than spatially downscaling. Keep the JSON-encoded image under the direct HTTPS request limit and fail explicitly if it cannot fit. Use the existing 16,384-token context for detailed Qwen and the 8,192-token passive context for SmolVLM2. The health/status payload must expose both context sizes, passive-model state, parked/detailed-Qwen state, and actual swap availability. Match request ID, screenshot SHA-256 and frame ID, and do not duplicate inference when a job is pending. Note that each model's own image processor may internally resize or patch images.
- Use the prebuilt Ollama runtime; do not build llama.cpp from source or mount Google Drive for model storage. Download `qwen3-vl:4b-instruct` for detailed analysis and `richardyoung/smolvlm2-2.2b-instruct:Q4_K_M` for passive GPU analysis to the temporary `/content/ollama-models` cache. Record the resolved model names and digests in runtime diagnostics. Keep a separate CPU-only Qwen alias alive between requests, while loading the original Qwen model for detailed work and requesting unload afterward. Attempt a 4 GiB Linux swap file only when disk, filesystem and permissions allow; expose the observed `/proc/swaps` state and reason if activation fails. Never report the model pair ready without verifying actual placement via Ollama `/api/ps`.
- The Colab notebook performs visual inference and speech synthesis only. Mouse/keyboard input is executed locally by the Windows app and never sent to Colab.
- Expose vision_worker_api_version and the complete feature list on /health. The app must reject older runtimes before sending screenshots or speech, with a clear instruction to interrupt and rerun the updated cell.
- Keep Piper en_US-libritts-high loaded as a persistent CPU voice object. Its authenticated /tts endpoint only synthesizes audio; Windows is responsible for playback. Use speaker ID 0, validate the voice and request ID, return WAV bytes with SHA-256 metadata, and never publish audio bytes or credentials to the GitHub mailbox.
- TTS setup is independent of vision readiness: a failed Piper install/download must leave SmolVLM2/Qwen vision available and publish an explicit tts_error, then retry with bounded backoff.

## Passive Observe feed versus Colab vision

- Do not make passive Observe reads wait on context refresh or this Colab service. The app's passive `bridge/vision/observe.json` feed is independent of this Colab service. If Observe is already enabled and fresh, ChatGPT should read it directly before screen interaction; it should not call Colab status/screenshot just to get a live window/control state.
- Use SmolVLM2 for asynchronous passive enrichment of the newest changed Observe frame and Qwen for explicitly requested detailed analysis. Both receive the full-resolution frame at the desktop/HTTPS boundary, although model-side preprocessing may resize or patch it. Keep passive capture independent of model inference and status calls; preserve exact frame identity for coordinate validation.
- For rapid interaction, do not run detailed Qwen inference after every local input by default. Batch predictable adjacent inputs in one sequence; when feedback is needed, read the next enriched passive Observe frame and pass its exact `frame_id` with coordinate input. Set `observe=true` only when a detailed Qwen report itself is needed for the next decision.
- Never claim that passive Observe supplied pixel-level text/scene understanding; keep uncertainty and source provenance explicit.

## Security and user control
- The user explicitly asked for automatic activation after connecting Colab; do not auto-launch Colab or create a public tunnel without an explicit connect request.
- `disable` prevents new screenshot analysis but does not shut down the runtime or unload a loaded model.
- Do not add screenshots or tunnel secrets as GitHub artifacts. Only the corresponding analysis report returns through the normal matched computer tool result.

## Notebook integrity and verification
- Preserve valid Jupyter notebook JSON and code-cell source representation; clear saved cell outputs so a short-lived endpoint never leaks into the repository.
- Run `npm run check` and `npm test`, and verify the Python source embedded in notebook code cells compiles. Distinguish static verification and CI from a live Colab GPU/inference test.
- Do not claim a live tunnel, GPU, model load, inference, or end-to-end screenshot worked unless directly tested.
