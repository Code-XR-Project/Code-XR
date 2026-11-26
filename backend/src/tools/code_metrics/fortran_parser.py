"""Function structure for Fortran (free and fixed form, case-insensitive).

Works on statements: physical lines joined by `&` continuations and split on
`;`. Program units (`function`, `subroutine`, `program`) are functions,
qualified with their `module` like Lizard does (`mod::name`). Decisions are
each `if` (block or logical), `do` loop, non-default `case` and `.and.`/`.or.`.
`if ... then`, `do`, `select`, `where` and `forall` blocks nest.
"""

from __future__ import annotations

from dataclasses import dataclass

from code_metrics.lexer import Token
from code_metrics.model import Function, join_tokens, split_params

UNIT_KEYWORDS = ('function', 'subroutine', 'program')
NESTING = frozenset({'if', 'do', 'select', 'where', 'forall'})
PLAIN_BLOCKS = frozenset({'block', 'associate', 'critical', 'interface', 'type', 'enum'})
END_ALIASES = {
    'endif': 'if', 'enddo': 'do', 'endselect': 'select', 'endfunction': 'function',
    'endsubroutine': 'subroutine', 'endprogram': 'program', 'endmodule': 'module', 'endwhere': 'where',
    'endforall': 'forall', 'endinterface': 'interface', 'endtype': 'type', 'endblock': 'block',
    'endassociate': 'associate', 'endcritical': 'critical', 'endenum': 'enum', 'endsubmodule': 'module',
}


@dataclass
class FBlock:
    kind: str
    depth: int
    func: Function | None = None
    name: str = ''
    label: str = ''


def _statements(tokens: list[Token]) -> list[list[Token]]:
    statements: list[list[Token]] = []
    current: list[Token] = []
    for token in tokens:
        if current and token.line > current[-1].end_line:
            if current[-1].text == '&':
                current.pop()
            else:
                statements.append(current)
                current = []
        if token.text == '&' and not current:
            continue            # leading & of a continuation line
        if token.text == '&' and current and current[-1].line != token.line:
            continue
        if token.text == ';':
            if current:
                statements.append(current)
            current = []
            continue
        current.append(token)
    if current:
        statements.append(current)
    return statements


