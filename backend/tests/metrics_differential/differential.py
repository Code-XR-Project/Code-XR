"""Differential comparison of a per-function metrics analyzer against Lizard.

Epic #140 replaces Lizard with Code-XR's own analyzer. The contract is:

* where Lizard is right, the new analyzer returns exactly what Lizard returns;
* where Lizard is wrong, the difference is listed in ``divergences.json`` with
  the reason and a pointer to ``docs/lizard-replacement/RESEARCH.md``.

What Lizard returns is frozen in ``lizard_golden.json`` (regenerate with
``regenerate_lizard_golden.py``), so the comparison needs no Lizard at test
time and keeps working after the dependency is gone. The records compared are
the ones ``backend/src/tools/lizard_analyzer.py`` emits, i.e. after Code-XR's
own parameter-count fallbacks, because that is what reaches the JSON.

Functions are matched by ``name@lineStart``. A divergence entry is one of:

* ``{"file", "function": "name@line", "field", "lizard", "ours", "reason", "spec"}``
  for one value of one function;
* ``{"file", "function": "name@line", "field": "presence", "lizard": bool, "ours": bool, ...}``
  for a function only one side reports;
* ``{"file", "function": "*", "field", "reason", "spec"}`` for one field of every
  function of a file (cosmetic ``longName`` spacing, for instance).

``compare`` returns the mismatches no entry covers and the entries that no
mismatch needed. Both must be empty: an unlisted mismatch is a regression, and a
listed one that no longer happens is a stale claim.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

BACKEND_ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
CORPUS_DIRS = (BACKEND_ROOT / 'manual_test', HERE / 'corpus')
GOLDEN_PATH = HERE / 'lizard_golden.json'
DIVERGENCES_PATH = HERE / 'divergences.json'

FIELDS = ('longName', 'lineEnd', 'lineCount', 'complexity', 'parameters', 'maxNestingDepth')
PRESENCE = 'presence'


def corpus_files(supported_extensions: Iterable[str]) -> list[str]:
    """Every corpus file with a metric-contract extension, as a backend-relative POSIX path."""
    wanted = {extension.lower() for extension in supported_extensions}
    files: list[str] = []
    for directory in CORPUS_DIRS:
        for path in sorted(directory.rglob('*')):
            if path.is_file() and path.suffix.lower() in wanted:
                files.append(path.relative_to(BACKEND_ROOT).as_posix())
    return files


def normalize(result: dict[str, Any]) -> dict[str, Any]:
    """Reduce an ``analyze_file`` answer to what is compared."""
    functions = {}
    for record in result.get('functions', []) or []:
        key = f"{record.get('name')}@{record.get('lineStart')}"
        functions[key] = {field: record.get(field) for field in FIELDS}
    return {'status': result.get('status'), 'functions': functions}


def _mismatches(file: str, lizard: dict[str, Any], ours: dict[str, Any]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if lizard.get('status') != ours.get('status'):
        found.append({'file': file, 'function': '', 'field': 'status',
                      'lizard': lizard.get('status'), 'ours': ours.get('status')})
    lizard_functions = lizard.get('functions', {})
    our_functions = ours.get('functions', {})
    for key in sorted(set(lizard_functions) | set(our_functions)):
        if key not in our_functions or key not in lizard_functions:
            found.append({'file': file, 'function': key, 'field': PRESENCE,
                          'lizard': key in lizard_functions, 'ours': key in our_functions})
            continue
        for field in FIELDS:
            if lizard_functions[key].get(field) != our_functions[key].get(field):
                found.append({'file': file, 'function': key, 'field': field,
                              'lizard': lizard_functions[key].get(field),
                              'ours': our_functions[key].get(field)})
    return found


def _covers(entry: dict[str, Any], mismatch: dict[str, Any]) -> bool:
    if entry['file'] != mismatch['file'] or entry['field'] != mismatch['field']:
        return False
    if entry['function'] == '*':
        return mismatch['function'] != '' and mismatch['field'] != PRESENCE
    return (entry['function'] == mismatch['function']
            and entry.get('lizard') == mismatch['lizard']
            and entry.get('ours') == mismatch['ours'])


def compare(golden: dict[str, Any], candidate: dict[str, Any],
            divergences: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (unlisted mismatches, stale divergence entries)."""
    mismatches: list[dict[str, Any]] = []
    for file in sorted(set(golden) | set(candidate)):
        mismatches.extend(_mismatches(file, golden.get(file, {}), candidate.get(file, {})))

    unlisted = [m for m in mismatches if not any(_covers(e, m) for e in divergences)]
    stale = [e for e in divergences if not any(_covers(e, m) for m in mismatches)]
    return unlisted, stale


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding='utf-8'))
