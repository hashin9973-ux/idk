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
    }
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted]
    found = {node.name for node in nodes}
    missing = wanted - found
    if missing:
        raise SystemExit("FAIL: isolated context helpers missing: " + ", ".join(sorted(missing)))
    namespace = {"math": math, "json": json}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<vision-context-helpers>", "exec"), namespace)

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
        "versioned vision worker API": "VISION_WORKER_API_VERSION = 4",
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
        "passive model uses separate context": "PASSIVE_CONTEXT_TOKENS = 8192",
        "Qwen is unloaded after detailed requests": '"keep_alive": -1 if model_role == "passive" else 0',
        "CPU-only parked Qwen preload": "num_gpu=0, context_tokens=VISION_CONTEXT_TOKENS",
        "three model slots permitted": '"OLLAMA_MAX_LOADED_MODELS": "3"',
        "swap-file path is visible": 'OLLAMA_SWAP_FILE = Path("/content/bridge-qwen-pagefile.swap")',
        "swap activation result is inspected": 'Path("/proc/swaps").read_text(encoding="utf-8")',
        "priority scheduler for detailed requests": "def inference_slot(model_role):",
        "both model roles are reported": '"passive_model_loaded": bool(_passive_model_loaded)',
        "frame ID returned with result": '"input_frame_id": input_frame_id',
        "model-role routing": 'model_name = PASSIVE_MODEL if model_role == "passive" else OLLAMA_MODEL',
        "thinking disabled for concise vision output": '"think": False',
        "structured JSON output": '"format": "json"',
        "versioned desktop context schema": 'VISION_CONTEXT_SCHEMA = "windows-vision-context/v2"',
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
        "tenfold fallback access": '"accessibility": {**access, "controls": access.get("controls", [])[:800]}',
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
