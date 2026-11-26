"""Function structure for shell scripts (Bash and POSIX sh).

Shell has no braces around control flow: ``if``/``fi``, ``case``/``esac`` and
``for``/``while``/``until``/``select`` ... ``done`` delimit it, and a keyword is
only a keyword at the start of a command (``echo done`` is a plain word). One
stack holds the open control structures together with every bracket that can
hold a ``}``/``)`` of its own (function bodies, ``{ ...; }`` groups, ``${...}``,
``$(...)``, subshells), so a stray closer never unbalances the rest.

Functions are ``name() { ... }``, ``name() ( ... )`` and ``function name [()] { ... }``.
A shell function declares no parameters, so its parameter count is the
highest positional parameter it reads (``$1``, ``${2}``, ``"$3"``); ``$@`` and
``$*`` add none. CCN is 1 + ``if``/``elif``/``while``/``until``/``for``/
``select`` + each ``&&``/``||`` + each ``case`` pattern except ``*)``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from code_metrics.languages import Language
from code_metrics.lexer import Token
from code_metrics.model import Function

_COMMAND_PRECEDERS = frozenset({
    ';', '&&', '||', '|', '&', 'then', 'do', 'else', '{', '(', '!', ';;', ';&', ';;&', '$(', ')', '`', '|&',
})
_LOOPS = frozenset({'for', 'while', 'until', 'select'})
_DECISIONS = frozenset({'if', 'elif'}) | _LOOPS
_CLOSES = {'fi': 'if', 'done': 'loop', 'esac': 'case'}
_BRACKETS = frozenset({'func', 'brace', 'param', 'subst', 'paren'})
_POSITIONAL = re.compile(r'\$\{?([1-9][0-9]*)')


@dataclass
class Entry:
    kind: str                       # func | brace | param | subst | paren | if | case | loop
    depth: int                      # control depth of code inside
    func: Function | None = None
    expect_pattern: bool = False    # case: the next words are an arm's pattern
    opened: bool = False            # case: its `in` was seen


class ShellParser:
    def __init__(self, lang: Language, tokens: list[Token]):
        self.lang = lang
        self.t = tokens
        self.stack: list[Entry] = []
        self.functions: list[Function] = []
        self.pending: Function | None = None     # a function header waiting for its body
        self.body_from = 0                         # first token that may open that body
        self.pattern: list[Token] | None = None

    def text(self, index: int) -> str:
        return self.t[index].text if 0 <= index < len(self.t) else ''

    def current(self) -> Function | None:
        for entry in reversed(self.stack):
            if entry.func is not None:
                return entry.func
        return None

    def depth(self) -> int:
        return self.stack[-1].depth if self.stack else 0

    def command_start(self, index: int) -> bool:
        if index == 0 or self.t[index - 1].end_line < self.t[index].line:
            return True
        return self.text(index - 1) in _COMMAND_PRECEDERS

    # ------------------------------------------------------------------
    def parse(self) -> list[Function]:
        for index, token in enumerate(self.t):
            if self.pending is not None and index < self.body_from:
                continue                   # the `()` of `name()`, already owned
            if self.pending is not None and (token.kind != 'op' or token.text not in ('{', '(')):
                self.functions.remove(self.pending)
                self.pending = None        # `name()` not followed by a body: not a definition
            func = self.current()
            if func is not None:
                func.own(token, self.depth())
                if token.kind == 'op' and token.text in self.lang.bool_ops:
                    func.complexity += 1
            if self._case_pattern(index):
                continue
            if token.kind == 'op':
                self._operator(index)
            elif token.kind == 'id' and (self.command_start(index) or token.text == 'in'):
                self._word(index)
        for func in self.functions:
            func.parameter_count = self._positional_count(func)
        return sorted(self.functions, key=lambda f: (f.start_line, f.name))

    def _case_pattern(self, index: int) -> bool:
        """Inside `case ... in`, collect each arm's pattern up to its `)`; every non-`*` arm is a decision."""
        top = self.stack[-1] if self.stack else None
        if top is None or top.kind != 'case' or not top.expect_pattern:
            return False
        token = self.t[index]
        if token.text == 'esac' and self.pattern is None:
            return False
        if self.pattern is None:
            self.pattern = []
            if token.text == '(':
                return True
        if token.text == ')':
            if [t.text for t in self.pattern] != ['*']:
                owner = self.current()
                if owner is not None:
                    owner.complexity += 1
            self.pattern = None
            top.expect_pattern = False
            return True
        self.pattern.append(token)
        return True

    def _operator(self, index: int) -> None:
        text = self.text(index)
        if text in ('{', '(') and self.pending is not None:
            func = self.pending
            self.pending = None
            func.own(self.t[index])
            self.stack.append(Entry('func' if text == '{' else 'paren', 0, func))
            return
        if text == '{':
            self.stack.append(Entry('brace', self.depth()))
        elif text == '${':
            self.stack.append(Entry('param', self.depth()))
        elif text in ('$(', '('):
            self.stack.append(Entry('subst' if text == '$(' else 'paren', self.depth()))
        elif text == '}':
            self._pop_bracket(('func', 'brace', 'param'))
        elif text == ')':
            for pos in range(len(self.stack) - 1, -1, -1):
                kind = self.stack[pos].kind
                if kind in ('subst', 'paren'):
                    del self.stack[pos:]
                    break
                if kind in ('func', 'brace', 'param'):
                    break
        elif text in (';;', ';&', ';;&'):
            for entry in reversed(self.stack):
                if entry.kind == 'case':
                    entry.expect_pattern = True
                    break
                if entry.kind in _BRACKETS:
                    break

    def _pop_bracket(self, kinds: tuple[str, ...]) -> None:
        for pos in range(len(self.stack) - 1, -1, -1):
            if self.stack[pos].kind in kinds:
                del self.stack[pos:]
                return

    def _word(self, index: int) -> None:
        text = self.text(index)
        owner = self.current()
        if text == 'function' and self.t[index + 1:index + 2] and self.t[index + 1].kind == 'id':
            self._start_function(index + 1, index)
            return
        if self.text(index + 1) == '(' and self.text(index + 2) == ')' and text not in _DECISIONS:
            self._start_function(index, index)
            return
        if text in _DECISIONS and owner is not None:
            owner.complexity += 1
        if text == 'if' or text == 'case' or text in _LOOPS:
            depth = self.depth() + 1
            self.stack.append(Entry('loop' if text in _LOOPS else text, depth))
            if owner is not None:
                owner.note_depth(depth)
            return
        if text == 'in':
            top = self.stack[-1] if self.stack else None
            if top is not None and top.kind == 'case' and not top.opened:
                top.expect_pattern = True
                top.opened = True
            return
        if text in _CLOSES:
            wanted = _CLOSES[text]
            for pos in range(len(self.stack) - 1, -1, -1):
                kind = self.stack[pos].kind
                if kind == wanted:
                    del self.stack[pos:]
                    return
                if kind in _BRACKETS:
                    return

    def _start_function(self, name_index: int, start_index: int) -> None:
        name = self.t[name_index].text
        func = Function(name, self.t[start_index].line)
        func.long_name = name
        end = name_index + 1
        if self.text(end) == '(' and self.text(end + 1) == ')':
            end += 2
        for j in range(start_index, end):
            func.own(self.t[j])
        self.functions.append(func)
        self.pending = func
        self.body_from = end

    @staticmethod
    def _positional_count(func: Function) -> int:
        highest = 0
        tokens = [token for token, _ in func.tokens]
        for pos, token in enumerate(tokens):
            if token.kind == 'str':
                for match in _POSITIONAL.finditer(token.text):
                    highest = max(highest, int(match.group(1)))
            elif token.kind == 'num' and pos and tokens[pos - 1].text in ('$', '${') and token.text.isdigit():
                highest = max(highest, int(token.text))
        return highest


def parse_shell(lang: Language, tokens: list[Token]) -> list[Function]:
    return ShellParser(lang, tokens).parse()
