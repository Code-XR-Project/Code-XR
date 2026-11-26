"""Halstead's software-science metrics, from a function's own tokens.

Operands are identifiers that are not reserved words, plus number and string
literals; operators are reserved words and operator/punctuation tokens. A
closing bracket is not a separate operator: ``(...)``, ``[...]`` and
``{...}`` each count once, at the opening bracket.

    n1, n2  distinct operators, distinct operands
    N1, N2  total operators, total operands
    volume      V = (N1 + N2) * log2(n1 + n2)
    difficulty  D = n1 / 2 * N2 / n2
    effort      E = D * V
    bugs        B = V / 3000

Every value is 0 rather than NaN on an empty input.
"""

from __future__ import annotations

import math

from code_metrics.keywords import reserved_words
from code_metrics.languages import Language
from code_metrics.lexer import Token

_CLOSERS = {')', ']', '}'}


def halstead(lang: Language, items: list[tuple[Token, int]]) -> dict[str, float]:
    reserved = reserved_words(lang.name)
    operators: dict[str, int] = {}
    operands: dict[str, int] = {}
    for token, _ in items:
        text = token.text
        if token.kind in ('num', 'str'):
            operands[text] = operands.get(text, 0) + 1
        elif token.kind == 'id' and text not in reserved and text not in lang.bool_ops:
            operands[text] = operands.get(text, 0) + 1
        elif text not in _CLOSERS:
            operators[text] = operators.get(text, 0) + 1
    n1, n2 = len(operators), len(operands)
    big_n1, big_n2 = sum(operators.values()), sum(operands.values())
    vocabulary = n1 + n2
    length = big_n1 + big_n2
    volume = length * math.log2(vocabulary) if vocabulary > 1 else 0.0
    difficulty = (n1 / 2) * (big_n2 / n2) if n2 else 0.0
    effort = difficulty * volume
    return {
        'vocabulary': vocabulary,
        'length': length,
        'volume': round(volume, 2),
        'difficulty': round(difficulty, 2),
        'effort': round(effort, 2),
        'bugs': round(volume / 3000, 4),
    }


def maintainability_index(volume: float, complexity: int, nloc: int) -> float:
    """Normalised maintainability index (0-100), the Visual Studio form.

    MI = max(0, (171 - 5.2 ln V - 0.23 CCN - 16.2 ln LOC) * 100 / 171), with V and
    LOC floored at 1 so that an empty function does not take a log of zero.
    """
    raw = 171 - 5.2 * math.log(max(volume, 1.0)) - 0.23 * complexity - 16.2 * math.log(max(nloc, 1))
    return round(min(100.0, max(0.0, raw * 100 / 171)), 1)
