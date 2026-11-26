"""Function structure for `end`-delimited languages: Ruby and Lua.

Block openers push onto a stack and `end` pops the innermost one (Lua's
`repeat` is closed by `until`, Ruby/Lua `{ }` by `}`). Ruby's statement
modifiers (`x if y`, `x while y`) open nothing: an `if` only opens a block
when it starts a statement.
"""

from __future__ import annotations

from dataclasses import dataclass

from code_metrics.common import is_decision
from code_metrics.languages import Language
from code_metrics.lexer import Token
from code_metrics.model import Function, join_tokens, split_params

RUBY_CONTROL = frozenset({'if', 'unless', 'while', 'until', 'for', 'case', 'begin'})
RUBY_OPENERS = RUBY_CONTROL | {'def', 'class', 'module', 'do'}
RUBY_MODIFIERS = frozenset({'if', 'unless', 'while', 'until', 'rescue'})
RUBY_STATEMENT_STARTERS = frozenset({'=', '(', '[', ',', '||', '&&', 'return', 'then', 'else', 'do', 'begin',
                                     '+=', '-=', '||=', '&&=', '<<', 'not', 'and', 'or', '{', '?', ':', '=>',
                                     ';', 'elsif', 'when', 'in', '|'})
LUA_CONTROL = frozenset({'if', 'for', 'while', 'repeat'})


@dataclass
class EBlock:
    keyword: str
    depth: int
    func: Function | None = None
    loop_header: bool = False       # Lua/Ruby `while ... do`: the `do` belongs to the loop
    cdepth: int = 0                 # cognitive nesting inside (`begin` bodies do not nest)


