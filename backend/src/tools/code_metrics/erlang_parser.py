"""Function structure for Erlang.

A function is every clause of one name in a top-level form (`name(...) -> ...;
name(...) -> ... .`). Branching constructs (`case`, `if`, `receive`, `try`,
multi-clause `fun`) add one decision per clause beyond the first, as do extra
function clauses; each `when` guard and each `andalso`/`orelse`/`and`/`or`
adds one. `case`/`if`/`receive`/`try` bodies nest; anonymous funs belong to
the enclosing function, like Lizard does.
"""

from __future__ import annotations

from code_metrics.lexer import Token
from code_metrics.model import Function, join_tokens, split_params

BRANCHING = frozenset({'case', 'if', 'receive', 'try', 'fun'})
NESTING = frozenset({'case', 'if', 'receive', 'try'})
OPENERS = BRANCHING | {'begin'}


def _forms(tokens: list[Token]) -> list[list[Token]]:
    forms: list[list[Token]] = []
    current: list[Token] = []
    blocks = 0
    brackets = 0
    for pos, token in enumerate(tokens):
        current.append(token)
        text = token.text
        if token.kind == 'id':
            if text in OPENERS and not (text == 'fun' and pos + 1 < len(tokens) and tokens[pos + 1].text != '('):
                blocks += 1
            elif text == 'end':
                blocks = max(blocks - 1, 0)
        elif token.kind == 'op':
            if text in '([{':
                brackets += 1
            elif text in ')]}':
                brackets = max(brackets - 1, 0)
            elif text == '.' and blocks == 0 and brackets == 0:
                forms.append(current)
                current = []
    if current:
        forms.append(current)
    return forms


def _args(form: list[Token], open_pos: int) -> tuple[list[Token], int]:
    level = 0
    args: list[Token] = []
    for pos in range(open_pos, len(form)):
        text = form[pos].text
        if text in '([{' and form[pos].kind == 'op':
            level += 1
            if level == 1:
                continue
        elif text in ')]}' and form[pos].kind == 'op':
            level -= 1
            if level == 0:
                return args, pos
        args.append(form[pos])
    return args, len(form)


def parse_erlang(lang, tokens: list[Token]) -> list[Function]:
    functions: list[Function] = []
    for form in _forms(tokens):
        if form[0].text == '-' or form[0].kind != 'id' or len(form) < 2 or form[1].text != '(':
            continue
        name = form[0].text
        args, _ = _args(form, 1)
        func = Function(name, form[0].line)
        func.params = split_params(args)
        func.long_name = f'{name}({join_tokens(args)})'
        functions.append(func)

        # stack of open blocks: [keyword, top-level `->` count, bracket level at open]
        stack: list[list] = []
        brackets = 0
        clauses = 0
        for pos, token in enumerate(form):
            func.own(token, sum(1 for b in stack if b[0] in NESTING))
            text = token.text
            if token.kind == 'op':
                if text in '([{':
                    brackets += 1
                elif text in ')]}':
                    brackets -= 1
                elif text == '->':
                    if stack and stack[-1][2] == brackets:
                        stack[-1][1] += 1
                    elif not stack and brackets == 0:
                        clauses += 1
                continue
            if token.kind != 'id' or (pos and form[pos - 1].text in (':', '#', '?')):
                continue
            if text in ('andalso', 'orelse', 'and', 'or', 'when'):
                func.complexity += 1
            elif text in OPENERS:
                if text == 'fun' and (pos + 1 >= len(form) or form[pos + 1].text != '('):
                    continue        # `fun name/2` is a reference, not a block
                stack.append([text, 0, brackets])
                if text in NESTING:
                    func.note_depth(sum(1 for b in stack if b[0] in NESTING))
            elif text == 'end' and stack:
                keyword, arms, _ = stack.pop()
                if keyword in BRANCHING and arms > 1:
                    func.complexity += arms - 1
        if clauses > 1:
            func.complexity += clauses - 1
    return sorted(functions, key=lambda f: (f.start_line, f.name))
