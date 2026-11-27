"""Tree-sitter parsers for the dependency graph, kept inside the Code-XR venv.

Since 1.x, tree-sitter-language-pack fetches each language's parser from
GitHub the first time it is asked for it. Code-XR never lets that happen
during an analysis: the parsers are downloaded once, by the environment
set-up the person agreed to (``tools/download_parsers.py``), into a folder of
the venv itself, so removing the environment removes them too. At analysis
time a parser is used only if it is already in that folder; otherwise the
dependency engine falls back to pattern matching, with no network access.
"""

from __future__ import annotations

import functools
import os
import sys
from typing import Iterable, get_args

# Folder (inside the venv, ``sys.prefix``) that holds the downloaded parsers.
CACHE_DIR_NAME = "codexr-tree-sitter"

# Metric language names whose tree-sitter grammar is named differently.
_GRAMMAR_ALIASES = {
    "C++": "cpp", "C#": "csharp", "Objective-C": "objc",
    "JavaScript": "javascript", "TypeScript": "typescript",
    "TTCN-3": "ttcn", "GDScript": "gdscript", "Shell": "bash",
}

_configured_for: str | None = None


def grammar_for(language: str) -> str:
    """The tree-sitter grammar name for a Code-XR metric language name."""
    return _GRAMMAR_ALIASES.get(language, language.lower().replace("-", "").replace(" ", "_"))


def parser_cache_dir(prefix: str | None = None) -> str:
    """Where this venv keeps its parsers (``<venv>/codexr-tree-sitter``)."""
    return os.path.join(prefix if prefix is not None else sys.prefix, CACHE_DIR_NAME)


def _pack():
    import tree_sitter_language_pack  # noqa: PLC0415 - optional: absent in the test venvs
    return tree_sitter_language_pack


def _configure(pack) -> None:
    """Points the pack at the venv's folder (once per process; configure() itself never downloads)."""
    global _configured_for
    cache = parser_cache_dir()
    if _configured_for != cache:
        pack.configure(pack.PackConfig(cache_dir=cache))
        _configured_for = cache


def supported_grammars() -> set[str]:
    """Every grammar this version of the pack can provide (a static list, no network)."""
    try:
        return set(get_args(_pack().SupportedLanguage))
    except ImportError:
        return set()


def required_grammars(language_names: Iterable[str]) -> list[str]:
    """The grammars the dependency graph can use for these languages, sorted."""
    supported = supported_grammars()
    return sorted({grammar_for(name) for name in language_names} & supported)


@functools.lru_cache(maxsize=1)
def cached_grammars() -> frozenset[str]:
    """Grammars already in the venv's folder. Reads the folder only, once per process."""
    try:
        pack = _pack()
        _configure(pack)
        return frozenset(pack.downloaded_languages())
    except Exception:  # noqa: BLE001 - no pack, or an unreadable cache: nothing is available
        return frozenset()


def is_available(grammar: str) -> bool:
    """True when ``grammar`` can be used without downloading anything."""
    return grammar in cached_grammars()


def download_grammars(grammars: list[str]) -> dict:
    """Downloads ``grammars`` into the venv's folder. Only the consented set-up calls this."""
    pack = _pack()
    _configure(pack)
    pack.download(grammars)
    cached_grammars.cache_clear()
    cached = set(pack.downloaded_languages())
    return {
        "cacheDir": parser_cache_dir(),
        "requested": grammars,
        "downloaded": sorted(cached & set(grammars)),
        "missing": sorted(set(grammars) - cached),
    }
