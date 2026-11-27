"""Decision counting shared by every parser family."""

from __future__ import annotations

from code_metrics.languages import Language
from code_metrics.lexer import Token

_MEMBER_ACCESS = {'.', '->', '::', '?.', '?->'}
_TERNARY_NOT_BEFORE = {':', '.', ')', ',', ']', '>', ';', '=', '}', '?'}


def is_ternary(tokens: list[Token], index: int) -> bool:
    """`?` at index is a conditional operator: a matching `:` follows in the same expression."""
    nxt = tokens[index + 1] if index + 1 < len(tokens) else None
    if nxt is None or nxt.text in _TERNARY_NOT_BEFORE:
        return False
    balance = 1
    depth = 0
    for token in tokens[index + 1:]:
        text = token.text
        if token.kind == 'op':
            if text in '([{':
                depth += 1
                continue
            if text in ')]}':
                if depth == 0:
                    return False
                depth -= 1
                continue
            if depth:
                continue
            if text in (';', ','):
                return False
            if text == '?':
                balance += 1
            elif text == ':':
                balance -= 1
                if balance == 0:
                    return True
    return False


_NOT_OPERANDS = frozenset({'move', 'return', 'in', 'else', 'break', 'yield', 'mut', 'match', 'if', 'while'})


def is_binary_position(tokens: list[Token], index: int) -> bool:
    """An operator at index follows an operand. Rust's `||` opening a closure and `&&x`, a reference to a
    reference, follow an operator or a keyword instead."""
    if index == 0:
        return False
    prev = tokens[index - 1]
    if prev.kind in ('num', 'str'):
        return True
    if prev.kind == 'id':
        return prev.text not in _NOT_OPERANDS
    return prev.text in (')', ']', '}', '?')


def is_decision(lang: Language, tokens: list[Token], index: int) -> bool:
    token = tokens[index]
    text = token.text
    prev = tokens[index - 1].text if index > 0 else ''
    if token.kind == 'id':
        if prev in _MEMBER_ACCESS:
            return False
        if text in lang.case_keywords:
            if lang.family == 'indent' and index > 0 and tokens[index - 1].end_line == token.line:
                return False           # Python's soft keyword: only `case` opening a line is an arm
            nxt = tokens[index + 1] if index + 1 < len(tokens) else None
            if nxt is not None and nxt.text in lang.default_markers:
                after = tokens[index + 2].text if index + 2 < len(tokens) else ''
                # `case _ =>`, `case _:`, `case else`, `case default`: the default arm.
                if nxt.text != '_' or after in ('=>', ':', '->'):
                    return False
            return True
        if text in lang.decisions:
            return True
        if text in lang.bool_ops:
            return True
        return False
    if token.kind == 'op':
        if text in lang.bool_ops and lang.prefix_bool_ops and not is_binary_position(tokens, index):
            return False
        if text in lang.bool_ops or text in lang.coalesce_ops:
            return True
        if text == '?' and lang.ternary:
            return is_ternary(tokens, index)
    return False
