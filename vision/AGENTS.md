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
- Keep screenshot size under the existing direct HTTPS request limit. Use a shorter generation budget and set Ollama `num_ctx` to 16,384 tokens (`VISION_CONTEXT_TOKENS = 16384`) so the rich screenshot prompt and structured desktop metadata fit. The health/status payload must expose `context_window_tokens`. Preserve request ID and screenshot SHA-256 matching, and do not send duplicate inference when a job is pending.
- Do not compile llama.cpp in a Colab runtime. Download the pinned official `ggml-org/llama.cpp` CUDA 12.8 release archive `cudart-llama-b11913-bin-ubuntu-cuda-12.8-x64.tar.gz`, verify SHA-256 `be951a4cb7885562b4df07e7652a897ebfac3b95f4e0434c68ac99302e4f613e`, and cache the compressed archive on the existing Google Drive model cache. Extract it to local `/content` storage for execution; check the executable's required CLI flags and resolve bundled shared libraries. `nvcc`, CMake, and a source checkout are not prerequisites. Fail clearly if download/checksum/extraction/CLI validation fails.
- The notebook only performs visual inference. Mouse/keyboard input is executed locally by the Windows app and never sent to Colab.

## Passive Observe feed versus Colab vision

- Do not make passive Observe reads wait on context refresh or this Colab service. The app's passive `bridge/vision/observe.json` feed is independent of this Colab service. If Observe is already enabled and fresh, ChatGPT should read it directly before screen interaction; it should not call Colab status/screenshot just to get a live window/control state.
- Use this subsystem when actual screenshot pixels, OCR, visual interpretation or image-grounded coordinates are needed and the user's intent permits the Colab visual path. Keep status/connect/model-readiness checks outside the ordinary passive Observe loop.
- For rapid interaction, do not run a Colab inference after every local input by default. Batch only predictable adjacent inputs in one sequence; when feedback is needed, let the assistant read the next passive Observe frame. Set the sequence's `observe=true` only when the Colab analysis result itself is required for the next decision.
- Never claim that passive Observe supplied pixel-level text/scene understanding; keep uncertainty and source provenance explicit.

## Security and user control
- The user explicitly asked for automatic activation after connecting Colab; do not auto-launch Colab or create a public tunnel without an explicit connect request.
- `disable` prevents new screenshot analysis but does not shut down the runtime or unload a loaded model.
- Do not add screenshots or tunnel secrets as GitHub artifacts. Only the corresponding analysis report returns through the normal matched computer tool result.

## Notebook integrity and verification
- Preserve valid Jupyter notebook JSON and code-cell source representation; clear saved cell outputs so a short-lived endpoint never leaks into the repository.
- Run `npm run check` and `npm test`, and verify the Python source embedded in notebook code cells compiles. Distinguish static verification and CI from a live Colab GPU/inference test.
- Do not claim a live tunnel, GPU, model load, inference, or end-to-end screenshot worked unless directly tested.
