#!/usr/bin/env python3
"""
Shared code-analysis engine used by XR and LivePanel file/directory analysis.
"""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

TOOLS_DIR = Path(__file__).resolve().parent.parent / 'tools'
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from babia_path_utils import build_tree_path, normalize_output_paths
from class_counter_analyzer import analyze_classes
from code_metrics_analyzer import analyze_file as analyze_file_functions
from file_metric_summary import get_file_size
from line_metric_utils import build_line_metrics
from metric_language_contract import get_metric_language
from python_comment_analyzer import analyze_comments
from xr_field_schema import (
    FILE_METRIC_FIELD_IDS,
    FUNCTION_METRIC_FIELD_IDS,
    build_complexity_band,
    safe_ratio,
    summarize_function_metrics,
)


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _get_file_timestamp(file_path: str) -> str:
    try:
        modified_at = os.path.getmtime(file_path)
        return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(modified_at))
    except OSError:
        return time.strftime('%Y-%m-%d %H:%M:%S')


def _get_file_modified_metadata(file_path: str) -> dict[str, Any]:
    try:
        modified_at = os.path.getmtime(file_path)
    except OSError:
        modified_at = time.time()

    return {
        'modifiedAtMs': int(round(modified_at * 1000)),
        'modifiedAtIso': datetime.fromtimestamp(modified_at).astimezone().isoformat(timespec='seconds'),
    }


