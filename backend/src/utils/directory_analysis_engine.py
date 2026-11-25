#!/usr/bin/env python3
"""
Shared directory-analysis engine used by XR and LivePanel.
"""

import json
import os
import sys
from typing import Callable, Dict, Iterable, List, Optional

from babia_path_utils import normalize_output_paths
from directory_scan_utils import filter_explicit_files_for_analysis, scan_directory_files_for_analysis
from file_analysis_engine import build_file_snapshot
from file_metric_summary import build_file_metric_summary
from progress_logger import emit_directory_progress

ProgressCallback = Callable[[int, int, str], None]


def collect_directory_targets(
    directory_path: str,
    recursive: bool = False,
    filtered_files: Optional[Iterable[str]] = None,
    max_entries_per_directory: int = 1000,
    max_total_files: int = 5000,
) -> List[str]:
    if filtered_files is not None:
        return filter_explicit_files_for_analysis(filtered_files, max_total_files=max_total_files)

    return scan_directory_files_for_analysis(
        directory_path,
        recursive=recursive,
        max_entries_per_directory=max_entries_per_directory,
        max_total_files=max_total_files,
    )


def analyze_directory_entries(
    directory_path: str,
    recursive: bool = False,
    filtered_files: Optional[Iterable[str]] = None,
    progress_callback: Optional[ProgressCallback] = None,
) -> List[Dict[str, object]]:
    files_to_analyze = collect_directory_targets(
        directory_path,
        recursive=recursive,
        filtered_files=filtered_files,
    )

    entries: List[Dict[str, object]] = []
    total_files = len(files_to_analyze)

    for index, file_path in enumerate(files_to_analyze, start=1):
        if progress_callback:
            progress_callback(index, total_files, file_path)

        relative_path = os.path.relpath(file_path, directory_path)
        snapshot = build_file_snapshot(file_path)
        entries.append(build_file_metric_summary(snapshot, file_path, relative_path))

    return entries


def run_directory_analysis(
    directory_path: str,
    recursive: bool,
    filtered_files: Optional[Iterable[str]],
    log_label: str,
    start_message: str,
) -> List[Dict[str, object]]:
    """The shared body of the three directory coordinators: log, analyse with progress, normalise."""
    print(json.dumps({'debug': f'{log_label}: {start_message}'}), file=sys.stderr)
    entries = analyze_directory_entries(
        directory_path,
        recursive=recursive,
        filtered_files=filtered_files,
        progress_callback=emit_directory_progress,
    )
    print(json.dumps({'debug': f'{log_label}: Generated {len(entries)} file records'}), file=sys.stderr)
    return normalize_output_paths(entries)
