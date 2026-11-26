"""Cognitive complexity (SonarSource, G. Ann Campbell 2017), from a function's own tokens.

Each parser hands every token it attributes to a function together with the
token's *cognitive nesting level*: the number of enclosing ``if``/``else``/
loop/``switch``/``catch`` bodies (``try`` and ``finally`` bodies do not nest).
On that stream the increments of the white paper are:

* **structural, +1 plus the nesting level**: ``if`` (and its statement-modifier
  forms), the conditional operator, ``switch``/``match``/``select``/Kotlin
  ``when``/Ruby and Erlang ``case``/``receive``, every loop, ``catch``/
  ``except``/``rescue``;
* **hybrid, +1 flat**: ``else if``/``elif``/``elsif``/``elseif`` and ``else``;
* **fundamental, +1 flat**: each *sequence* of like boolean operators
  (``a && b && c`` is +1, ``a && b || c`` is +2), ``goto``, a labelled
  ``break``/``continue``.

Never counted: ``case``/``when`` arms, default arms, ``try``, ``finally``,
null-coalescing, negation. Lambdas and nested functions do not add nesting
(they are separate functions in JavaScript/TypeScript, and part of the
enclosing body elsewhere), and recursion is not counted: both are recorded as
deviations from the white paper in docs/lizard-replacement/SPEC.md.
"""

from __future__ import annotations

from code_metrics.common import is_ternary
from code_metrics.languages import Language
from code_metrics.lexer import Token

_MEMBER_ACCESS = {'.', '::', '?.', '?->', '$'}
_ARROW_MEMBER_ACCESS = {'C', 'C++', 'Objective-C', 'PHP'}     # elsewhere `->` is an arm or a clause arrow
_AND = {'&&', 'and', 'andalso', '.and.', '-and'}
_OR = {'||', 'or', 'orelse', '.or.', '-or'}
_LOOPS = {'for', 'foreach', 'while', 'until', 'loop', 'repeat'}
_CATCH = {'catch', 'except', 'rescue', 'trap'}
_FLAT_ELSE_IF = {'elif', 'elsif', 'elseif'}
_DO_LOOP_LANGUAGES = {'C', 'C++', 'Objective-C', 'Java', 'C#', 'JavaScript', 'TypeScript', 'Kotlin', 'PHP',
                      'Solidity', 'TTCN-3', 'Fortran', 'Dart', 'PowerShell'}
_SWITCH_BY_LANGUAGE = {
    'Kotlin': {'when'}, 'Ruby': {'case'}, 'Erlang': {'case', 'receive'}, 'Shell': {'case'},
    'Rust': {'match'}, 'Scala': {'match'}, 'PHP': {'switch', 'match'}, 'Go': {'switch', 'select'},
    'Fortran': {'select'}, 'TTCN-3': {'select', 'alt'}, 'R': {'switch'},
}
_BOOLEAN_RESET = {';', '{', '}', ',', '=', '?', ':', '=>', '->', 'return', 'then', 'do'}


def _switch_keywords(lang: Language) -> set[str]:
    return _SWITCH_BY_LANGUAGE.get(lang.name, {'switch'})


def _first_on_line(tokens: list[Token], index: int) -> bool:
    return index == 0 or tokens[index - 1].end_line < tokens[index].line


def _python_soft_match(tokens: list[Token], index: int) -> bool:
    """`match subject:` opening a statement (Python's `match` is a soft keyword)."""
    if not _first_on_line(tokens, index):
        return False
    nxt = tokens[index + 1] if index + 1 < len(tokens) else None
    if nxt is None or nxt.line != tokens[index].line or nxt.text in ('=', '.', ',', ')', ':'):
        return False
    last = index
    while last + 1 < len(tokens) and tokens[last + 1].line == tokens[index].line:
        last += 1
    return tokens[last].text == ':'


