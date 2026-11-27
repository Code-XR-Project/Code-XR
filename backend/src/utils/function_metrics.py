#!/usr/bin/env python3
"""
Per-function metrics for the Code-XR IDE's Problems panel (#173).

The XR and LivePanel directory payloads keep one summary row per file, so
they cannot say which function is too complex. This mode returns, for each
analysable file, its functions with their line range, cyclomatic
complexity, lines of code and parameter count, and nothing else: the IDE
applies its own thresholds, so changing one needs no new run.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable

from directory_analysis_engine import collect_directory_targets
from file_analysis_engine import analyze_file_functions, normalize_function_metrics
from metric_language_contract import get_metric_language
from progress_logger import emit_directory_progress

FUNCTION_FIELDS = ('functionName', 'qualifiedName', 'lineStart', 'lineEnd', 'lineCount', 'complexity', 'parameters', 'maxNestingDepth')


def _relative_path(file_path: str, root: str) -> str:
    try:
        relative = os.path.relpath(file_path, root)
    except ValueError:
        # Another drive on Windows: the path cannot be expressed from the root.
        relative = file_path
    return Path(relative).as_posix()


def file_function_metrics(file_path: str, root: str) -> dict[str, Any]:
    """One file's functions, trimmed to the fields the Problems panel reads."""
    metrics_data = analyze_file_functions(file_path)
    functions = normalize_function_metrics(metrics_data.get('functions', []))
    return {
        'relativePath': _relative_path(file_path, root),
        'language': get_metric_language(file_path),
        'status': metrics_data.get('status', 'error'),
        'functions': [{field: function.get(field) for field in FUNCTION_FIELDS} for function in functions],
    }


def analyze_function_metrics(
    target: str,
    target_type: str,
    recursive: bool = False,
    filtered_files: Iterable[str] | None = None,
    project_root: str | None = None,
) -> list[dict[str, Any]]:
    """
    The functions of a file (its path relative to `project_root` when given),
    or of every analysable file under a directory (relative to it).
    """
    if target_type == 'file':
        return [file_function_metrics(target, project_root or os.path.dirname(target))]

    files = collect_directory_targets(target, recursive=recursive, filtered_files=filtered_files)
    entries = []
    for index, file_path in enumerate(files, start=1):
        emit_directory_progress(index, len(files), file_path)
        entries.append(file_function_metrics(file_path, target))
    return entries
