"""What the parsers produce: one record per function, plus helpers they share."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from code_metrics.lexer import Token


@dataclass
class Function:
    name: str
    start_line: int
    end_line: int = 0
    params: list[list[Token]] = field(default_factory=list)
    long_name: str = ''
    complexity: int = 1
    max_nesting: int = 0
    lines: set[int] = field(default_factory=set)
    parameter_count: int | None = None   # set when params are not a token list (Perl, Obj-C)
    # Every token the function owns, once, with its cognitive nesting level
    # (the input of the cognitive-complexity and Halstead metrics).
    tokens: list[tuple[Token, int]] = field(default_factory=list)
    _owned: set[int] = field(default_factory=set, repr=False)
    cognitive_complexity: int = 0
    halstead: dict = field(default_factory=dict)

    def own(self, token: Token, level: int = 0) -> None:
        self.lines.update(range(token.line, token.end_line + 1))
        if token.end_line > self.end_line:
            self.end_line = token.end_line
        key = id(token)
        if key not in self._owned:
            self._owned.add(key)
            self.tokens.append((token, level))

    def note_depth(self, depth: int) -> None:
        if depth > self.max_nesting:
            self.max_nesting = depth

    def to_record(self) -> dict:
        count = self.parameter_count if self.parameter_count is not None else len(self.params)
        return {
            'name': self.name,
            'long_name': self.long_name or self.name,
            'start_line': self.start_line,
            'end_line': max(self.end_line, self.start_line),
            'nloc': len(self.lines),
            'cyclomatic_complexity': self.complexity,
            'parameter_count': count,
            'max_nesting_depth': self.max_nesting,
            'cognitive_complexity': self.cognitive_complexity,
            'halstead': dict(self.halstead),
        }


def join_tokens(tokens: list[Token]) -> str:
    """Readable source text of a token run: spaces only where two words would merge."""
    out = ''
    prev_pointer = False
    for token in tokens:
        text = token.source
        if out and (out[-1].isalnum() or out[-1] in '_$') and (text[0].isalnum() or text[0] in '_$'):
            out += ' '
        elif out and text in (',',):
            pass
        elif out and (out[-1] == ',' or (out[-1] == ':' and not out.endswith('::') and text not in ')]},:')):
            out += ' '             # `a, b` and the type annotation `a: T`
        elif out and prev_pointer and (text[0].isalpha() or text[0] == '_'):
            out += ' '             # `const T& name`, `char* name`
        prev_pointer = text in ('&', '&&', '*', '**') and len(out) > 0 and (out[-1].isalnum() or out[-1] in '>_')
        out += text
    return out


def split_params(tokens: list[Token], ignore: tuple[str, ...] = ()) -> list[list[Token]]:
    """Split the tokens inside a parameter list on top-level commas."""
    params: list[list[Token]] = []
    current: list[Token] = []
    depth = 0
    for token in tokens:
        text = token.text
        if text in '([{' and token.kind == 'op':
            depth += 1
        elif text in ')]}' and token.kind == 'op':
            depth = max(depth - 1, 0)
        elif text == '<' and token.kind == 'op':
            depth += 1
        elif text == '>' and token.kind == 'op' and depth:
            depth -= 1
        elif text == '>>' and token.kind == 'op' and depth:
            depth = max(depth - 2, 0)
        if text == ',' and depth == 0:
            params.append(current)
            current = []
            continue
        current.append(token)
    params.append(current)
    cleaned = []
    for param in params:
        texts = [t.text for t in param]
        if not texts or texts in (['void'],) or (len(texts) == 1 and texts[0] in ignore):
            continue
        cleaned.append(param)
    return cleaned


def normalize_space(text: str) -> str:
    return re.sub(r'\s+', '', text or '')
