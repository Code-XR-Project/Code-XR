"""Function structure for indentation-delimited languages (Python, GDScript).

Tokens are grouped into logical lines (a line continues while a bracket is
open). A line ending in `:` opens a block whose body is every following line
indented deeper than the first body line; a dedent below that indentation
closes it. `def`/`func` blocks are functions, `class` blocks are scopes, and
`if`/`elif`/`else`/`for`/`while`/`try`/`except`/`finally`/`match` bodies are
one nesting level deeper. `case` arms share their `match` level.
"""

from __future__ import annotations

from dataclasses import dataclass

from code_metrics.common import is_decision
from code_metrics.languages import Language
from code_metrics.lexer import Token
from code_metrics.model import Function, join_tokens, split_params

CONTROL = frozenset({'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'match'})
FUNCTION_KEYWORDS = frozenset({'def', 'func'})
SCOPE_KEYWORDS = frozenset({'class'})


@dataclass
class IBlock:
    header_indent: int
    body_indent: int | None
    keyword: str
    depth: int
    func: Function | None = None
    docstring_pending: bool = False


def _logical_lines(tokens: list[Token]) -> list[list[Token]]:
    lines: list[list[Token]] = []
    current: list[Token] = []
    depth = 0
    for token in tokens:
        if current and depth == 0 and token.line > current[-1].end_line:
            lines.append(current)
            current = []
        current.append(token)
        if token.kind == 'op':
            if token.text in '([{':
                depth += 1
            elif token.text in ')]}':
                depth = max(depth - 1, 0)
    if current:
        lines.append(current)
    return lines


def _block_colon(line: list[Token]) -> int | None:
    """Index of the `:` that opens a block on this line, or None."""
    depth = 0
    lambdas = 0
    for pos, token in enumerate(line):
        text = token.text
        if token.kind == 'op' and text in '([{':
            depth += 1
        elif token.kind == 'op' and text in ')]}':
            depth -= 1
        elif depth == 0 and text == 'lambda':
            lambdas += 1
        elif depth == 0 and text == ':' and token.kind == 'op':
            if lambdas:
                lambdas -= 1
                continue
            return pos
    return None


def _first_keyword(line: list[Token]) -> tuple[str, int]:
    pos = 0
    while pos < len(line) and line[pos].text in ('async', 'static', 'remote', 'master', 'puppet', 'export'):
        pos += 1
    return (line[pos].text if pos < len(line) else ''), pos


def parse_indent(lang: Language, tokens: list[Token]) -> list[Function]:
    functions: list[Function] = []
    stack: list[IBlock] = []
    index_of = {id(token): i for i, token in enumerate(tokens)}

    def current_func() -> Function | None:
        for block in reversed(stack):
            if block.func is not None:
                return block.func
        return None

    for line in _logical_lines(tokens):
        if line[0].text == '@' and lang.name == 'Python':
            # decorator: belongs to the following definition, not to an enclosing body
            pass
        indent = line[0].col
        # close finished blocks
        while stack:
            top = stack[-1]
            if top.body_indent is None:
                if indent > top.header_indent:
                    top.body_indent = indent
                    break
                stack.pop()
                continue
            if indent < top.body_indent:
                stack.pop()
                continue
            break

        parent_depth = stack[-1].depth if stack else 0
        func = current_func()
        keyword, kw_pos = _first_keyword(line)
        colon = _block_colon(line)

        # match arms in GDScript have no keyword: every direct child line of `match` ending in `:`
        if (lang.match_arm_keyword == '*' and stack and stack[-1].keyword == 'match' and colon is not None
                and func is not None and indent == stack[-1].body_indent):
            if not (line[0].text == '_' and colon == 1):
                func.complexity += 1
            keyword = 'case'

        if keyword in FUNCTION_KEYWORDS and kw_pos + 1 < len(line) and line[kw_pos + 1].kind == 'id':
            name_token = line[kw_pos + 1]
            name = name_token.text
            outer = current_func()
            if outer is not None and lang.name == 'Python':
                name = f'{outer.name}.{name}'
            new = Function(name, name_token.line)
            params: list[Token] = []
            if kw_pos + 2 < len(line) and line[kw_pos + 2].text == '(':
                depth = 0
                for token in line[kw_pos + 2:]:
                    if token.text in '([{' and token.kind == 'op':
                        depth += 1
                        if depth == 1:
                            continue
                    elif token.text in ')]}' and token.kind == 'op':
                        depth -= 1
                        if depth == 0:
                            break
                    params.append(token)
            new.params = split_params(params, ignore=('*', '/'))
            new.long_name = f'{name}({join_tokens(params)})'
            functions.append(new)
            if outer is not None:
                for token in line:
                    outer.own(token)       # the nested `def` statement is a line of the outer body too
            for token in line[kw_pos + 1:]:
                new.own(token)
                if is_decision(lang, tokens, index_of[id(token)]):
                    new.complexity += 1
            if colon is not None and colon < len(line) - 1:
                pass  # one-line body: already owned above
            else:
                stack.append(IBlock(indent, None, keyword, 0, new, docstring_pending=lang.name == 'Python'))
            continue

        if stack and stack[-1].docstring_pending:
            stack[-1].docstring_pending = False
            if len(line) == 1 and line[0].kind == 'str':
                continue          # a docstring is documentation, not code (PEP 257)
        if func is not None:
            for token in line:
                func.own(token)
                if is_decision(lang, tokens, index_of[id(token)]):
                    func.complexity += 1

        if colon is None:
            continue
        if keyword in SCOPE_KEYWORDS:
            depth = 0
        elif keyword in CONTROL:
            depth = parent_depth + 1
        else:
            depth = parent_depth
        if func is not None:
            func.note_depth(depth)
        if colon == len(line) - 1:
            stack.append(IBlock(indent, None, keyword, depth))
    return sorted(functions, key=lambda f: (f.start_line, f.name))
