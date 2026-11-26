#!/usr/bin/env python3
"""Per-function code metrics for one file, computed by Code-XR's own analyzer.

Drop-in replacement for ``lizard_analyzer.analyze_file`` (epic #140): same
envelope (``file``/``functions``/``metrics``/``status``), same record keys.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

TOOLS_DIR = Path(__file__).resolve().parent
UTILS_DIR = TOOLS_DIR.parent / 'utils'
for _extra in (TOOLS_DIR, UTILS_DIR):
    if str(_extra) not in sys.path:
        sys.path.insert(0, str(_extra))

from code_metrics import FIXED_FORM_EXTENSIONS, LANGUAGES, analyze_source, language_for_extension  # noqa: E402

_VUE_SCRIPT = re.compile(r'<script(?P<attrs>[^>]*)>(?P<body>.*?)</script>', re.IGNORECASE | re.DOTALL)


def _vue_script(content: str) -> tuple[str, str] | None:
    """The first <script> block, kept at its original line numbers (everything else blanked)."""
    match = _VUE_SCRIPT.search(content)
    if not match:
        return None
    attrs = match.group('attrs') or ''
    language = 'TypeScript' if re.search(r'lang\s*=\s*["\']tsx?["\']', attrs, re.IGNORECASE) else 'JavaScript'
    before = re.sub(r'[^\n]', ' ', content[:match.start('body')])
    return language, before + match.group('body')


def _perl_parameter_count(source_lines: list[str], line_start: int, line_end: int) -> int:
    excerpt = '\n'.join(source_lines[max(line_start - 1, 0):min(line_end, line_start + 5, len(source_lines))])
    unpack = re.search(r'my\s*\(\s*(.*?)\s*\)\s*=\s*@_', excerpt, re.DOTALL)
    if unpack:
        return len([part for part in unpack.group(1).split(',') if part.strip()])
    return len(re.findall(r'my\s+[$@%]\w+\s*=\s*shift\b', excerpt))


def calculate_complexity_metrics(functions: list[dict[str, Any]]) -> dict[str, Any]:
    if not functions:
        return {
            'averageComplexity': 0,
            'maxComplexity': 0,
            'functionCount': 0,
            'highComplexityFunctions': 0,
            'criticalComplexityFunctions': 0,
        }
    complexities = [func['complexity'] for func in functions]
    return {
        'averageComplexity': round(sum(complexities) / len(complexities), 2),
        'maxComplexity': max(complexities),
        'functionCount': len(functions),
        'highComplexityFunctions': sum(1 for complexity in complexities if complexity > 10),
        'criticalComplexityFunctions': sum(1 for complexity in complexities if complexity > 25),
    }


def _unsupported_result(file_path: str, message: str) -> dict[str, Any]:
    return {
        'error': message,
        'file': {'filePath': file_path, 'fileName': os.path.basename(file_path), 'nloc': 0, 'functionCount': 0},
        'functions': [],
        'metrics': calculate_complexity_metrics([]),
        'status': 'unsupported',
    }


def analyze_file(file_path: str) -> dict[str, Any]:
    if not os.path.exists(file_path):
        return {'error': f'File not found: {file_path}', 'status': 'error'}
    extension = Path(file_path).suffix.lower()
    try:
        content = Path(file_path).read_text(encoding='utf-8', errors='ignore')
    except OSError as error:
        return {'error': str(error), 'status': 'error'}

    if extension == '.vue':
        script = _vue_script(content)
        if script is None:
            language = LANGUAGES['JavaScript']
            content = ''
        else:
            language, content = LANGUAGES[script[0]], script[1]
    else:
        language = language_for_extension(extension)
    if language is None:
        return _unsupported_result(file_path, f'Language not supported: {file_path}')

    try:
        functions, file_nloc = analyze_source(content, language, fixed_form=extension in FIXED_FORM_EXTENSIONS)
    except Exception as error:  # a parser bug must not take the whole analysis down
        return {'error': str(error), 'status': 'error'}

    source_lines = content.splitlines()
    records = []
    for func in functions:
        raw = func.to_record()
        parameters = raw['parameter_count']
        if language.name == 'Perl' and parameters == 0:
            parameters = _perl_parameter_count(source_lines, raw['start_line'], raw['end_line'])
        complexity = raw['cyclomatic_complexity']
        line_count = raw['nloc'] or max(raw['end_line'] - raw['start_line'] + 1, 0)
        records.append({
            'name': raw['name'],
            'longName': raw['long_name'],
            'lineStart': raw['start_line'],
            'lineEnd': raw['end_line'],
            'lineCount': line_count,
            'complexity': complexity,
            'parameters': parameters,
            'maxNestingDepth': raw['max_nesting_depth'],
            'cyclomaticDensity': round(complexity / max(line_count, 1), 3),
        })

    return {
        'file': {
            'filePath': file_path,
            'fileName': os.path.basename(file_path),
            'nloc': file_nloc,
            'functionCount': len(records),
        },
        'functions': records,
        'metrics': calculate_complexity_metrics(records),
        'status': 'success',
    }


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No file path provided', 'status': 'error'}))
        sys.exit(1)
    from babia_path_utils import normalize_output_paths
    print(json.dumps(normalize_output_paths(analyze_file(sys.argv[1]))))


if __name__ == '__main__':
    main()
