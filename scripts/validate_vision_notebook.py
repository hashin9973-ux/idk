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
        "normalized_accessibility_hints",
        "map_model_boxes_to_original",
        "normalize_model_report",
    }
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted]
    found = {node.name for node in nodes}
    missing = wanted - found
    if missing:
        raise SystemExit("FAIL: isolated context helpers missing: " + ", ".join(sorted(missing)))
    namespace = {"math": math, "json": json}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<vision-context-helpers>", "exec"), namespace)

    map_boxes = namespace["map_model_boxes_to_original"]
    normalize_report = namespace["normalize_model_report"]
    hints = namespace["normalized_accessibility_hints"]

    crop_report = {
        "schema_version": "windows-vision-context/v1",
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
    print("PASS: crop-relative coordinates map to the original screenshot frame")
    print("PASS: matching Windows UI Automation bounds become explicitly accessibility-grounded")
    print("PASS: coordinate centers are computed locally from the validated bounding rectangles")


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
        "Ollama Qwen3-VL 4B instruct model": 'OLLAMA_MODEL = "qwen3-vl:4b-instruct"',
        "Ollama native chat API": 'OLLAMA_API + "/api/chat"',
        "vision image payload": '"images": [image_b64]',
        "thinking disabled for concise vision output": '"think": False',
        "structured JSON output": '"format": "json"',
        "versioned desktop context schema": 'VISION_CONTEXT_SCHEMA = "windows-vision-context/v1"',
        "truncation is rejected explicitly": "malformed or truncated JSON; the report was rejected.",
        "normalized coordinate conversion": "def normalize_model_box(",
        "derived centers instead of model centers": 'item["center_px"] = [round((pixel_box[0] + pixel_box[2]) / 2, 2)',
        "OCR evidence extraction": "def extract_ocr_evidence(",
        "bounded Tesseract dependency": "tesseract-ocr",
        "Windows UI Automation grounding": "windows_ui_automation_hints",
        "generation length exhaustion is a failure": "Vision output hit its generation limit.",
        "model download is checked": "if not ollama_model_is_downloaded():",
        "readiness based on healthy API and downloaded weights": 'requests.get(OLLAMA_API + "/api/version", timeout=2).ok and ollama_model_is_downloaded()',
        "no startup image inference": "No startup image inference was run",
        "authenticated direct API": "class DirectVisionHandler(",
        "bounded model download": "timeout=bounded_setup_timeout(420), env=server_env",
        "visible setup timing": "stage_elapsed_seconds",
        "bounded setup budget": "SETUP_BUDGET_SECONDS = 480",
        "no automatic retries after setup failure": "_setup_blocked = True",
        "bounded desktop registration wait": "_desktop_registration_event.wait(timeout=90)",
    }
    for label, needle in required.items():
        if needle not in code:
            raise SystemExit(f"FAIL: missing {label}: {needle}")

    forbidden = (
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
    if "prebuilt Ollama runtime" not in guide or "fresh Colab runtime must download the model again" not in guide:
        raise SystemExit("FAIL: notebook guide does not explain the prebuilt runtime and ephemeral model cache")

    print("PASS: notebook JSON parsed")
    print("PASS: Python code cell syntax parsed")
    print(f"PASS: {len(required)} Ollama/vision/readiness requirements checked")
    print(f"PASS: {len(forbidden)} obsolete build/Drive/API paths absent")


if __name__ == "__main__":
    main()