def _is_do_while_tail(tokens: list[Token], index: int) -> bool:
    """`} while (cond);` closing a do/repeat loop: the loop was counted at `do`/`repeat`."""
    if index == 0 or tokens[index - 1].text != '}':
        return False
    depth = 0
    for token in tokens[index + 1:]:
        if token.kind == 'op' and token.text in '([':
            depth += 1
        elif token.kind == 'op' and token.text in ')]':
            depth -= 1
        elif depth == 0 and token.text == '{':
            return False
        elif depth == 0 and (token.text == ';' or token.line != tokens[index].line):
            return True
    return True


def _structural(lang: Language, tokens: list[Token], index: int) -> bool:
    token = tokens[index]
    text = token.text
    prev = tokens[index - 1].text if index > 0 else ''
    family = lang.family
    if text == 'if':
        if prev == 'end' or (family == 'fortran' and prev == 'else'):
            return False
        return prev != 'else'
    if text in ('unless', 'guard'):
        return True
    if text in _LOOPS:
        if text == 'until' and lang.name == 'Lua':
            return False                       # `repeat ... until c`: counted at `repeat`
        if text == 'while' and family == 'fortran' and prev == 'do':
            return False                       # `do while (c)`: counted at `do`
        if text == 'while' and family == 'brace' and _is_do_while_tail(tokens, index):
            return False
        if text == 'for' and family == 'erlang':
            return False
        return True
    if text == 'do':
        if lang.name not in _DO_LOOP_LANGUAGES or prev == 'end':
            return False
        return True
    if text in _CATCH:
        return True
    if text in _switch_keywords(lang):
        if prev == 'end':
            return False
        if lang.name == 'Python':
            return False
        return True
    if text == 'match' and lang.name == 'Python':
        return _python_soft_match(tokens, index)
    return False


def _flat(lang: Language, tokens: list[Token], index: int) -> bool:
    text = tokens[index].text
    nxt = tokens[index + 1].text if index + 1 < len(tokens) else ''
    prev = tokens[index - 1].text if index > 0 else ''
    if text in _FLAT_ELSE_IF:
        return True
    if text == 'if' and prev == 'else':
        return True                            # `else if`: one hybrid increment for the pair
    if text == 'else':
        if nxt == 'if' or nxt in ('->', '=>', ','):
            return False                       # `else if` (counted at the `if`), default arms
        if lang.family == 'indent' and not _first_on_line(tokens, index):
            return False                       # Python's `a if c else b`: part of the conditional expression
        return True
    if text == 'goto':
        return True
    if text in ('break', 'continue') and lang.family == 'brace':
        label = tokens[index + 1] if index + 1 < len(tokens) else None
        return (label is not None and label.kind == 'id' and label.line == tokens[index].line
                and label.text not in lang.control)
    return False


def _boolean_kind(lang: Language, token: Token) -> str:
    text = token.text
    if text not in lang.bool_ops:
        return ''
    if text == '//' or (lang.name == 'Zig' and text == 'orelse'):
        return ''                              # null-coalescing, not a boolean operator
    if text in _AND:
        return 'and'
    if text in _OR:
        return 'or'
    return text


def cognitive_complexity(lang: Language, items: list[tuple[Token, int]]) -> int:
    tokens = [token for token, _ in items]
    total = 0
    last_boolean = ''
    for index, (token, level) in enumerate(items):
        text = token.text
        prev = tokens[index - 1] if index else None
        if prev is not None and token.kind == 'id' and (
                prev.text in _MEMBER_ACCESS or (prev.text == '->' and lang.name in _ARROW_MEMBER_ACCESS)):
            continue
        if text in _BOOLEAN_RESET or (prev is not None and token.line > prev.end_line
                                      and not (prev.kind == 'op' and prev.text not in (')', ']', '}'))):
            last_boolean = ''
        kind = _boolean_kind(lang, token)
        if kind:
            if kind != last_boolean:
                total += 1
            last_boolean = kind
            continue
        if token.kind == 'op':
            if text == '?' and lang.ternary and is_ternary(tokens, index):
                total += 1 + level
            continue
        if token.kind != 'id':
            continue
        if text in lang.control or text in _LOOPS or text in _CATCH:
            last_boolean = ''
        if _flat(lang, tokens, index):
            total += 1
        elif _structural(lang, tokens, index):
            total += 1 + level
    return total
