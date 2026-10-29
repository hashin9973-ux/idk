#!/usr/bin/env python3
"""Validate the executable code and architecture assumptions in the Colab vision notebook."""

import ast
import json
import math
from pathlib import Path

NOTEBOOK = Path(__file__).resolve().parents[1] / "vision" / "vision_worker.ipynb"


def source_of(cell):
    source = cell.get("source", "")
    return "".join(source) if isinstance(source, list) else str(source)


def validate_context_helpers(code):
    """Execute isolated pure helpers from the notebook to test coordinates without starting Colab."""
    tree = ast.parse(code)
    wanted = {
        "safe_text",
        "normalize_pixel_box",
        "normalize_model_box",
        "normalize_accessibility",
        "analysis_box_from_full_pixels",
        "bounded_image_dimensions",
        "normalized_accessibility_hints",
        "map_model_boxes_to_original",
        "normalize_model_report",
        "build_passive_fallback_report",
        "is_swapfile_layout_error",
        "is_client_disconnect_error",
        "parse_content_length",
        "decode_request_body",
        "read_exact_request_body",
    }
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted]
    found = {node.name for node in nodes}
    missing = wanted - found
    if missing:
        raise SystemExit("FAIL: isolated context helpers missing: " + ", ".join(sorted(missing)))
    namespace = {"math": math, "json": json}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<vision-context-helpers>", "exec"), namespace)

    is_disconnect = namespace["is_client_disconnect_error"]
    parse_content_length = namespace["parse_content_length"]
    decode_request_body = namespace["decode_request_body"]
    read_exact_body = namespace["read_exact_request_body"]

    class ShortBodyReader:
        def __init__(self, payload, piece_size):
            self.payload = payload
            self.piece_size = piece_size
            self.offset = 0

        def read(self, requested):
            size = min(requested, self.piece_size)
            result = self.payload[self.offset:self.offset + size]
            self.offset += len(result)
            return result

    payload = b'{"protocol":"test","text":"complete"}'
    if read_exact_body(ShortBodyReader(payload, 3), len(payload)) != payload:
        raise SystemExit("FAIL: exact HTTP body reader did not tolerate short socket reads")
    try:
        read_exact_body(ShortBodyReader(payload[:-4], 5), len(payload))
    except EOFError as exc:
        if "expected" not in str(exc) or "received" not in str(exc):
            raise SystemExit("FAIL: incomplete-body error omitted expected/received byte counts")
    else:
        raise SystemExit("FAIL: incomplete HTTP body was accepted")
    if not is_disconnect(BrokenPipeError("peer closed")) or not is_disconnect(ConnectionResetError("peer reset")):
        raise SystemExit("FAIL: disconnected-client socket errors were not classified")
    if is_disconnect(ValueError("invalid input")):
        raise SystemExit("FAIL: non-socket errors must not be swallowed as disconnects")

    class HeaderBag:
        def __init__(self, fields):
            self.fields = list(fields)

        def get_all(self, name, default=None):
            values = [value for key, value in self.fields if key.lower() == name.lower()]
            return values if values else default

    parse_cases = [
        ([("Content-Length", "2")], 2),
        ([("content-length", " 0002\t")], 2),
        ([("Content-Length", "2000000")], 2000000),
    ]
    for fields, expected in parse_cases:
        actual = parse_content_length(HeaderBag(fields))
        if actual != expected:
            raise SystemExit(f"FAIL: valid Content-Length {fields!r} parsed as {actual!r}")
    invalid_headers = [
        [],
        [("Content-Length", "2"), ("Content-Length", "2")],
        [("Content-Length", "")],
        [("Content-Length", "0")],
        [("Content-Length", "-1")],
        [("Content-Length", "+2")],
        [("Content-Length", "1.5")],
        [("Content-Length", "٢")],
        [("Content-Length", "2, 2")],
        [("Content-Length", "2"), ("Transfer-Encoding", "chunked")],
        [("Transfer-Encoding", "chunked")],
    ]
    for fields in invalid_headers:
        try:
            parse_content_length(HeaderBag(fields))
        except ValueError:
            pass
        else:
            raise SystemExit(f"FAIL: unsafe or malformed HTTP framing was accepted: {fields!r}")
    for oversized in ("2000001", "999999999999999999999999999999999"):
        try:
            parse_content_length(HeaderBag([("Content-Length", oversized)]))
        except OverflowError:
            pass
        else:
            raise SystemExit(f"FAIL: oversized Content-Length was not rejected: {oversized!r}")
    if decode_request_body(b'{"protocol":"test"}') != {"protocol": "test"}:
        raise SystemExit("FAIL: valid UTF-8 JSON request body could not be decoded")
    for malformed in (b'{"protocol":', b"\xff"):
        try:
            decode_request_body(malformed)
        except ValueError as exc:
            if str(exc) != "Malformed JSON":
                raise SystemExit("FAIL: malformed HTTP body leaked a parser diagnostic")
        else:
            raise SystemExit("FAIL: malformed UTF-8/JSON request body was accepted")
    print("PASS: exact HTTP body reading handles short reads and rejects incomplete uploads")
    print("PASS: strict Content-Length parsing rejects duplicates, invalid numbers, TE framing, and oversized bodies")
    print("PASS: malformed UTF-8/JSON returns a bounded error instead of an uncaught traceback")
    print("PASS: peer disconnect writes are handled without a secondary traceback")

    swap_layout_error = namespace["is_swapfile_layout_error"]
    if not swap_layout_error(1, "swapon: swapfile: swapon failed: Invalid argument"):
        raise SystemExit("FAIL: invalid swapfile layout was not recognized for one dense-allocation retry")
    if swap_layout_error(1, "swapon: Operation not permitted"):
        raise SystemExit("FAIL: permission failures must not trigger repeated 4 GiB allocation")
    if swap_layout_error(0, "Invalid argument"):
        raise SystemExit("FAIL: successful swap activation must not trigger fallback allocation")
    print("PASS: swapfile EINVAL triggers a bounded dense-allocation retry, not permission errors")

    bounded_dimensions = namespace["bounded_image_dimensions"]
    resize_cases = [
        ((1920, 1080, 1280), (1280, 720)),
        ((1280, 720, 1280), (1280, 720)),
        ((720, 1000, 1280), (720, 1000)),
        ((3840, 2160, 1024), (1024, 576)),
    ]
    for args, expected in resize_cases:
        actual = bounded_dimensions(*args)
        if actual != expected:
            raise SystemExit(f"FAIL: bounded image dimensions {args} -> {actual}, expected {expected}")
    try:
        bounded_dimensions(0, 1080, 1280)
    except ValueError:
        pass
    else:
        raise SystemExit("FAIL: bounded image dimensions accepted zero width")
    print("PASS: model image dimensions fit the edge budget without changing aspect ratio")

    map_boxes = namespace["map_model_boxes_to_original"]
    normalize_report = namespace["normalize_model_report"]
    hints = namespace["normalized_accessibility_hints"]
    fallback_builder = namespace["build_passive_fallback_report"]

    crop_report = {
        "schema_version": "windows-vision-context/v2",
        "scene": {
            "summary": "A dialog is open in the foreground.",
            "active_application": "Test app",
            "window_title": "Test app — Save dialog",
            "screen_type": "dialog",
            "current_state": "The Save dialog is visible.",
            "visible_dialogs": ["Save dialog"],
            "task_relevant_facts": ["A Save button appears inside the dialog."],
            "uncertainties": []
        },
        "regions": [{"id": "r1", "label": "dialog", "purpose": "Primary dialog", "bbox_1000": [0, 0, 1000, 1000]}],
        "text_spans": [],
        "objects": [{"id": "o1", "label": "dialog icon", "category": "icon", "appearance": "small blue square", "color": "blue", "shape": "square", "region_id": "r1", "bbox_1000": [50, 50, 100, 100], "confidence": "high"}],
        "controls": [{
            "id": "c1", "label": "Save", "role": "button", "region_id": "r1",
            "bbox_1000": [250, 250, 500, 500], "state": "enabled",
            "relation": "Inside the Save dialog", "targetability": "clear"
        }],
        "focused_element": None,
        "cursor": {"visible": False, "bbox_1000": None, "location": "not visible"}
    }
    map_boxes(crop_report, 1000, 500, [400, 150, 800, 350])
    accessibility = {
        "available": True, "source": "windows_uia", "truncated": False, "node_count": 2,
        "active_window": {"title": "Test app — Save dialog", "process_id": 7,
                          "bbox_px": [0, 0, 1000, 500], "bbox_1000": [0, 0, 1000, 1000]},
        "focused_control": None,
        "controls": [{
            "id": "uia-1", "label": "Save", "role": "Button", "enabled": True, "focused": False,
            "bbox_px": [500, 200, 600, 250], "bbox_1000": [500, 400, 600, 500]
        }]
    }
    ocr = {"available": True, "method": "tesseract", "reason": None, "text_spans": []}
    local_hints = hints(accessibility, 1000, 500, [400, 150, 800, 350])
    if local_hints["controls"][0]["bbox_1000"] != [250.0, 250.0, 500.0, 500.0]:
        raise SystemExit("FAIL: focused-region accessibility hints were not transformed into crop coordinates.")
    normalized = normalize_report(crop_report, 1000, 500, accessibility, ocr)
    target = normalized["controls"][0]
    if target["coordinate_source"] != "windows_uia" or target["position_verification"] != "accessibility_grounded":
        raise SystemExit("FAIL: matching UI Automation bounds did not replace the visual target coordinates.")
    if target["bbox_px"] != [500, 200, 600, 250] or target["center_px"] != [550.0, 225.0]:
        raise SystemExit("FAIL: crop coordinates did not map to the original frame or the center was not derived from the box.")
    if target["visual_bbox_px"] != [500, 200, 600, 250]:
        raise SystemExit("FAIL: the original visual estimate was not preserved as separate evidence.")
    if normalized["objects"][0]["bbox_px"] != [420, 160, 440, 170]:
        raise SystemExit("FAIL: visual object coordinates were not mapped from the focused crop into the original frame.")

    # Some VLM responses contain the complete expected v2 structure but omit or
    # mislabel schema_version. The notebook may normalize that label only after
    # checking the canonical fields; bounding-box validation must still run.
    schema_drift_report = json.loads(json.dumps(crop_report))
    schema_drift_report["schema_version"] = "windows-vision-context/v1"
    recovered = normalize_report(schema_drift_report, 1000, 500, accessibility, ocr)
    if recovered.get("schema_version") != "windows-vision-context/v2":
        raise SystemExit("FAIL: canonical model structure with a stale schema label was not normalized to v2.")
    if not any("schema label was normalized" in item for item in recovered["scene"]["uncertainties"]):
        raise SystemExit("FAIL: normalization of a model schema label was not disclosed as uncertainty.")

    malformed_schema_report = {
        "schema_version": "unexpected", "scene": {}, "regions": []
    }
    try:
        normalize_report(malformed_schema_report, 1000, 500, accessibility, ocr)
    except RuntimeError as exc:
        if "required scene/region/text/control/object structure was not present" not in str(exc):
            raise SystemExit("FAIL: malformed-schema rejection did not explain the missing structure.")
    else:
        raise SystemExit("FAIL: malformed structured context was accepted during schema recovery.")
    print("PASS: complete v2-shaped model output recovers from a missing/stale schema label without bypassing coordinate validation")

    fallback = fallback_builder(
        1000, 500,
        {
            "available": True, "source": "windows_uia", "reason": None,
            "active_window": {"title": "Test app", "bbox_px": [0, 0, 1000, 500]},
            "focused_control": None,
            "controls": [{"id": "uia-apply", "label": "Apply", "role": "Button",
                          "enabled": True, "bbox_px": [800, 400, 900, 450]}],
            "cursor": {"x_px": 500, "y_px": 250}
        },
        {"available": True, "method": "tesseract", "reason": None,
         "text_spans": [{"text": "Install", "bbox_px": [10, 10, 60, 30]}]},
        "RuntimeError: model does not support multimodal requests"
    )
    if not fallback["perception"]["degraded"] or fallback["perception"]["mode"] != "ocr_accessibility_fallback":
        raise SystemExit("FAIL: passive fallback did not explicitly mark degraded OCR/UIA mode.")
    if fallback["controls"][0]["bbox_px"] != [800, 400, 900, 450] or fallback["controls"][0]["center_px"] != [850.0, 425.0]:
        raise SystemExit("FAIL: degraded fallback did not preserve system-grounded control coordinates.")
    if fallback["text_spans"][0]["text"] != "Install":
        raise SystemExit("FAIL: degraded fallback did not preserve OCR text evidence.")
    print("PASS: crop-relative coordinates map to the original screenshot frame")
    print("PASS: matching Windows UI Automation bounds become explicitly accessibility-grounded")
    print("PASS: coordinate centers are computed locally from the validated bounding rectangles")
    print("PASS: object boxes map from focused crops into the original desktop coordinate frame")
    large_controls = []
    large_ocr_spans = []
    for index in range(800):
        left = (index % 100) * 18
        top = (index // 100) * 100
        box = [left, top, left + 16, top + 16]
        large_controls.append({
            "id": "uia-" + str(index + 1), "label": "Button " + str(index + 1),
            "role": "Button", "enabled": True, "bbox_px": box
        })
        large_ocr_spans.append({
            "text": "Visible text item " + str(index + 1) + " with useful screen wording",
            "kind": "visible_text", "source": "tesseract_ocr",
            "tesseract_confidence_score": 91.0, "bbox_px": box
        })
    large_fallback = fallback_builder(
        1920, 1080,
        {
            "available": True, "source": "windows_uia", "truncated": False,
            "active_window": {"title": "Dense application", "bbox_px": [0, 0, 1920, 1080]},
            "focused_control": None, "cursor": None, "controls": large_controls
        },
        {"available": True, "method": "tesseract", "reason": None, "text_spans": large_ocr_spans},
        "model output exceeded its generation window"
    )
    encoded_fallback = json.dumps(large_fallback, ensure_ascii=False, separators=(",", ":"))
    if len(large_fallback["controls"]) != 800:
        raise SystemExit("FAIL: compact passive fallback discarded system-grounded UIA controls.")
    if len(large_fallback["ocr"]["text_spans"]) != 800:
        raise SystemExit("FAIL: compact passive fallback discarded OCR evidence.")
    if len(large_fallback["text_spans"]) != 64:
        raise SystemExit("FAIL: top-level passive OCR preview must stay bounded at 64 spans.")
    if len(large_fallback["accessibility"]["controls"]) != 64 or large_fallback["accessibility"]["controls_truncated"] is not True:
        raise SystemExit("FAIL: duplicate nested UIA controls were not compacted and marked truncated.")
    if len(encoded_fallback) > 1000000:
        raise SystemExit("FAIL: 800 UIA controls plus 800 OCR spans exceeded the structured report size budget.")
    print("PASS: passive fallback keeps 800 UIA controls and 800 OCR spans within the 1 MB report budget")
    print("PASS: passive model failures retain explicit, degraded OCR/UI Automation evidence")


def main():
    notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    cells = notebook.get("cells")
    if not isinstance(cells, list) or not cells:
        raise SystemExit("FAIL: notebook has no cells")

    code = "\n\n".join(
        source_of(cell) for cell in cells if cell.get("cell_type") == "code"
    )
    if not code.strip():
        raise SystemExit("FAIL: notebook has no executable code")
    ast.parse(code, filename=str(NOTEBOOK))

    required = {
        "versioned vision worker API": "VISION_WORKER_API_VERSION = 5",
        "actual Ollama vision capabilities are inspected": "def ollama_model_capabilities(model_name):",
        "stale vision model metadata is refreshed": "def refresh_and_verify_vision_capability(",
        "real multimodal errors trigger a repair attempt": "def refresh_passive_model_after_multimodal_error():",
        "passive observation preserves OCR/UIA evidence on failure": "def build_passive_fallback_report(",
        "expanded visual object output is normalized": '"objects": normalized_objects',
        "object boxes are transformed from focused crops": 'for key in ("regions", "text_spans", "controls", "objects")',
        "TTS capability advertised by health": '"tts-piper-libritts-high"',
        "Piper LibriTTS high voice": 'PIPER_VOICE_NAME = "en_US-libritts-high"',
        "fixed speaker ID zero": "PIPER_SPEAKER_ID = 0",
        "verified Piper voice checksum": "PIPER_VOICE_SHA256",
        "persistent Piper voice load": "def ensure_tts_voice():",
        "authenticated TTS endpoint": 'if route == "/tts":',
        "chunked TTS support advertised": '"tts-chunked-playback"',
        "Unicode speech normalization advertised": '"unicode-speech-normalization"',
        "expanded Observe schema advertised": '"expanded-observe-context-v3"',
        "latest-frame scheduling advertised": '"passive-latest-frame-scheduling"',
        "WAV audio checksum": '"audio_sha256": hashlib.sha256(audio).hexdigest()',
        "pending result preserves frame ID": '"input_frame_id": record.get("input_frame_id")',
        "pending result preserves model role": '"model_role": record.get("model_role")',
        "Ollama Qwen3-VL 4B detailed model": 'OLLAMA_MODEL = "qwen3-vl:4b-instruct"',
        "SmolVLM2 Q8 image-capable passive model": 'PASSIVE_MODEL = "ahmadwaqar/smolvlm2-2.2b-instruct:latest"',
        "passive model repository uses image-capable Ollama tag": 'PASSIVE_MODEL_REPO = "ahmadwaqar/smolvlm2-2.2b-instruct"',
        "parked Qwen alias": 'PARKED_QWEN_MODEL = "bridge-qwen3-vl-4b-parked:latest"',
        "Ollama native chat API": 'OLLAMA_API + "/api/chat"',
        "vision image payload": '"images": [model_image_b64]',
        "full-resolution image boundary": "MODEL_MAX_EDGE = 16384",
        "bounded model image processing helper": "bounded_image_dimensions(",
        "model image dimensions remain explicit": '"resized": model_image_resized',
        "passive model matches the observed effective context limit": "PASSIVE_CONTEXT_TOKENS = 8192",
        "Qwen is unloaded after detailed requests": '"keep_alive": -1 if model_role == "passive" else 0',
        "CPU-only parked Qwen preload": "num_gpu=0, context_tokens=VISION_CONTEXT_TOKENS",
        "three model slots permitted": '"OLLAMA_MAX_LOADED_MODELS": "3"',
        "safe HTTP body parsing advertised": '"safe-http-request-bodies"',
        "body read validates HTTP framing": "parse_content_length(self.headers)",
        "strict bounded Content-Length helper": "def parse_content_length(headers, max_length=2_000_000):",
        "malformed UTF-8/JSON is rejected uniformly": "def decode_request_body(raw_body):",
        "body read checks declared length": "read_exact_request_body(self.rfile, length)",
        "passive output budget fits the observed context ceiling": "PASSIVE_MAX_OUTPUT_TOKENS = 1400",
        "vision output budget uses per-model limits": "model_predict = PASSIVE_MAX_OUTPUT_TOKENS if model_role == \"passive\" else DETAILED_MAX_OUTPUT_TOKENS",
        "per-chunk TTS synthesis latency is emitted": '"synthesis_ms": synthesis_ms',
        "per-chunk TTS lock wait is emitted": '"tts_lock_wait_ms": tts_lock_wait_ms',
        "streamed TTS prefetch is advertised": '"tts-streamed-prefetch"',
        "server synthesis timing capability is advertised": '"tts-server-synthesis-metrics-v1"',
        "streamed TTS uses chunked HTTP response": 'self.send_header("Transfer-Encoding", "chunked")',
        "streamed TTS caps the aggregate audio body": "MAX_TTS_BATCH_AUDIO_BYTES = 25 * 1024 * 1024",
        "streamed TTS caps combined batch text": "MAX_TTS_BATCH_TEXT_CHARS = 8000",
        "streamed TTS has a bounded chunk count": "MAX_TTS_BATCH_CHUNKS = 31",
        "streamed TTS flushes each audio chunk": "self.wfile.flush()",
        "disconnected response writes are handled": "if is_client_disconnect_error(exc):",
        "incomplete HTTP bodies get an explicit response": '{"error": "Incomplete request body"}',
        "swap-file path is visible": 'OLLAMA_SWAP_FILE = Path("/content/bridge-qwen-pagefile.swap")',
        "invalid preallocated swap files get one dense allocation retry": "is_swapfile_layout_error(activated.returncode, activated.stderr, activated.stdout) and not dense_dd_used",
        "swap fallback is observable": "retrying with dense dd allocation.",
        "swap activation result is inspected": 'Path("/proc/swaps").read_text(encoding="utf-8")',
        "priority scheduler for detailed requests": "def inference_slot(model_role):",
        "both model roles are reported": '"passive_model_loaded": bool(_passive_model_loaded)',
        "frame ID returned with result": '"input_frame_id": input_frame_id',
        "model-role routing": 'model_name = PASSIVE_MODEL if model_role == "passive" else OLLAMA_MODEL',
        "thinking disabled for concise vision output": '"think": False',
        "structured JSON output": '"format": "json"',
        "versioned desktop context schema": 'VISION_CONTEXT_SCHEMA = "windows-vision-context/v2"',
        "schema label recovery requires a canonical model structure": "canonical_schema_shape = (",
        "normalized schema recovery is disclosed as uncertainty": "The model schema label was normalized only after the expected structure was confirmed",
        "truncation is rejected explicitly": "malformed or truncated JSON; the report was rejected.",
        "normalized coordinate conversion": "def normalize_model_box(",
        "derived centers instead of model centers": 'item["center_px"] = [round((pixel_box[0] + pixel_box[2]) / 2, 2)',
        "OCR evidence extraction": "def extract_ocr_evidence(",
        "bounded Tesseract dependency": "tesseract-ocr",
        "Windows UI Automation grounding": "windows_ui_automation_hints",
        "generation length exhaustion is a failure": "Vision output hit its generation limit.",
        "model download is checked": "if not ollama_model_is_downloaded(model_name):",
        "passive readiness requires actual vision capability": 'if "vision" not in capabilities:',
        "expanded control/text budgets are enforced": "len(text_spans) > 800 or len(controls) > 800",
        "tenfold OCR spans": '"text_spans": spans[:800]',
        "tenfold UIA fallback": "raw_controls[:800]",
        "tenfold fallback access is compactly duplicated": '"accessibility": {**access, "controls": access_controls[:64], "controls_truncated": len(access_controls) > 64}',
        "context-bounded passive OCR hints": 'ocr_hint_limit = 48 if model_role == "passive" else 128',
        "context-bounded passive UIA hints": 'accessibility_hint_limit = 64 if model_role == "passive" else 160',
        "passive model receives a denser structured-report budget": "PASSIVE OBSERVE MODE: produce a dense, high-signal live screen map",
        "passive structured report includes text and control locations": "up to 48 task-relevant visible text spans",
        "passive structured report keeps bounded object coverage": "up to 20 other visible objects",
        "passive structured report keeps bounded region coverage": "up to 16 distinct screen regions",
        "passive structured report keeps bounded control coverage": "up to 32 visible controls",
        "passive prompt targets context-fit report size": "around 900-1300 generated tokens",
        "Piper is warmed before TTS readiness": 'voice.synthesize_wav(\n                    "Ready.", warmup_wav',
        "TTS warm-up duration is observable": '"tts_warmup_ms": round(float(_tts_warmup_ms)',
        "detailed Qwen structured report retains its compact budget": "at most 8 regions, 24 text spans, 16 controls, and 12 objects",
        "larger passive context window": "PASSIVE_CONTEXT_TOKENS = 16384",
        "bounded structured report size": "MAX_STRUCTURED_REPORT_CHARS = 1000000",
        "compact fallback text preview": "enumerate(ocr_spans[:64])",
        "full OCR retained in fallback": '"text_spans": ocr_spans[:800]',
        "readiness uses Ollama's loaded-model API": "refresh_model_runtime_state()",
        "authenticated direct API": "class DirectVisionHandler(",
        "bounded model download": "timeout=bounded_setup_timeout(600), env=server_env",
        "visible setup timing": "stage_elapsed_seconds",
        "bounded two-model setup budget": "SETUP_BUDGET_SECONDS = 900",
        "no automatic retries after setup failure": "_setup_blocked = True",
        "bounded desktop registration wait": "_desktop_registration_event.wait(timeout=90)",
    }
    for label, needle in required.items():
        if needle not in code:
            raise SystemExit(f"FAIL: missing {label}: {needle}")

    forbidden = (
        "richardyoung/smolvlm2-2.2b-instruct:Q4_K_M",
        "hf_hub_download",
        "Qwen3VL-8B-Instruct",
        "--mmproj",
        "cmake --build",
        "nvcc",
        "drive.mount(",
        "/v1/chat/completions",
        "def run_vision_smoke_test()",
        "vision_smoke_test",
        "blue-square vision check",
        "generated test image",
    )
    for needle in forbidden:
        if needle in code:
            raise SystemExit(f"FAIL: obsolete llama.cpp/Drive setup remains: {needle}")

    validate_context_helpers(code)

    guide = source_of(notebook.get("cells", [{}])[0])
    if "prebuilt Ollama runtime" not in guide or "Fresh Colab runtimes" not in guide or "Piper" not in guide:
        raise SystemExit("FAIL: notebook guide does not explain the prebuilt runtime, model cache, and persistent Piper TTS voice")

    print("PASS: notebook JSON parsed")
    print("PASS: Python code cell syntax parsed")
    print(f"PASS: {len(required)} Ollama/vision/readiness requirements checked")
    print(f"PASS: {len(forbidden)} obsolete build/Drive/API paths absent")


if __name__ == "__main__":
    main()
