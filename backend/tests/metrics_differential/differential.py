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

Functions are paired by ``name@lineStart``, then by start line alone, then by
name alone (see ``_pair``), so a function Lizard names or places differently is
still compared field by field. ``longName`` is compared ignoring whitespace.
A divergence entry is one of:

* ``{"file", "function": "name@line", "field", "lizard", "ours", "reason", "spec"}``
  for one value of one function (``name@line`` is Lizard's key);
* ``{"file", "function": "name@line", "field": "presence", "lizard": bool, "ours": bool, ...}``
  for a function only one side reports (the key of the side that has it);
* ``{"file", "function": "*", "field", "reason", "spec"}`` for one field of every
  function. ``file`` may be a glob (``manual_test/*.go``) for a language-wide rule.

``compare`` returns the mismatches no entry covers and the entries that no
mismatch needed. Both must be empty: an unlisted mismatch is a regression, and a
listed one that no longer happens is a stale claim.
"""

from __future__ import annotations

import fnmatch
import json
import re
from pathlib import Path
from typing import Any, Iterable

BACKEND_ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
CORPUS_DIRS = (BACKEND_ROOT / 'manual_test', HERE / 'corpus')
GOLDEN_PATH = HERE / 'lizard_golden.json'
DIVERGENCES_PATH = HERE / 'divergences.json'

FIELDS = ('name', 'lineStart', 'longName', 'lineEnd', 'lineCount', 'complexity', 'parameters', 'maxNestingDepth')
# longName is signature text: only its non-blank characters are compared, so
# Lizard's token spacing ('f( int a , int b)') equals ours ('f(int a, int b)').
WHITESPACE_INSENSITIVE = ('longName',)
PRESENCE = 'presence'


# Languages added after Lizard was replaced (epic #219): no frozen Lizard output can
# be their oracle, so the differential corpus leaves them out. Their reference
# values are counted by hand in tests/new_metrics and tests/new_languages.
POST_LIZARD_EXTENSIONS = frozenset({'.rs', '.dart', '.sh', '.bash', '.ps1', '.psm1', '.r'})


def oracle_extensions(supported_extensions: Iterable[str]) -> list[str]:
    """The contract extensions the Lizard golden describes."""
    return [extension for extension in supported_extensions if extension.lower() not in POST_LIZARD_EXTENSIONS]


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


def _same(field: str, a: Any, b: Any) -> bool:
    if field in WHITESPACE_INSENSITIVE and isinstance(a, str) and isinstance(b, str):
        return re.sub(r'\s+', '', a) == re.sub(r'\s+', '', b)
    return a == b


def _pair(lizard_functions: dict[str, Any], our_functions: dict[str, Any]) -> list[tuple[str | None, str | None]]:
    """Match functions: same name@line first, then the same start line, then the same name.

    The fallbacks turn "Lizard names it differently" or "Lizard puts it on
    another line" into one field mismatch instead of a missing + an extra
    function, so every other field is still compared.
    """
    pairs: list[tuple[str | None, str | None]] = []
    left = sorted(set(lizard_functions) - set(our_functions))
    right = sorted(set(our_functions) - set(lizard_functions))
    pairs.extend((key, key) for key in sorted(set(lizard_functions) & set(our_functions)))
    for attribute in ('lineStart', 'name'):
        def value(functions, key):
            return functions[key].get(attribute)
        for key in list(left):
            wanted = value(lizard_functions, key)
            same_left = [k for k in left if value(lizard_functions, k) == wanted]
            same_right = [k for k in right if value(our_functions, k) == wanted]
            if len(same_left) == 1 and len(same_right) == 1:
                pairs.append((key, same_right[0]))
                left.remove(key)
                right.remove(same_right[0])
    pairs.extend((key, None) for key in left)
    pairs.extend((None, key) for key in right)
    return pairs


def _mismatches(file: str, lizard: dict[str, Any], ours: dict[str, Any]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if lizard.get('status') != ours.get('status'):
        found.append({'file': file, 'function': '', 'field': 'status',
                      'lizard': lizard.get('status'), 'ours': ours.get('status')})
    lizard_functions = lizard.get('functions', {})
    our_functions = ours.get('functions', {})
    for lizard_key, our_key in _pair(lizard_functions, our_functions):
        if lizard_key is None or our_key is None:
            key = lizard_key or our_key
            found.append({'file': file, 'function': key, 'field': PRESENCE,
                          'lizard': lizard_key is not None, 'ours': our_key is not None})
            continue
        for field in FIELDS:
            a = lizard_functions[lizard_key].get(field)
            b = our_functions[our_key].get(field)
            if not _same(field, a, b):
                found.append({'file': file, 'function': lizard_key, 'field': field, 'lizard': a, 'ours': b})
    return found


def _covers(entry: dict[str, Any], mismatch: dict[str, Any]) -> bool:
    if not fnmatch.fnmatchcase(mismatch['file'], entry['file']) or entry['field'] != mismatch['field']:
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
