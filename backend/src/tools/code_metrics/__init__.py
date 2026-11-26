"""Code-XR's own per-function metrics: function list, NLOC, CCN, parameters, nesting depth,
cognitive complexity, Halstead and the maintainability index (epic #219).

Replaces Lizard (epic #140). Pure Python, no network, no native code. The
definitions are in docs/lizard-replacement/SPEC.md; the public entry point for
the backend is ``code_metrics_analyzer.analyze_file``.
"""

from __future__ import annotations

from code_metrics.brace_parser import parse_brace
from code_metrics.cognitive import cognitive_complexity
from code_metrics.halstead import halstead, maintainability_index
from code_metrics.end_parser import parse_end
from code_metrics.erlang_parser import parse_erlang
from code_metrics.fortran_parser import parse_fortran
from code_metrics.indent_parser import parse_indent
from code_metrics.languages import EXTENSION_LANGUAGE, FIXED_FORM_EXTENSIONS, LANGUAGES, Language
from code_metrics.lexer import Lexer
from code_metrics.model import Function

PARSERS = {
    'brace': parse_brace,
    'indent': parse_indent,
    'ruby': parse_end,
    'lua': parse_end,
    'fortran': parse_fortran,
    'erlang': parse_erlang,
}


def language_for_extension(extension: str) -> Language | None:
    name = EXTENSION_LANGUAGE.get(extension.lower())
    return LANGUAGES.get(name) if name else None


def analyze_source(text: str, language: Language, fixed_form: bool = False) -> tuple[list[Function], int]:
    """Return (functions, file NLOC) for one source text."""
    config = language.lexer
    if fixed_form and not config.fixed_form_comments:
        from dataclasses import replace
        config = replace(config, fixed_form_comments=True)
    tokens = Lexer(config).tokenize(text)
    code_lines: set[int] = set()
    for token in tokens:
        code_lines.update(range(token.line, token.end_line + 1))
    functions = PARSERS[language.family](language, tokens)
    for func in functions:
        func.tokens.sort(key=lambda item: (item[0].line, item[0].col))
        func.cognitive_complexity = cognitive_complexity(language, func.tokens)
        func.halstead = halstead(language, func.tokens)
    return functions, len(code_lines)


__all__ = ['analyze_source', 'language_for_extension', 'maintainability_index', 'FIXED_FORM_EXTENSIONS', 'LANGUAGES']