class EndParser:
    def __init__(self, lang: Language, tokens: list[Token]):
        self.lang = lang
        self.t = tokens
        self.stack: list[EBlock] = []
        self.functions: list[Function] = []
        self.ruby = lang.name == 'Ruby'

    def current_func(self) -> Function | None:
        for block in reversed(self.stack):
            if block.func is not None:
                return block.func
        return None

    def depth(self) -> int:
        return self.stack[-1].depth if self.stack else 0

    def cdepth(self) -> int:
        return self.stack[-1].cdepth if self.stack else 0

    def text(self, index: int) -> str:
        return self.t[index].text if 0 <= index < len(self.t) else ''

    def statement_start(self, index: int) -> bool:
        if index == 0:
            return True
        prev = self.t[index - 1]
        if prev.end_line < self.t[index].line:
            # a new line starts a statement unless the previous line continues
            return not (prev.kind == 'op' and prev.text in (',', '\\', '+', '-', '*', '&&', '||', '.', '=', '('))
        return prev.text in RUBY_STATEMENT_STARTERS

    def parse(self) -> list[Function]:
        for index, token in enumerate(self.t):
            func = self.current_func()
            text = token.text
            if func is not None:
                func.own(token, self.cdepth())
                if is_decision(self.lang, self.t, index):
                    func.complexity += 1
            if token.kind == 'op':
                if text == '{':
                    self.stack.append(EBlock('{', self.depth(), cdepth=self.cdepth()))
                elif text == '}':
                    self._pop('{')
                continue
            if token.kind != 'id' or self.text(index - 1) in ('.', '::', ':'):
                continue
            if self.ruby:
                self._ruby_token(index)
            else:
                self._lua_token(index)
        return sorted(self.functions, key=lambda f: (f.start_line, f.name))

    def _pop(self, closer: str) -> None:
        if not self.stack:
            return
        if closer == '{':
            while self.stack and self.stack[-1].keyword != '{':
                self.stack.pop()
            if self.stack:
                self.stack.pop()
            return
        # `end` never closes a brace block
        for pos in range(len(self.stack) - 1, -1, -1):
            if self.stack[pos].keyword != '{':
                del self.stack[pos:]
                return

    def _open(self, keyword: str, control: bool, func: Function | None = None, loop: bool = False) -> None:
        depth = 0 if func is not None else self.depth() + (1 if control else 0)
        nests = control and keyword not in ('begin',)
        cdepth = 0 if func is not None else self.cdepth() + (1 if nests else 0)
        self.stack.append(EBlock(keyword, depth, func, loop, cdepth))
        owner = self.current_func()
        if control and owner is not None:
            owner.note_depth(depth)

    # -- Ruby ---------------------------------------------------------------
    def _ruby_token(self, index: int) -> None:
        text = self.text(index)
        if text == 'end':
            self._pop('end')
            return
        if text == 'def':
            self._ruby_def(index)
            return
        if text in ('class', 'module'):
            if self.text(index + 1) == '<<' or self.statement_start(index):
                self._open(text, False)
            return
        if text == 'do':
            top = self.stack[-1] if self.stack else None
            if top is not None and top.loop_header and self.t[index].line == self._header_line:
                top.loop_header = False
                return
            self._open('do', False)
            return
        if text in RUBY_CONTROL:
            if text in RUBY_MODIFIERS and not self.statement_start(index):
                owner = self.current_func()
                if owner is not None:
                    owner.note_depth(self.depth() + 1)
                return
            self._header_line = self.t[index].line
            self._open(text, True, loop=text in ('while', 'until', 'for'))

    _header_line = 0

    def _ruby_def(self, index: int) -> None:
        j = index + 1
        name_parts: list[str] = []
        while j < len(self.t) and self.t[j].line == self.t[index].line:
            token = self.t[j]
            if token.kind == 'id' or token.text == '.' or (not name_parts and token.kind == 'op'
                                                            and token.text not in ('(',)):
                name_parts.append(token.text)
                j += 1
                if token.kind == 'op' and token.text != '.':
                    break
                if j < len(self.t) and self.t[j].kind == 'id' and token.kind == 'id':
                    break
                continue
            break
        name = ''.join(name_parts) or 'unknown'
        params: list[Token] = []
        endless = False
        if j < len(self.t) and self.text(j) == '(':
            depth = 0
            for k in range(j, len(self.t)):
                token = self.t[k]
                if token.text == '(':
                    depth += 1
                    if depth == 1:
                        continue
                elif token.text == ')':
                    depth -= 1
                    if depth == 0:
                        endless = self.text(k + 1) == '='
                        break
                params.append(token)
        else:
            k = j
            while k < len(self.t) and self.t[k].line == self.t[index].line and self.t[k].text != ';':
                params.append(self.t[k])
                k += 1
        func = Function(name, self.t[index + 1].line if index + 1 < len(self.t) else self.t[index].line)
        func.params = split_params(params)
        func.long_name = f'{name}({join_tokens(params)})'
        func.own(self.t[index])
        self.functions.append(func)
        if not endless:
            self._open('def', False, func)
        else:
            # `def f(x) = expr`: the body is the rest of the line
            for k in range(index, len(self.t)):
                if self.t[k].line != self.t[index].line:
                    break
                func.own(self.t[k])

    # -- Lua ------------------------------------------------------------------
    def _lua_token(self, index: int) -> None:
        text = self.text(index)
        if text == 'end':
            self._pop('end')
            return
        if text == 'until':
            for pos in range(len(self.stack) - 1, -1, -1):
                if self.stack[pos].keyword == 'repeat':
                    del self.stack[pos:]
                    break
            return
        if text == 'function':
            self._lua_function(index)
            return
        if text == 'do':
            top = self.stack[-1] if self.stack else None
            if top is not None and top.loop_header:
                top.loop_header = False
                return
            self._open('do', False)
            return
        if text in LUA_CONTROL:
            self._open(text, True, loop=text in ('for', 'while'))

    def _lua_function(self, index: int) -> None:
        j = index + 1
        name = ''
        while j < len(self.t) and (self.t[j].kind == 'id' or self.text(j) in ('.', ':')):
            name += self.text(j)
            j += 1
        if not name:
            # `local f = function(` / `t.f = function(` / `f = function(`
            if self.text(index - 1) == '=' and self.t[index - 2].kind == 'id':
                k = index - 2
                parts = [self.text(k)]
                while k >= 2 and self.text(k - 1) in ('.', ':') and self.t[k - 2].kind == 'id':
                    parts[:0] = [self.text(k - 2), self.text(k - 1)]
                    k -= 2
                name = ''.join(parts)
            else:
                name = '(anonymous)'
        params: list[Token] = []
        if self.text(j) == '(':
            depth = 0
            for k in range(j, len(self.t)):
                token = self.t[k]
                if token.text == '(':
                    depth += 1
                    if depth == 1:
                        continue
                elif token.text == ')':
                    depth -= 1
                    if depth == 0:
                        break
                params.append(token)
        func = Function(name, self.t[index].line)
        func.params = split_params(params)
        func.long_name = f'{name}({join_tokens(params)})'
        func.own(self.t[index])
        self.functions.append(func)
        self._open('function', False, func)


def parse_end(lang: Language, tokens: list[Token]) -> list[Function]:
    return EndParser(lang, tokens).parse()
