"""Function structure for curly-brace languages.

One forward pass over the tokens keeps three stacks:

* blocks: every open ``{`` with what it is (function body, class scope,
  control body, arm block, plain block) and the nesting depth inside it;
* headers: per block and per parenthesis level, the tokens since the last
  statement boundary, with each ``(...)``/``[...]`` folded into a ``Group``.
  Looking at the header when a ``{`` (or ``=>``/``=``) arrives tells a
  function from a class, an object literal or a lambda;
* virtual control bodies: the single statement after a braceless
  ``if``/``for``/``else``, which is one nesting level deeper.

Each token is attributed to the innermost open function, which owns its line
(NLOC, end line) and its decisions (CCN). Nesting depth counts control
structures only: a function body is depth 0, each ``if``/loop/``switch``/
``try`` body (and its ``else``/``catch``/``finally`` siblings) one more.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from code_metrics.common import is_decision
from code_metrics.languages import Language
from code_metrics.lexer import Token
from code_metrics.model import Function, join_tokens, split_params


@dataclass
class Group:
    open: int
    close: int


@dataclass
class Block:
    kind: str                      # root | func | exprfunc | scope | ctrl | arms | block
    depth: int                     # control depth of code directly inside
    func: Function | None = None
    name: str = ''
    headers: list = field(default_factory=lambda: [[]])
    opens: list = field(default_factory=list)
    arm_separators: frozenset = frozenset()
    expr_line: int = 0             # exprfunc: line of the `=`/`=>`
    cdepth: int = 0                # cognitive nesting inside (try/finally bodies do not nest)


@dataclass
class Pending:
    keyword: str
    block_index: int
    level: int
    ready: bool


@dataclass
class Virtual:
    block_index: int
    level: int
    depth: int
    started_line: int = 0
    cdepth: int = 0


NOT_A_NAME = frozenset({
    'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'using', 'lock', 'synchronized', 'fixed',
    'foreach', 'new', 'throw', 'typeof', 'nameof', 'checked', 'unchecked', 'defined', 'when', 'match',
    'elseif', 'else', 'do', 'try', 'case', 'delete', 'await', 'yield', 'in', 'of', 'instanceof', 'select',
    'alignof', 'decltype', 'static_assert', 'assert', '__attribute__', 'guard', 'repeat', 'until', 'unless',
    'with', 'function', 'super', 'this', 'import', 'require', 'elsif', 'foreach',
})
TRAILER_STARTS = frozenset({
    'const', 'noexcept', 'override', 'final', 'throws', '->', ':', 'where', 'volatile', '&', '&&', 'mutable',
    'constexpr', 'try', 'throw', 'requires', 'return', 'runs', 'system', 'mtc',
})
DECLARATION_BLOCKERS = frozenset({'=', '.', 'return', 'new', ',', '->', '?', ':', '!', '+', '-', '==',
                                  'throw', 'await', 'yield', 'else', 'case', '(', '&&', '||', '?.'})
NEWLINE_TERMINATED = frozenset({'Go', 'Kotlin', 'Scala', 'Swift'})
ACCESS_LABELS = frozenset({'public', 'private', 'protected', 'internal', 'signals', 'slots', 'default'})


class BraceParser:
    def __init__(self, lang: Language, tokens: list[Token]):
        self.lang = lang
        self.t = tokens
        self.functions: list[Function] = []
        self.blocks: list[Block] = [Block('root', 0)]
        self.pending: Pending | None = None
        self.virtuals: list[Virtual] = []
        self.package = ''

    # -- helpers -------------------------------------------------------
    @property
    def block(self) -> Block:
        return self.blocks[-1]

    @property
    def header(self) -> list:
        return self.block.headers[-1]

    @property
    def level(self) -> int:
        return len(self.block.headers) - 1

    def text(self, index) -> str:
        if isinstance(index, Group):
            return '()' if self.t[index.open].text == '(' else '[]'
        return self.t[index].text if 0 <= index < len(self.t) else ''

    def kind(self, index) -> str:
        return 'group' if isinstance(index, Group) else self.t[index].kind

    def inner(self, group: Group) -> list[Token]:
        return self.t[group.open + 1:group.close]

    def current_function(self) -> Function | None:
        for block in reversed(self.blocks):
            if block.func is not None:
                return block.func
        return None

    def context_depth(self) -> int:
        top = len(self.blocks) - 1
        for virtual in reversed(self.virtuals):
            if virtual.block_index == top:
                return virtual.depth
        return self.block.depth

    def context_cdepth(self) -> int:
        top = len(self.blocks) - 1
        for virtual in reversed(self.virtuals):
            if virtual.block_index == top:
                return virtual.cdepth
        return self.block.cdepth

    def scope_path(self) -> list[str]:
        names = [self.package] if self.package else []
        for block in self.blocks:
            if block.kind == 'scope' and block.name and not block.name.startswith('#'):
                names.append(block.name)
            if block.kind in ('func', 'exprfunc'):
                names = []
        return names

    # -- main loop -------------------------------------------------------
    def parse(self) -> list[Function]:
        tokens = self.t
        for index, token in enumerate(tokens):
            if index and token.line > tokens[index - 1].end_line:
                self._on_newline(index)
            self._before_token(index)

            func = self.current_function()
            text = token.text
            if func is not None:
                func.own(token, self.context_cdepth())
                if is_decision(self.lang, tokens, index):
                    func.complexity += 1
                if (text in self.block.arm_separators and self.level == 0
                        and self.text(index - 1) not in ('else', 'default', '_')):
                    func.complexity += 1

            if token.kind == 'op':
                if text in ('(', '['):
                    self.block.headers.append([])
                    self.block.opens.append(index)
                    continue
                if text in (')', ']'):
                    while self.block.kind == 'exprfunc' and self.level == 0 and len(self.blocks) > 1:
                        self._close_expression_function()
                    self._close_group(index)
                    continue
                if text == '{':
                    self._open_brace(index)
                    continue
                if text == '}':
                    self._close_brace(index)
                    continue
                if text == ';':
                    self._end_statement(index)
                    continue
                if text == ',' and self.block.kind == 'exprfunc' and self.level == 0:
                    self._close_expression_function()
                    self.header.append(index)
                    continue
                if text == ':' and self.block.kind == 'exprfunc' and self.level == 0 \
                        and self.lang.separate_closures and self._ternary_balance(self.header) <= 0:
                    self._close_expression_function()      # `c ? (x) => x : other`: the arrow ended
                    self.header.append(index)
                    continue
                if text == ':' and self.level == 0 and self.text(index - 1) in ACCESS_LABELS \
                        and self.lang.declaration_functions:
                    self.header.clear()
                    continue
                if text in self.lang.expression_body_ops or (text == '=>' and self.lang.separate_closures):
                    if self._maybe_expression_function(index):
                        continue
            elif token.kind == 'id':
                if self.lang.name == 'Perl' and text == 'package' and self.level == 0:
                    parts, k = [], index + 1
                    while self.t[k].kind == 'id' if k < len(self.t) else False:
                        parts.append(self.text(k))
                        if self.text(k + 1) != '::':
                            break
                        k += 2
                    self.package = '::'.join(parts)
                if self.lang.objc_methods and text in ('implementation', 'interface', 'end', 'protocol') \
                        and self.text(index - 1) == '@':
                    self.header.clear()
                    continue
                self._control_keyword(index)
            self.header.append(index)

        while len(self.blocks) > 1:
            self.blocks.pop()
        return sorted(self.functions, key=lambda f: (f.start_line, f.name))

    def _ternary_balance(self, items: list) -> int:
        balance = 0
        for item in items:
            if not isinstance(item, Group) and self.t[item].kind == 'op':
                balance += {'?': 1, ':': -1}.get(self.t[item].text, 0)
        return balance

    # -- control structures -------------------------------------------------
    def _control_keyword(self, index: int) -> None:
        lang = self.lang
        text = self.text(index)
        if text not in lang.control or self.text(index - 1) in ('.', '->', '::', '?.', '$'):
            return
        if text == 'else' and self.text(index + 1) in ('if', 'elif', '->', '=>', ':', ','):
            return                         # `else if` chains; `else ->` / `else =>` default arms
        if text == 'else' and self.pending is not None and self.pending.keyword == 'guard':
            return
        if text in ('else', 'elsif', 'elseif', 'catch', 'finally') and self.virtuals:
            top = self.virtuals[-1]
            if top.block_index == len(self.blocks) - 1 and top.level == self.level:
                self.virtuals.pop()        # the braceless if-body ended; this is its sibling
        if lang.name == 'Perl' and text in lang.cond_keywords and text != 'elsif' and self.header:
            func = self.current_function()     # statement modifier: `die "x" if $bad;`
            if func is not None:
                func.note_depth(self.context_depth() + 1)
            return
        if text == 'if' and lang.name == 'Scala' and any(
                not isinstance(i, Group) and self.text(i) == 'case' for i in self.header):
            return                         # `case p if guard =>`: a guard, not an if statement
        if text == 'switch' and lang.name == 'C#' and self.text(index + 1) == '{':
            self.pending = Pending('switch-expr', len(self.blocks) - 1, self.level, True)
            return                         # `value switch { pattern => result, ... }`
        if text == 'match' and lang.name == 'Scala':
            self.pending = Pending('match', len(self.blocks) - 1, self.level, True)
            return
        ready = text not in lang.cond_keywords
        self.pending = Pending(text, len(self.blocks) - 1, self.level, ready)

    def _pending_here(self) -> bool:
        pending = self.pending
        return (pending is not None and pending.block_index == len(self.blocks) - 1
                and pending.level == self.level)

    def _before_token(self, index: int) -> None:
        """A ready control keyword followed by anything but `{` opens a braceless body."""
        if not self._pending_here() or not self.pending.ready:
            return
        text = self.text(index)
        if text == '{':
            return
        if self.lang.zig_captures:
            if text == '|' or self._in_zig_capture(index):
                return
            if text == ':' and self.text(index + 1) == '(':
                self.pending.ready = False
                return
        self.pending = None
        depth = self.context_depth() + 1
        self.virtuals.append(Virtual(len(self.blocks) - 1, self.level, depth, self.t[index].line,
                                     self.context_cdepth() + 1))
        func = self.current_function()
        if func is not None:
            func.note_depth(depth)

    def _in_zig_capture(self, index: int) -> bool:
        bars = 0
        j = index - 1
        while j >= 0 and self.text(j) != ')':
            if self.text(j) == '|':
                bars += 1
            j -= 1
        return bars % 2 == 1

    def _close_virtuals(self) -> None:
        top = len(self.blocks) - 1
        while self.virtuals and self.virtuals[-1].block_index == top and self.virtuals[-1].level >= self.level:
            self.virtuals.pop()

    def _continues(self, prev: Token, nxt: Token) -> bool:
        """Does the statement on prev's line continue on nxt's line?"""
        if prev.kind == 'op' and prev.text not in (')', ']', '}', '++', '--', '!!'):
            return True
        if prev.kind == 'id' and prev.text in self.lang.control:
            return True
        if nxt.kind == 'op' and nxt.text not in ('{', '(', '[', '-', '+', '!', '++', '--', '@', '#', '}'):
            return True
        if nxt.kind == 'id' and nxt.text in ('else', 'catch', 'finally', 'match', 'orelse'):
            return True
        return False

    def _on_newline(self, index: int) -> None:
        prev = self.t[index - 1]
        nxt = self.t[index]
        if self.block.kind == 'exprfunc' and self.level == 0 and len(self.blocks) > 1 \
                and not self._continues(prev, nxt):
            self._close_expression_function()
        if (self.lang.name in NEWLINE_TERMINATED and self.level == 0 and nxt.text != '{'
                and not self._continues(prev, nxt) and not self._pending_here()):
            self.header.clear()            # a line break ends the statement: `case class A(x)` / `def f`
        if not self.virtuals:
            return
        virtual = self.virtuals[-1]
        if virtual.block_index != len(self.blocks) - 1 or virtual.level != self.level:
            return
        if prev.line < virtual.started_line:
            return
        if self._continues(prev, nxt) and not (nxt.kind == 'id' and nxt.text == 'else'):
            return
        if self.pending is not None and not self.pending.ready and self._pending_here():
            return
        self._close_virtuals()

    # -- groups -----------------------------------------------------------
    def _close_group(self, index: int) -> None:
        if self.level == 0:
            self.header.append(index)
            return
        self.block.headers.pop()
        open_index = self.block.opens.pop()
        self.header.append(Group(open_index, index))
        if (self._pending_here() and not self.pending.ready and not self.lang.brace_required
                and self.text(open_index) == '('):
            self.pending.ready = True

    def _end_statement(self, index: int) -> None:
        if self.level > 0:
            self.header.append(index)
            return
        if self.block.kind == 'exprfunc' and len(self.blocks) > 1:
            self._close_expression_function()
            self._end_statement(index)
            return
        self.header.clear()
        if self.pending is not None and not self.lang.brace_required:
            self.pending = None
        self._close_virtuals()

    # -- braces -------------------------------------------------------------
    def _open_brace(self, index: int) -> None:
        depth = self.context_depth()
        cdepth = self.context_cdepth()
        func = self.current_function()
        if self._pending_here():
            pending = self.pending
            self.pending = None
            kind = 'arms' if pending.keyword in self.lang.arm_keywords else 'ctrl'
            nests = pending.keyword not in self.lang.try_keywords
            block = Block(kind, depth + 1, cdepth=cdepth + (1 if nests else 0))
            if kind == 'arms':
                block.arm_separators = self.lang.arm_separators
            if self.level == 0:
                self.header.clear()
            self.blocks.append(block)
            if func is not None:
                func.note_depth(depth + 1)
            return

        result = self._classify(self._statement_items(), index)
        if self.level == 0:
            self.header.clear()
        if result is None:
            self.blocks.append(Block('block', depth, cdepth=cdepth))
            return
        kind, payload = result
        if kind == 'scope':
            self.blocks.append(Block('scope', 0, name=payload))
            return
        new, start_index = payload
        self._start_function(new, start_index, index)

    def _statement_items(self) -> list:
        items = list(self.header)
        if self.level > 0:
            for pos in range(len(items) - 1, -1, -1):
                if not isinstance(items[pos], Group) and self.text(items[pos]) == ',':
                    return items[pos + 1:]
        return items

    def _start_function(self, new: Function, start_index: int, end_index: int, kind: str = 'func') -> None:
        for j in range(start_index, end_index + 1):
            new.own(self.t[j])
        self.blocks.append(Block(kind, 0, func=new, expr_line=self.t[end_index].line))
        self.functions.append(new)

    def _close_brace(self, index: int) -> None:
        while self.block.kind == 'exprfunc' and len(self.blocks) > 1:
            self._close_expression_function()
        if len(self.blocks) == 1:
            self.header.clear()
            return
        top = len(self.blocks) - 1
        self.virtuals = [v for v in self.virtuals if v.block_index < top]
        self.blocks.pop()
        if self.level == 0:
            self.header.clear()
        self._close_virtuals()
        if self.pending is not None and self.pending.block_index >= len(self.blocks):
            self.pending = None

    # -- expression-bodied functions --------------------------------------------
    def _maybe_expression_function(self, index: int) -> bool:
        if self.text(index + 1) == '{':
            return False
        items = self._statement_items()
        if not items:
            return False
        if self.t[index].text == '=>' and self.lang.separate_closures:
            result = self._arrow(items)
        else:
            result = self._classify(items, index, expression=True)
        if result is not None and result[0] == 'scope' and result[1].startswith('#prop:') \
                and self.lang.csharp_accessors and self.t[index].text == '=>':
            name = self._qualified('get_' + result[1][6:])     # `bool IsRich => expr;`: a getter
            func = Function(name, self.t[index].line)
            func.parameter_count = 0
            func.long_name = name
            result = ('func', (func, index))
        if result is None or result[0] != 'func':
            return False
        new, start_index = result[1]
        if self.level == 0:
            self.header.clear()
        self._start_function(new, start_index, index, kind='exprfunc')
        return True

    def _close_expression_function(self) -> None:
        self.blocks.pop()

    # -- header classification ----------------------------------------------
    def _classify(self, items: list, brace_index: int, expression: bool = False):
        lang = self.lang
        if not items:
            return None
        texts = [self.text(i) for i in items]

        if lang.separate_closures and not expression and texts[-1] == '=>':
            return self._arrow(items[:-1])

        if lang.scope_keywords:
            scope = self._scope(items)
            if scope is not None:
                return scope

        if lang.objc_methods:
            for pos, item in enumerate(items):
                if not isinstance(item, Group) and self.text(item) in ('-', '+') and (
                        pos == 0 or self.t[item].line > self._last_line(items[pos - 1])):
                    return self._objc_method(items[pos:])

        if lang.function_keywords:
            result = self._keyword_function(items)
            if result is not None:
                return result

        if lang.method_shorthand and not expression:
            result = self._method_shorthand(items)
            if result is not None:
                return result

        if lang.declaration_functions:
            result = self._declaration(items)
            if result is not None:
                return result

        if lang.csharp_accessors:
            result = self._accessor(items)
            if not expression or (result is not None and result[0] == 'scope'):
                return result
        return None

    def _last_line(self, item) -> int:
        if isinstance(item, Group):
            return self.t[item.close].line
        return self.t[item].line

    def _scope(self, items: list):
        lang = self.lang
        for pos, item in enumerate(items):
            if isinstance(item, Group):
                break
            word = self.text(item)
            if word not in lang.scope_keywords or self.text(item - 1) in ('.', '::'):
                continue
            if lang.name == 'Kotlin' and word == 'enum':
                continue
            name = ''
            name_pos = None
            for later_pos in range(pos + 1, len(items)):
                later = items[later_pos]
                if isinstance(later, Group):
                    break
                if self.t[later].kind == 'id':
                    name = self.t[later].text
                    name_pos = later_pos
                    break
            if lang.declaration_functions and name_pos is not None:
                # `struct Pair helper(int a) {` is a function returning a struct
                for later_pos in range(name_pos + 1, len(items)):
                    if isinstance(items[later_pos], Group) and self.text(items[later_pos]) == '()':
                        prev = items[later_pos - 1]
                        if not isinstance(prev, Group) and self.t[prev].kind == 'id' and later_pos - 1 != name_pos:
                            return None
            if lang.name == 'C#' and word == 'namespace':
                return ('scope', '#ns:' + name)    # Lizard qualifies C# members by class only
            return ('scope', name)
        if lang.name == 'Java' and any(not isinstance(i, Group) and self.text(i) == 'new' for i in items):
            return ('scope', '(anonymous)')     # anonymous class: Lizard names its methods `(anonymous)::m`
        return None

    def _qualified(self, name: str) -> str:
        if not self.lang.qualify:
            return name
        path = self.scope_path()
        if not path:
            return name
        return '::'.join(path + [name])

    def _make(self, name: str, name_index: int, group: Group | None, start_index: int,
              trailer: list | None = None) -> tuple:
        func = Function(name, self.t[name_index].line)
        if group is not None:
            inner = self.inner(group)
            func.params = split_params(inner, ignore=('*', '/'))
            long = name
            if self.lang.name == 'C#':      # Lizard: `A::m` as the name, `Ns::A::m(...)` as the long name
                namespaces = [b.name[4:] for b in self.blocks if b.kind == 'scope' and b.name.startswith('#ns:')]
                long = '::'.join(namespaces + [name])
            func.long_name = f'{long}({join_tokens(inner)})'
            if trailer:
                func.long_name += ' ' + join_tokens(trailer)
        else:
            func.long_name = name
            if self.lang.paramless_functions:
                func.parameter_count = 0
        return ('func', (func, start_index))

    def _keyword_function(self, items: list):
        lang = self.lang
        for pos, item in enumerate(items):
            if isinstance(item, Group):
                continue
            word = self.text(item)
            if word not in lang.function_keywords or self.text(item - 1) in ('.', '::'):
                continue
            rest = items[pos + 1:]
            if word in ('init', 'deinit', 'subscript', 'constructor', 'fallback', 'receive'):
                if not rest or isinstance(rest[0], Group) or self.text(rest[0]) in ('?', '!', '<'):
                    group = next((r for r in rest if isinstance(r, Group)), None)
                    return self._make(self._qualified(word), item, group, item)
            if lang.name == 'Go' and rest and isinstance(rest[0], Group):
                if len(rest) > 2 and not isinstance(rest[1], Group) and self.t[rest[1]].kind == 'id' \
                        and isinstance(rest[2], Group):
                    rest = rest[1:]                # method receiver `func (r *T) Name(`
                else:                              # a function literal, separate like Lizard does
                    name = self._assigned_name(items[:pos]) or '(anonymous)'
                    return self._make(name, item, rest[0], item)
            name_parts: list[int] = []
            angle = 0
            group = None
            for later in rest:
                if isinstance(later, Group):
                    if angle:
                        continue
                    if self.text(later) == '[]' and lang.name == 'Scala':
                        continue                   # type parameters `def f[T](`
                    group = later
                    break
                t = self.text(later)
                if t == '<':
                    angle += 1
                    continue
                if t == '>':
                    angle = max(angle - 1, 0)
                    continue
                if angle:
                    continue
                if t == '*' and lang.separate_closures:
                    continue
                if self.t[later].kind == 'id' or t in ('.', '::') or (lang.name == 'Perl' and t == "'"):
                    name_parts.append(later)
                    continue
                break
            idents = [i for i in name_parts if self.t[i].kind == 'id']
            if lang.name in ('Kotlin', 'Swift', 'Scala', 'Zig', 'Go', 'Solidity', 'TTCN-3', 'PHP') and idents:
                name = self.text(idents[-1])
            elif idents:
                name = ''.join(self.text(i) for i in name_parts)
            else:
                name = ''
            if group is None and not lang.paramless_functions and not (lang.name == 'Scala' and name):
                continue
            if not name:
                if not lang.separate_closures:
                    return None
                name = self._assigned_name(items[:pos]) or '(anonymous)'
                name_index = item
            else:
                name_index = idents[-1]
            start = item if lang.separate_closures and name == '(anonymous)' else name_index
            trailer = None
            if lang.name == 'TTCN-3' and group is not None:
                after = items[items.index(group) + 1:]
                trailer = [self.t[i] for i in self._flat(after)] or None
            return self._make(self._qualified(name), name_index, group, start, trailer)
        return None

    def _assigned_name(self, items: list) -> str:
        """`const h = function(` / `h: function(` / `this.h = (` -> 'h'."""
        items = list(items)
        while items and not isinstance(items[-1], Group) and self.text(items[-1]) in ('async', 'export', 'default'):
            items.pop()
        if len(items) >= 2 and not isinstance(items[-1], Group) and self.text(items[-1]) in ('=', ':', ':='):
            target = items[-2]
            if self.text(items[-1]) == ':' and any(
                    not isinstance(i, Group) and self.text(i) == '?' for i in items[:-3]):
                return ''                          # `c ? f : (x) =>`: a ternary branch, not a key
            if self.text(items[-1]) == '=' and self.lang.separate_closures:
                # `name: (a) => T = (a) => ...`: the annotated name, not the last word of its type
                for pos, item in enumerate(items[:-1]):
                    if pos and not isinstance(item, Group) and self.text(item) == ':' \
                            and not isinstance(items[pos - 1], Group) and self.t[items[pos - 1]].kind == 'id':
                        target = items[pos - 1]
                        break
            if not isinstance(target, Group) and self.t[target].kind == 'id':
                return self.text(target)
        return ''

    def _arrow(self, items: list):
        """JS/TS arrow function: `(a, b) =>`, `x =>`, `async (a): T =>`."""
        items = list(items)
        if not items:
            return None
        # `(a): RetType =>`: drop the return type annotation
        for k in range(len(items) - 1, 0, -1):
            if isinstance(items[k - 1], Group) and not isinstance(items[k], Group) and self.text(items[k]) == ':':
                items = items[:k]
                break
            if isinstance(items[k], Group):
                break
        last = items[-1]
        if isinstance(last, Group):
            if self.text(last) != '()':
                return None
            inner = self.inner(last)
            before = items[:-1]
            start = last.open
            if before and not isinstance(before[-1], Group) and self.t[before[-1]].kind == 'id' \
                    and self.text(before[-1]) not in ('async', 'return', 'yield', 'await', 'in', 'of', 'typeof'):
                return None                        # `call(x) =>` cannot start an arrow
        elif self.t[last].kind == 'id':
            inner = [self.t[last]]
            before = items[:-1]
            start = last
        else:
            return None
        if self._is_function_type(before):
            return None
        name = self._assigned_name(before) or '(anonymous)'
        func = Function(name, self.t[start].line)
        func.params = split_params(inner)
        func.long_name = name if name == '(anonymous)' else f'{name}({join_tokens(inner)})'
        return ('func', (func, start))

    def _is_function_type(self, before: list) -> bool:
        """TS `name: (a: T) => R` in a parameter list, class field or variable annotation is a type."""
        if not before or isinstance(before[-1], Group):
            return False
        prev = self.text(before[-1])
        if prev in ('<', '|', '&', 'extends', 'keyof'):
            return True                            # inside generics or a union of types
        angles = 0
        for item in before:
            if not isinstance(item, Group):
                angles += {'<': 1, '>': -1}.get(self.text(item), 0)
        if angles > 0:
            return True                            # `Record<string, (x: T) => void>`
        if prev == '=' and any(self.text(i) == 'type' for i in before[:2] if not isinstance(i, Group)):
            return True                            # `type Handler = (e: E) => void`
        if prev != ':':
            return False
        texts = [self.text(i) for i in before[:-1]]
        if '?' in texts[:-1]:
            return False                           # `cond ? a : (x) => y`: a ternary branch
        if self.level > 0:
            return self.t[self.block.opens[-1]].text == '('   # parameter annotation
        if self.block.kind == 'scope':
            return True                            # class field annotation
        return len(texts) >= 1 and any(t in ('let', 'const', 'var') for t in texts)

    def _method_shorthand(self, items: list):
        """`name(params) [: ReturnType] {` in a JS/TS class or object literal."""
        group_pos = None
        for pos in range(len(items) - 1, -1, -1):
            if isinstance(items[pos], Group) and self.text(items[pos]) == '()':
                group_pos = pos
                break
        if not group_pos:
            return None
        trailer = items[group_pos + 1:]
        if trailer and (isinstance(trailer[0], Group) or self.text(trailer[0]) != ':'):
            return None
        k = self._skip_generics(items, group_pos - 1)
        if k < 0 or isinstance(items[k], Group):
            return None
        name_index = items[k]
        name = self.text(name_index)
        if self.t[name_index].kind not in ('id', 'str') or name in NOT_A_NAME:
            return None
        before = items[:k]
        if before and (isinstance(before[-1], Group) or self.text(before[-1]) in DECLARATION_BLOCKERS):
            return None
        start = name_index
        if before and self.text(before[-1]) in ('get', 'set'):
            start = before[-1]
            name = f'{self.text(before[-1])} {name}'
        group = items[group_pos]
        func = Function(name, self.t[start].line)
        inner = self.inner(group)
        func.params = split_params(inner)
        func.long_name = f'{name}({join_tokens(inner)})'
        return ('func', (func, start))

    def _skip_generics(self, items: list, k: int) -> int:
        if k < 0 or isinstance(items[k], Group) or self.text(items[k]) not in ('>', '>>'):
            return k
        angle = 0
        while k >= 0:
            if not isinstance(items[k], Group):
                t = self.text(items[k])
                if t == '>':
                    angle += 1
                elif t == '>>':
                    angle += 2
                elif t == '<':
                    angle -= 1
                    if angle <= 0:
                        return k - 1
            k -= 1
        return -1

    def _declaration(self, items: list):
        """C-style `[modifiers] type name(params) [trailer] {`."""
        for pos, item in enumerate(items):
            if not isinstance(item, Group) or self.text(item) != '()' or pos == 0:
                continue
            operator = self._operator_name(items, pos)
            if operator is not None:
                k, operator_text = operator
            else:
                k = self._skip_generics(items, pos - 1)
                operator_text = ''
            if k < 0 or isinstance(items[k], Group):
                continue
            name_index = items[k]
            name_token = self.t[name_index]
            if name_token.kind != 'id' or name_token.text in NOT_A_NAME:
                continue
            start = k
            while start >= 2 and not isinstance(items[start - 1], Group) and self.text(items[start - 1]) == '::' \
                    and not isinstance(items[start - 2], Group) and self.t[items[start - 2]].kind == 'id':
                start -= 2
            if start >= 1 and not isinstance(items[start - 1], Group) and self.text(items[start - 1]) == '~':
                start -= 1
            before = items[:start]
            if before:
                prev = before[-1]
                if isinstance(prev, Group) and self.text(prev) == '()':
                    continue
                if not isinstance(prev, Group):
                    if self.text(prev) in DECLARATION_BLOCKERS:
                        continue
                    if self.t[prev].kind != 'id' and self.text(prev) not in ('*', '&', '>', '>>', '**', '&&', ']',
                                                                               '^'):
                        continue
            if any(not isinstance(b, Group) and self.text(b) in ('=', 'return') for b in before):
                continue
            trailer = items[pos + 1:]
            if trailer and (isinstance(trailer[0], Group) or self.text(trailer[0]) not in TRAILER_STARTS):
                continue
            name = ''.join(self.text(i) for i in items[start:k + 1]) + operator_text
            if '::' not in name:
                name = self._qualified(name)
            keep = [self.t[i] for i in self._flat(trailer)] if self.lang.name == 'TTCN-3' else None
            if self.lang.name in ('C++', 'Objective-C') and trailer and self.text(trailer[0]) == 'const':
                keep = [self.t[trailer[0]]]        # `f() const` is part of the signature
            return self._make(name, name_index, item, name_index, keep)
        return None

    def _operator_name(self, items: list, pos: int):
        """C++ `operator+(`, `operator==(`, `operator()(`: (index of `operator`, ' +' text), Lizard spelling."""
        if not self.lang.qualify or self.lang.name not in ('C++', 'C'):
            return None
        for k in range(pos - 1, max(pos - 4, -1), -1):
            item = items[k]
            if not isinstance(item, Group) and self.text(item) == 'operator':
                parts = []
                for between in items[k + 1:pos]:
                    if isinstance(between, Group):
                        parts.extend(t.text for t in self.t[between.open:between.close + 1])
                    elif self.t[between].kind == 'op':
                        parts.append(self.text(between))
                    else:
                        return None
                return (k, ' ' + ' '.join(parts)) if parts else None
        return None

    def _flat(self, items: list) -> list[int]:
        out: list[int] = []
        for item in items:
            if isinstance(item, Group):
                out.extend(range(item.open, item.close + 1))
            else:
                out.append(item)
        return out

    def _accessor(self, items: list):
        """C# property accessors: `get { }` / `set { }` inside `int P { ... }`."""
        texts = [self.text(i) for i in items]
        if len(items) <= 3 and texts[-1] in ('get', 'set', 'init', 'add', 'remove'):
            prop = next((b.name[6:] for b in reversed(self.blocks)
                         if b.kind == 'scope' and b.name.startswith('#prop:')), '')
            if not prop:
                return None
            name = self._qualified(f'{texts[-1]}_{prop}')
            func = Function(name, self.t[items[-1]].line)
            func.parameter_count = 0 if texts[-1] == 'get' else 1
            func.long_name = name
            return ('func', (func, items[-1]))
        if (len(items) >= 2 and all(not isinstance(i, Group) for i in items)
                and self.t[items[-1]].kind == 'id' and texts[-1] not in NOT_A_NAME
                and not ({'=', 'new', '=>', 'return', 'else', 'do', 'try', 'finally'} & set(texts))):
            return ('scope', '#prop:' + texts[-1])
        return None

    def _objc_method(self, items: list):
        """`- (Ret)name:(T)a part:(T)b {` -> 'name: part:', 2 parameters."""
        parts: list[str] = []
        long_parts: list[str] = []
        count = 0
        k = 1
        if k < len(items) and isinstance(items[k], Group):
            k += 1
        if k >= len(items) or isinstance(items[k], Group):
            return None
        start = items[k]
        while k < len(items):
            item = items[k]
            if isinstance(item, Group):
                k += 1
                continue
            if self.t[item].kind == 'id' and k + 1 < len(items) and self.text(items[k + 1]) == ':':
                type_text = ''
                step = 2
                if k + 2 < len(items) and isinstance(items[k + 2], Group):
                    type_text = '(' + join_tokens(self.inner(items[k + 2])) + ')'
                    step = 3
                parts.append(self.text(item) + ':')
                long_parts.append(self.text(item) + ':' + type_text)
                count += 1
                k += step + 1      # skip the parameter name
                continue
            if not parts and self.t[item].kind == 'id':
                parts.append(self.text(item))
                long_parts.append(self.text(item))
            k += 1
        if not parts:
            return None
        func = Function(' '.join(parts), self.t[start].line)
        func.parameter_count = count
        func.long_name = ' '.join(long_parts)
        return ('func', (func, items[0]))


def parse_brace(lang: Language, tokens: list[Token]) -> list[Function]:
    return BraceParser(lang, tokens).parse()
