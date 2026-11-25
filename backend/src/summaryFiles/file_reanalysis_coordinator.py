#!/usr/bin/env python3
"""
File Re-analysis Coordinator.

Generates canonical per-file summary entries for directory incremental updates.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

UTILS_DIR = Path(__file__).resolve().parent.parent / 'utils'
if str(UTILS_DIR) not in sys.path:
    sys.path.insert(0, str(UTILS_DIR))

from babia_path_utils import normalize_output_paths
from file_analysis_engine import build_file_snapshot
from file_metric_summary import build_file_metric_summary


def analyze_file_summary(file_path: str, relative_path: str | None = None) -> dict[str, Any]:
    snapshot = build_file_snapshot(file_path)
    return normalize_output_paths(build_file_metric_summary(snapshot, file_path, relative_path))


def analyze_multiple_files(file_paths: list[str], relative_paths: list[str] | None = None) -> list[dict[str, Any]]:
    if relative_paths and len(relative_paths) != len(file_paths):
        raise ValueError('relative_paths length must match file_paths length')

    results: list[dict[str, Any]] = []
    for index, file_path in enumerate(file_paths):
        relative_path = relative_paths[index] if relative_paths else None
        results.append(analyze_file_summary(file_path, relative_path))

    return results


def main():
    if len(sys.argv) < 2:
        print('Usage: python file_reanalysis_coordinator.py <file_path> [relative_path]', file=sys.stderr)
        print('   or: python file_reanalysis_coordinator.py <file1> <file2> ... [--relative-paths path1 path2 ...]', file=sys.stderr)
        sys.exit(1)

    args = sys.argv[1:]
    relative_paths = None

    if '--relative-paths' in args:
        rel_index = args.index('--relative-paths')
        file_paths = args[:rel_index]
        relative_paths = args[rel_index + 1:]
        if len(relative_paths) != len(file_paths):
            print(json.dumps({'error': 'Number of relative paths must match number of file paths'}), file=sys.stderr)
            sys.exit(1)
    else:
        file_paths = args

    for file_path in file_paths:
        if not os.path.isfile(file_path):
            print(json.dumps({'error': f'File not found: {file_path}'}), file=sys.stderr)
            sys.exit(1)

    try:
        if len(file_paths) == 1 and relative_paths is None:
            result = analyze_file_summary(file_paths[0])
        elif len(file_paths) == 2 and relative_paths is None and not os.path.isfile(file_paths[1]):
            result = analyze_file_summary(file_paths[0], file_paths[1])
        else:
            result = analyze_multiple_files(file_paths, relative_paths)

        print('=== JSON_START ===')
        print(json.dumps(result, indent=2))
        print('=== JSON_END ===')
    except Exception as error:
        print(json.dumps({'error': f'File re-analysis failed: {error!s}'}), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