def parse_fortran(lang, tokens: list[Token]) -> list[Function]:
    functions: list[Function] = []
    stack: list[FBlock] = []
    in_interface = 0

    def current_func() -> Function | None:
        for block in reversed(stack):
            if block.func is not None:
                return block.func
        return None

    def depth() -> int:
        return stack[-1].depth if stack else 0

    def module_path() -> list[str]:
        return [b.name for b in stack if b.kind == 'module' and b.name]

    def pop_kind(kind: str) -> None:
        for pos in range(len(stack) - 1, -1, -1):
            if stack[pos].kind == kind or (kind in UNIT_KEYWORDS and stack[pos].kind in UNIT_KEYWORDS):
                del stack[pos:]
                return

    for statement in _statements(tokens):
        words = [t.text for t in statement]
        label = ''
        if statement[0].kind == 'num':
            label = words[0]
            statement = statement[1:]
            words = words[1:]
            if not statement:
                continue
        # `name: do ...` construct names
        if len(words) > 2 and words[1] == ':' and statement[0].kind == 'id' and words[2] in ('do', 'if', 'select',
                                                                                             'where', 'forall'):
            statement = statement[2:]
            words = words[2:]

        func = current_func()
        if func is not None and not in_interface:
            for token in statement:
                func.own(token)

        head = words[0]
        # labelled DO loop terminated by this label (F77 `do 10 i = ...` / `10 continue`)
        if label:
            while stack and stack[-1].kind == 'do' and stack[-1].label == label:
                stack.pop()

        # ----- end statements
        if head in END_ALIASES or head == 'end':
            kind = END_ALIASES.get(head) or (words[1] if len(words) > 1 else '')
            kind = {'subroutine': 'function', 'program': 'function', 'submodule': 'module'}.get(kind, kind)
            if kind == 'interface':
                in_interface = max(in_interface - 1, 0)
            if not kind:
                # bare END closes the innermost program unit
                for pos in range(len(stack) - 1, -1, -1):
                    if stack[pos].kind in ('function', 'module'):
                        del stack[pos:]
                        break
            else:
                pop_kind(kind)
            continue

        if in_interface:
            if head == 'interface' or (len(words) > 1 and words[0] == 'abstract' and words[1] == 'interface'):
                in_interface += 1
            continue

        # ----- program units
        unit_pos = next((p for p, w in enumerate(words) if w in UNIT_KEYWORDS and statement[p].kind == 'id'), None)
        if (unit_pos is not None and head not in ('call', 'end') and '=' not in words[:unit_pos]
                and unit_pos + 1 < len(words) and statement[unit_pos + 1].kind == 'id'
                and not (head == 'module' and len(words) > 1 and words[1] == 'procedure' and unit_pos > 2)):
            name_token = statement[unit_pos + 1]
            name = '::'.join(module_path() + [name_token.source])
            new = Function(name, name_token.line)
            params: list[Token] = []
            if unit_pos + 2 < len(statement) and statement[unit_pos + 2].text == '(':
                level = 0
                for token in statement[unit_pos + 2:]:
                    if token.text == '(':
                        level += 1
                        if level == 1:
                            continue
                    elif token.text == ')':
                        level -= 1
                        if level == 0:
                            break
                    params.append(token)
            new.params = split_params(params)
            new.long_name = f'{name}({join_tokens(params)})'
            for token in statement:
                new.own(token)
            functions.append(new)
            stack.append(FBlock('function', 0, new))
            continue
        if head == 'module' and len(words) > 1 and words[1] != 'procedure':
            stack.append(FBlock('module', 0, name=statement[1].source))
            continue
        if head == 'submodule':
            stack.append(FBlock('module', 0))
            continue
        if head == 'interface' or (head == 'abstract' and len(words) > 1 and words[1] == 'interface'):
            in_interface += 1
            continue
        if head == 'contains':
            continue

        # ----- decisions
        if func is not None:
            for pos, word in enumerate(words):
                token = statement[pos]
                if token.kind == 'op' and word in ('.and.', '.or.'):
                    func.complexity += 1
                elif token.kind == 'id' and word == 'if' and (pos == 0 or words[pos - 1] in ('else', ')')):
                    func.complexity += 1
                elif token.kind == 'id' and word == 'do' and pos == 0:
                    func.complexity += 1
                elif token.kind == 'id' and word == 'case' and pos == 0 and not (
                        len(words) > 1 and words[1] == 'default'):
                    func.complexity += 1

        # ----- blocks
        if head == 'if':
            if words[-1] == 'then':
                stack.append(FBlock('if', depth() + 1))
                if func is not None:
                    func.note_depth(depth())
            elif func is not None:
                func.note_depth(depth() + 1)      # logical IF: one statement, one level deeper
        elif head == 'do':
            loop_label = words[1] if len(words) > 1 and statement[1].kind == 'num' else ''
            stack.append(FBlock('do', depth() + 1, label=loop_label))
            if func is not None:
                func.note_depth(depth())
        elif head == 'select':
            stack.append(FBlock('select', depth() + 1))
            if func is not None:
                func.note_depth(depth())
        elif head in ('where', 'forall'):
            # block form only when nothing follows the closing parenthesis
            level = 0
            close = None
            for pos, word in enumerate(words):
                if word == '(':
                    level += 1
                elif word == ')':
                    level -= 1
                    if level == 0:
                        close = pos
                        break
            if close is not None and close == len(words) - 1:
                stack.append(FBlock(head, depth() + 1))
                if func is not None:
                    func.note_depth(depth())
        elif head == 'type' and len(words) > 1 and words[1] != '(':
            stack.append(FBlock('type', depth()))
        elif head in ('block', 'associate', 'critical', 'enum') and (len(words) == 1 or words[1] in ('(', ',')):
            stack.append(FBlock(head, depth()))
    return sorted(functions, key=lambda f: (f.start_line, f.name))
