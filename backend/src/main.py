#!/usr/bin/env python3
"""
Main entry point for Python analysis.
"""

import argparse
import json
import sys
from pathlib import Path

UTILS_DIR = Path(__file__).resolve().parent / 'utils'
if str(UTILS_DIR) not in sys.path:
    sys.path.insert(0, str(UTILS_DIR))

from progress_logger import log_debug, log_error, log_info
from xr_field_schema import get_xr_schema
from dependency_analysis_engine import analyze_dependencies, analyze_file_dependencies

LIVEPANELS_DIR = Path(__file__).resolve().parent / 'livePanels'
XR_DIR = Path(__file__).resolve().parent / 'XR'

for module_dir in (LIVEPANELS_DIR, XR_DIR):
    if str(module_dir) not in sys.path:
        sys.path.insert(0, str(module_dir))

def main():
    parser = argparse.ArgumentParser(description='Python Analysis Entry Point')
    parser.add_argument('--mode', required=True, choices=['livePanel', 'xr', 'schema', 'dependencies', 'functions'], help='Analysis mode')
    parser.add_argument('--type', required=True, choices=['file', 'directory'], help='Analysis type')
    parser.add_argument('--target', help='Target path to analyze')
    # --files is deliberately unused by the extension: executePython.ts never passes it, so
    # args.files is always None and directory modes scan the whole target. It is kept as a
    # documented hand-run entry (and is part of the pinned CLI surface, test/baseline).
    parser.add_argument('--files', nargs='*', help='Specific files to analyze (directory mode only)')
    parser.add_argument('--deep', action='store_true', help='Enable deep recursive analysis for directories')
    parser.add_argument('--cache', help='Private dependency extraction cache path')
    parser.add_argument('--dependency-refresh', help='Validated dependency refresh request JSON')
    parser.add_argument('--project-root', help='Validated project root for file dependency resolution (and the relative path of a functions-mode file)')

    args = parser.parse_args()

    if args.mode != 'schema' and not args.target:
        parser.error('--target is required unless --mode schema is used')

    log_info(f'Starting analysis - Mode: {args.mode}, Type: {args.type}')
    if args.target:
        log_info(f'Target: {args.target}')

    try:
        result = _dispatch(args)
        log_info('Analysis completed successfully')
        _emit(result)
    except Exception as error:
        log_error(f'Error during analysis: {error!s}')
        _emit({
            'error': True,
            'message': str(error),
            'mode': args.mode,
            'type': args.type,
            'target': args.target,
        })
        sys.exit(1)


def _dispatch(args):
    """Run the analysis the parsed arguments name. Coordinators are imported lazily."""
    if args.mode == 'schema':
        return execute_schema_request(args.type)
    if args.mode == 'dependencies':
        if args.type == 'directory':
            return analyze_dependencies(
                args.target,
                recursive=args.deep,
                cache_path=args.cache,
                refresh_request_path=args.dependency_refresh,
            )
        return analyze_file_dependencies(
            args.target,
            project_root=args.project_root,
            cache_path=args.cache,
        )
    if args.mode == 'functions':
        # The Code-XR IDE's Problems panel (#173): per-function metrics, no scene.
        from function_metrics import analyze_function_metrics
        return analyze_function_metrics(
            args.target,
            args.type,
            recursive=args.deep,
            filtered_files=args.files,
            project_root=args.project_root,
        )
    if args.mode == 'livePanel' and args.type == 'file':
        from livePanel_file_analysis_coordinator import analyze_file_comprehensive
        return analyze_file_comprehensive(args.target)
    if args.mode == 'livePanel' and args.type == 'directory':
        from livePanel_directory_analysis_coordinator import analyze_directory_comprehensive
        from livePanel_directory_deep_analysis_coordinator import analyze_directory_deep_comprehensive
        return analyze_directory_deep_comprehensive(args.target, args.files) if args.deep else analyze_directory_comprehensive(args.target, args.files)
    if args.mode == 'xr' and args.type == 'file':
        from xr_file_analysis_coordinator import analyze_file_for_xr
        return analyze_file_for_xr(args.target)
    if args.mode == 'xr' and args.type == 'directory':
        from xr_directory_analysis_coordinator import analyze_directory_xr
        return analyze_directory_xr(args.target, is_deep=args.deep, filtered_files=args.files)
    raise ValueError(f'Unsupported combination: {args.mode} + {args.type}')


def _emit(payload):
    """Print one result between the markers executePython.ts parses."""
    print('=== JSON_START ===')
    print(json.dumps(payload, indent=2))
    print('=== JSON_END ===')


def execute_schema_request(target_type):
    if target_type not in {'file', 'directory'}:
        raise ValueError(f'Unsupported schema type: {target_type}')

    log_debug(f'Returning XR schema metadata for {target_type}...')
    return get_xr_schema(target_type)


if __name__ == '__main__':
    main()
