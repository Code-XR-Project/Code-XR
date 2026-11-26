#!/usr/bin/env python3
"""Downloads the tree-sitter parsers the dependency graph uses (Code-XR set-up).

Run by the Code-XR environment set-up, after the person agreed to it, with the
venv's own Python. Prints one JSON line: the cache folder, the grammars
requested, downloaded and missing. Parsers already in the
venv are not fetched again, so a run with nothing missing makes no network call. Exit code 0 even when some are missing:
those languages fall back to pattern matching.

With ``--check`` it only reports which parsers are missing and never touches
the network (the IDE's About dialog, #161).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

UTILS_DIR = Path(__file__).resolve().parent.parent / "utils"
if str(UTILS_DIR) not in sys.path:
    sys.path.insert(0, str(UTILS_DIR))

from metric_language_contract import get_metric_language_names  # noqa: E402
from tree_sitter_parsers import download_grammars, is_available, required_grammars  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    check_only = "--check" in (sys.argv[1:] if argv is None else argv)
    grammars = required_grammars(get_metric_language_names())
    missing = [grammar for grammar in grammars if not is_available(grammar)]
    if check_only:
        available = [grammar for grammar in grammars if grammar not in missing]
        print(json.dumps({"requested": grammars, "downloaded": available, "missing": missing}))
        return 0
    if not missing:
        # Everything is cached already: no network at all.
        print(json.dumps({"requested": grammars, "downloaded": grammars, "missing": []}))
        return 0
    try:
        result = download_grammars(missing)
    except Exception as error:  # noqa: BLE001 - report, never crash the set-up
        result = {"requested": missing, "downloaded": [], "missing": missing, "error": str(error)}
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
