#!/usr/bin/env python3
"""
Deep Directory Analysis Coordinator for LivePanel.

Returns the canonical shared directory payload used by both XR and LivePanel.
"""

import json
import os
import sys
from pathlib import Path

UTILS_DIR = Path(__file__).resolve().parent.parent / 'utils'
if str(UTILS_DIR) not in sys.path:
    sys.path.insert(0, str(UTILS_DIR))

from directory_analysis_engine import run_directory_analysis


def analyze_directory_deep_comprehensive(directory_path, filtered_files=None):
    return run_directory_analysis(
        directory_path, True, filtered_files,
        'DEEP_DIRECTORY_ANALYSIS', f'Starting deep analysis for {directory_path}',
    )


def main(filtered_files=None):
    if len(sys.argv) != 2:
        print(json.dumps({'error': 'Usage: python livePanel_directory_deep_analysis_coordinator.py <directory_path>'}))
        sys.exit(1)

    directory_path = sys.argv[1]
    if not os.path.isdir(directory_path):
        print(json.dumps({'error': f'Directory not found: {directory_path}'}))
        sys.exit(1)

    analysis_result = analyze_directory_deep_comprehensive(directory_path, filtered_files)
    print(json.dumps(analysis_result, indent=2))


if __name__ == '__main__':
    main()
