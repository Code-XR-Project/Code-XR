"""Freeze what the pinned Lizard returns for the differential corpus.

Run from the repository root with an interpreter that has the PINNED lizard
(see backend/requirements.txt, or requirements-dev.txt once #145 lands)::

    python backend/tests/metrics_differential/regenerate_lizard_golden.py

The output is ``lizard_golden.json``. It is regenerated only when the corpus
changes, never to make a failing comparison pass.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND_ROOT = HERE.parents[1]
for extra in (BACKEND_ROOT / 'src' / 'tools', BACKEND_ROOT / 'src' / 'utils', HERE):
    sys.path.insert(0, str(extra))

import differential  # noqa: E402
from lizard_ext.version import version as lizard_version  # noqa: E402
from lizard_analyzer import analyze_file  # noqa: E402
from metric_language_contract import get_supported_metric_extensions  # noqa: E402


def pinned_version() -> str:
    text = (BACKEND_ROOT / 'requirements.txt').read_text(encoding='utf-8')
    match = re.search(r'^lizard==([\w.]+)', text, re.MULTILINE)
    if not match:
        raise SystemExit('lizard is not pinned in backend/requirements.txt')
    return match.group(1)


def main() -> None:
    expected = pinned_version()
    if lizard_version != expected:
        raise SystemExit(f'lizard {lizard_version} installed, {expected} pinned: install the pinned one')

    files = {}
    for relative in differential.corpus_files(differential.oracle_extensions(get_supported_metric_extensions())):
        files[relative] = differential.normalize(analyze_file(str(BACKEND_ROOT / relative)))

    document = {'lizardVersion': lizard_version, 'files': files}
    differential.GOLDEN_PATH.write_text(json.dumps(document, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    print(f'{len(files)} files -> {differential.GOLDEN_PATH.relative_to(BACKEND_ROOT.parent)}')


if __name__ == '__main__':
    main()