def normalize_function_metrics(raw_functions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []

    for func in raw_functions or []:
        function_name = str(func.get('name') or 'unknown').strip() or 'unknown'
        qualified_name = str(func.get('longName') or function_name).strip() or function_name
        line_start = _safe_int(func.get('lineStart'), 0)
        line_end = _safe_int(func.get('lineEnd'), line_start)
        line_count = _safe_int(func.get('lineCount'), max((line_end - line_start) + 1, 0))
        complexity = _safe_int(func.get('complexity'), 0)
        parameters = _safe_int(func.get('parameters'), 0)
        max_nesting_depth = _safe_int(func.get('maxNestingDepth'), 0)
        cyclomatic_density = _safe_float(
            func.get('cyclomaticDensity'),
            safe_ratio(complexity, max(line_count, 1), 3),
        )

        normalized.append(
            {
                'functionName': function_name,
                'qualifiedName': qualified_name,
                'lineStart': line_start,
                'lineEnd': line_end,
                'lineCount': line_count,
                'spanLines': max((line_end - line_start) + 1, 0),
                'complexity': complexity,
                'complexityBand': build_complexity_band(complexity),
                'parameters': parameters,
                'maxNestingDepth': max_nesting_depth,
                'cyclomaticDensity': cyclomatic_density,
                **{field_id: _safe_float(func.get(field_id), 0.0) if field_id != 'cognitiveComplexity'
                   else _safe_int(func.get(field_id), 0) for field_id in FUNCTION_METRIC_FIELD_IDS},
            }
        )

    normalized.sort(key=lambda item: (item.get('lineStart', 0), item.get('functionName', '')))
    return normalized


def build_file_snapshot(file_path: str) -> dict[str, Any]:
    timestamp = _get_file_timestamp(file_path)
    modified_metadata = _get_file_modified_metadata(file_path)
    language = get_metric_language(file_path)
    file_name = os.path.basename(file_path)

    metrics_data = analyze_file_functions(file_path)
    comment_data = analyze_comments(file_path)
    class_data = analyze_classes(file_path)
    line_metrics = build_line_metrics(file_path, comment_data.get('commentLines', 0))

    status = metrics_data.get('status', 'error')
    normalized_functions = normalize_function_metrics(metrics_data.get('functions', []))
    function_summary = summarize_function_metrics(normalized_functions)
    complexity_metrics = metrics_data.get('metrics', {}) if status == 'success' else {}

    average_complexity = _safe_float(complexity_metrics.get('averageComplexity'), 0.0)
    max_complexity = _safe_int(complexity_metrics.get('maxComplexity'), 0)

    snapshot = {
        'fileName': file_name,
        'filePath': file_path,
        'language': language,
        'timestamp': timestamp,
        'modifiedAtMs': modified_metadata['modifiedAtMs'],
        'modifiedAtIso': modified_metadata['modifiedAtIso'],
        'status': status,
        'totalLines': line_metrics['totalLines'],
        'codeLines': line_metrics['codeLines'],
        'commentLines': line_metrics['commentLines'],
        'blankLines': line_metrics['blankLines'],
        'commentRatio': line_metrics['commentRatio'],
        'codeRatio': line_metrics['codeRatio'],
        'blankRatio': line_metrics['blankRatio'],
        'classCount': _safe_int(class_data.get('classCount'), 0),
        'classes': class_data.get('classes', []),
        'functionCount': len(normalized_functions),
        'complexity': {
            'averageComplexity': average_complexity,
            'maxComplexity': max_complexity,
            'functionCount': len(normalized_functions),
            'highComplexityFunctions': _safe_int(
                complexity_metrics.get('highComplexityFunctions'),
                function_summary['highComplexityFunctions'],
            ),
            'criticalComplexityFunctions': _safe_int(
                complexity_metrics.get('criticalComplexityFunctions'),
                function_summary['criticalComplexityFunctions'],
            ),
        },
        'maxComplexity': max_complexity,
        'cyclomaticComplexityNumber': round(average_complexity, 2),
        'cyclomaticComplexityDensity': safe_ratio(average_complexity, line_metrics['codeLines'], 8),
        'highComplexityFunctions': _safe_int(
            complexity_metrics.get('highComplexityFunctions'),
            function_summary['highComplexityFunctions'],
        ),
        'criticalComplexityFunctions': _safe_int(
            complexity_metrics.get('criticalComplexityFunctions'),
            function_summary['criticalComplexityFunctions'],
        ),
        'averageFunctionParameters': function_summary['averageFunctionParameters'],
        'maxFunctionParameters': function_summary['maxFunctionParameters'],
        'averageFunctionLines': function_summary['averageFunctionLines'],
        'maxFunctionLines': function_summary['maxFunctionLines'],
        'averageFunctionNestingDepth': function_summary['averageFunctionNestingDepth'],
        'maxFunctionNestingDepth': function_summary['maxFunctionNestingDepth'],
        **{field_id: function_summary[field_id] for field_id in FILE_METRIC_FIELD_IDS},
        'fileSizeBytes': get_file_size(file_path),
        'functions': normalized_functions,
    }

    return normalize_output_paths(snapshot)


def build_file_payload(file_path: str, snapshot: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    file_snapshot = snapshot or build_file_snapshot(file_path)
    file_name = file_snapshot.get('fileName', os.path.basename(file_path))

    payload: list[dict[str, Any]] = []
    for function in file_snapshot.get('functions', []):
        payload.append(
            {
                'functionName': function.get('functionName', 'unknown'),
                'qualifiedName': function.get('qualifiedName', function.get('functionName', 'unknown')),
                'lineStart': function.get('lineStart', 0),
                'lineEnd': function.get('lineEnd', 0),
                'lineCount': function.get('lineCount', 0),
                'spanLines': function.get('spanLines', 0),
                'complexity': function.get('complexity', 0),
                'complexityBand': function.get('complexityBand', 'normal'),
                'parameters': function.get('parameters', 0),
                'maxNestingDepth': function.get('maxNestingDepth', 0),
                'cyclomaticDensity': function.get('cyclomaticDensity', 0.0),
                **{field_id: function.get(field_id, 0) for field_id in FUNCTION_METRIC_FIELD_IDS},
                'filePath': file_snapshot.get('filePath', file_path),
                'fileName': file_name,
                'treePath': build_tree_path(file_name, function.get('functionName')),
                'language': file_snapshot.get('language', 'Unknown'),
                'timestamp': file_snapshot.get('timestamp'),
                'modifiedAtMs': file_snapshot.get('modifiedAtMs'),
                'modifiedAtIso': file_snapshot.get('modifiedAtIso'),
                'status': file_snapshot.get('status', 'success'),
                'totalLines': file_snapshot.get('totalLines', 0),
                'codeLines': file_snapshot.get('codeLines', 0),
                'commentLines': file_snapshot.get('commentLines', 0),
                'blankLines': file_snapshot.get('blankLines', 0),
                'commentRatio': file_snapshot.get('commentRatio', 0.0),
                'codeRatio': file_snapshot.get('codeRatio', 0.0),
                'blankRatio': file_snapshot.get('blankRatio', 0.0),
                'classCount': file_snapshot.get('classCount', 0),
                'functionCount': file_snapshot.get('functionCount', 0),
                'maxComplexity': file_snapshot.get('maxComplexity', 0),
                'cyclomaticComplexityNumber': file_snapshot.get('cyclomaticComplexityNumber', 0.0),
                'cyclomaticComplexityDensity': file_snapshot.get('cyclomaticComplexityDensity', 0.0),
                'highComplexityFunctions': file_snapshot.get('highComplexityFunctions', 0),
                'criticalComplexityFunctions': file_snapshot.get('criticalComplexityFunctions', 0),
                'averageFunctionParameters': file_snapshot.get('averageFunctionParameters', 0.0),
                'maxFunctionParameters': file_snapshot.get('maxFunctionParameters', 0),
                'averageFunctionLines': file_snapshot.get('averageFunctionLines', 0.0),
                'maxFunctionLines': file_snapshot.get('maxFunctionLines', 0),
                'averageFunctionNestingDepth': file_snapshot.get('averageFunctionNestingDepth', 0.0),
                'maxFunctionNestingDepth': file_snapshot.get('maxFunctionNestingDepth', 0),
                **{field_id: file_snapshot.get(field_id, 0) for field_id in FILE_METRIC_FIELD_IDS},
                'fileSizeBytes': file_snapshot.get('fileSizeBytes', 0),
            }
        )

    return normalize_output_paths(payload)
