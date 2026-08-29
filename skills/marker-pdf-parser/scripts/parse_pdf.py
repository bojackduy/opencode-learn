#!/usr/bin/env python3
"""Safe command-line wrapper around Marker's `marker_single` executable."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ALLOWED_FORMATS = ("markdown", "json", "html", "chunks")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Parse a local PDF with Marker and report generated files as JSON."
    )
    parser.add_argument("input_pdf", help="Path to a local PDF file")
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory where Marker should write conversion results",
    )
    parser.add_argument(
        "--format",
        choices=ALLOWED_FORMATS,
        default="markdown",
        dest="output_format",
        help="Marker output format (default: markdown)",
    )
    parser.add_argument(
        "--pages",
        help='Zero-based page selection accepted by Marker, e.g. "0,3-7,12"',
    )
    parser.add_argument("--force-ocr", action="store_true")
    parser.add_argument("--strip-existing-ocr", action="store_true")
    parser.add_argument("--use-llm", action="store_true")
    parser.add_argument("--redo-inline-math", action="store_true")
    parser.add_argument("--paginate-output", action="store_true")
    parser.add_argument("--disable-image-extraction", action="store_true")
    parser.add_argument("--debug", action="store_true")
    return parser


def fail(message: str, code: int = 2) -> "NoReturn":
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)


def validate_paths(input_value: str, output_value: str) -> tuple[Path, Path]:
    input_path = Path(input_value).expanduser().resolve()
    if not input_path.exists():
        fail(f"Input file does not exist: {input_path}")
    if not input_path.is_file():
        fail(f"Input path is not a file: {input_path}")
    if input_path.suffix.lower() != ".pdf":
        fail(f"Only PDF input is accepted by this skill: {input_path.name}")

    output_path = Path(output_value).expanduser().resolve()
    if output_path == input_path or input_path in output_path.parents:
        fail("Output directory must not be the input PDF or a child of it")
    output_path.mkdir(parents=True, exist_ok=True)
    return input_path, output_path


def main() -> int:
    args = build_parser().parse_args()
    input_path, output_path = validate_paths(args.input_pdf, args.output_dir)

    marker_executable = shutil.which("marker_single")
    if marker_executable is None:
        fail(
            "marker_single was not found. Install the skill dependencies with: "
            "python -m pip install -r requirements.txt"
        )

    before = {
        path.resolve()
        for path in output_path.rglob("*")
        if path.is_file()
    }

    command = [
        marker_executable,
        os.fspath(input_path),
        "--output_dir",
        os.fspath(output_path),
        "--output_format",
        args.output_format,
    ]

    optional_flags = {
        "force_ocr": "--force_ocr",
        "strip_existing_ocr": "--strip_existing_ocr",
        "use_llm": "--use_llm",
        "redo_inline_math": "--redo_inline_math",
        "paginate_output": "--paginate_output",
        "disable_image_extraction": "--disable_image_extraction",
        "debug": "--debug",
    }
    for attribute, flag in optional_flags.items():
        if getattr(args, attribute):
            command.append(flag)

    if args.pages:
        command.extend(["--page_range", args.pages])

    try:
        completed = subprocess.run(
            command,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        fail(f"Could not start Marker: {exc}")

    if completed.returncode != 0:
        error_tail = (completed.stderr or completed.stdout or "Unknown Marker error")[-8000:]
        fail(f"Marker failed with exit code {completed.returncode}:\n{error_tail}", completed.returncode)

    after = {
        path.resolve()
        for path in output_path.rglob("*")
        if path.is_file()
    }
    generated = sorted(after - before)
    # Marker may overwrite files from an earlier run. Fall back to all files so
    # the agent still receives usable locations.
    if not generated:
        generated = sorted(after)

    result = {
        "ok": True,
        "input_file": os.fspath(input_path),
        "output_dir": os.fspath(output_path),
        "format": args.output_format,
        "generated_files": [os.fspath(path) for path in generated],
        "marker_stdout_tail": completed.stdout[-2000:] if completed.stdout else "",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
