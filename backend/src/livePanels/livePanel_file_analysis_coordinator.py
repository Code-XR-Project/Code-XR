#!/usr/bin/env python3
"""
File Analysis Coordinator.

Produces the canonical shared file payload used by both XR and LivePanel.
"""

import json
import os
import sys
from pathlib import Path

UTILS_DIR = Path(__file__).resolve().parent.parent / 'utils'
if str(UTILS_DIR) not in sys.path:
    sys.path.insert(0, str(UTILS_DIR))

from file_analysis_engine import build_file_payload, build_file_snapshot


def analyze_file_comprehensive(file_path):
    print(json.dumps({'debug': f'ANALYSIS_FILE_STATS: Starting analysis for {file_path}'}), file=sys.stderr)
    snapshot = build_file_snapshot(file_path)
    payload = build_file_payload(file_path, snapshot)
    print(json.dumps({'debug': f'ANALYSIS_FILE_STATS: Generated {len(payload)} function records'}), file=sys.stderr)
    return payload


def main():
    if len(sys.argv) != 2:
        print('Usage: python livePanel_file_analysis_coordinator.py <file_path>', file=sys.stderr)
        sys.exit(1)

    file_path = sys.argv[1]

    if file_path.startswith('/file:'):
        file_path = file_path.replace('/file:', '')
        while file_path.startswith('//'):
            file_path = file_path[1:]

    if not os.path.exists(file_path):
        print(json.dumps({'error': f'File not found: {file_path}', 'status': 'error'}))
        sys.exit(1)

    result = analyze_file_comprehensive(file_path)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
