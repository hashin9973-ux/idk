#!/usr/bin/env python3
"""Validate the executable code and architecture assumptions in the Colab vision notebook."""

import ast
import json
from pathlib import Path

NOTEBOOK = Path(__file__).resolve().parents[1] / "vision" / "vision_worker.ipynb"


def source_of(cell):
    source = cell.get("source", "")
    return "".join(source) if isinstance(source, list) else str(source)


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
        "Ollama Qwen3-VL 4B model": 'OLLAMA_MODEL = "qwen3-vl:4b"',
        "Ollama native chat API": 'OLLAMA_API + "/api/chat"',
        "vision image payload": '"images": [image_b64]',
        "real image smoke test": "def run_vision_smoke_test()",
        "readiness requires loaded model": "ollama_model_is_loaded()",
        "authenticated direct API": "class DirectVisionHandler(",
        "bounded model download": "timeout=bounded_setup_timeout(420), env=server_env",
        "visible setup timing": "stage_elapsed_seconds",
        "bounded setup budget": "SETUP_BUDGET_SECONDS = 480",
        "no automatic retries after setup failure": "_setup_blocked = True",
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
    )
    for needle in forbidden:
        if needle in code:
            raise SystemExit(f"FAIL: obsolete llama.cpp/Drive setup remains: {needle}")

    guide = source_of(notebook.get("cells", [{}])[0])
    if "prebuilt Ollama runtime" not in guide or "fresh Colab runtime must download the model again" not in guide:
        raise SystemExit("FAIL: notebook guide does not explain the prebuilt runtime and ephemeral model cache")

    print("PASS: notebook JSON parsed")
    print("PASS: Python code cell syntax parsed")
    print(f"PASS: {len(required)} Ollama/vision/readiness requirements checked")
    print(f"PASS: {len(forbidden)} obsolete build/Drive/API paths absent")


if __name__ == "__main__":
    main()
