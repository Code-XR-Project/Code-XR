"""Language-configurable tokenizer.

Produces the code tokens of a source file with their line numbers; comments
are dropped, string literals become one token. Nothing here knows about
functions or complexity: that is the parsers' job.

A token is ``Token(text, kind, line, end_line, col)``:

* ``kind`` is ``'id'`` (identifier or keyword), ``'num'``, ``'str'`` or ``'op'``;
* ``line``/``end_line`` are 1-based; they differ only for multi-line tokens
  (strings), whose every line counts as a code line;
* ``col`` is the 0-based column of the first character, used by the
  indentation-based languages.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Token:
    text: str
    kind: str
    line: int
    end_line: int
    col: int
    original: str = ''             # source spelling when `text` was case-folded (Fortran)

    @property
    def source(self) -> str:
        return self.original or self.text


@dataclass
class LexerConfig:
    line_comments: tuple[str, ...] = ('//',)
    block_comments: tuple[tuple[str, str], ...] = (('/*', '*/'),)
    # Block comments delimited by whole lines starting at column 0 (=begin/=end, POD).
    line_block_comments: tuple[tuple[str, str], ...] = ()
    quotes: tuple[str, ...] = ('"', "'")
    triple_quotes: bool = False
    backtick_strings: bool = False
    template_literals: bool = False
    regex_literals: bool = False
    char_literal_quote: str = ''      # quote that is a short char literal, not a string (Erlang has none)
    ident_extra_start: str = '_'
    ident_extra_part: str = '_'
    ident_suffixes: str = ''          # Ruby/Elixir style `empty?`, `save!`
    case_insensitive: bool = False
    operators: tuple[str, ...] = ()
    fixed_form_comments: bool = False  # Fortran 77: c/C/* in column 1
    erlang_chars: bool = False         # $x character literals
    lua_long_brackets: bool = False
    php_tags: bool = False
    nested_block_comments: bool = False
    raw_strings_prefix: str = ''       # e.g. Python r"..": no escapes
    string_prefixes: str = ''          # letters that may glue to a quote: f"..", b"..", @"..", L".."
    ruby_symbols: bool = False         # :name is one literal token
    preprocessor: bool = False         # C family: `#...` lines are one opaque token
    # Epic #219 languages ----------------------------------------------
    rust_strings: bool = False         # r"..", r#".."#, br#".."#; `'a` lifetimes and loop labels
    interpolation: tuple[str, ...] = ()    # openers of code inside double-quoted strings: '${', '$('
    raw_quotes: str = ''               # quotes whose strings have no escapes (shell/PowerShell '...')
    escape_char: str = '\\'            # PowerShell escapes with a backtick
    hash_comment_word_start: bool = False  # shell: `#` starts a comment only at a word start ($#, ${#x})
    heredocs: bool = False             # shell <<EOF ... EOF bodies are data
    here_strings: bool = False         # PowerShell @" ... "@ and @' ... '@
    dash_operators: frozenset = frozenset()   # PowerShell -and, -or, -eq ... as one token
    dash_words: bool = False           # PowerShell command names: Get-ChildItem is one word
    r_raw_strings: bool = False        # R 4.0 r"(...)", r"[...]", r"{...}" with optional dashes
    shell_escapes: bool = False        # shell: a backslash quotes the next character outside strings too
    extra: dict = field(default_factory=dict)


BASE_OPERATORS = (
    '>>>=', '<<=', '>>=', '===', '!==', '...', '**=', '//=', '??=', '&&=', '||=',
    '&&', '||', '==', '!=', '<=', '>=', '->', '=>', '::', '++', '--', '+=', '-=', '*=',
    '/=', '%=', '&=', '|=', '^=', '<<', '**', '..', '?.', '??',
)

# After one of these a `/` starts a regular expression instead of dividing.
_REGEX_PRECEDERS = set('(,=:[!&|?{};+-*%<>~^') | {
    'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw',
    '&&', '||', '??', '=>', '==', '!=', '===', '!==', '<=', '>=', '+=', '-=', '=~', '!~',
    'and', 'or', 'not', 'if', 'unless', 'when', 'split', 'grep',
}


class Lexer:
    def __init__(self, config: LexerConfig):
        self.config = config
        ops = sorted(set(BASE_OPERATORS) | set(config.operators), key=len, reverse=True)
        self._ops = ops

    # ------------------------------------------------------------------
    def tokenize(self, text: str) -> list[Token]:
        cfg = self.config
        text = text.replace('\r\n', '\n').replace('\r', '\n')
        if cfg.php_tags:
            text = _blank_outside_php(text)
        if cfg.fixed_form_comments:
            text = _blank_fixed_form_comments(text)
        if cfg.line_block_comments:
            text = _blank_line_blocks(text, cfg.line_block_comments)

        if cfg.heredocs:
            text = _blank_heredocs(text)
        tokens: list[Token] = []
        self.comment_lines: set[int] = set()
        n = len(text)
        i = 0
        line = 1
        line_start = 0
        while i < n:
            c = text[i]
            if c == '\n':
                line += 1
                line_start = i + 1
                i += 1
                continue
            if c in ' \t\f\v':
                i += 1
                continue
            if c == '\\' and i + 1 < n and text[i + 1] == '\n':
                i += 1
                continue
            if cfg.shell_escapes and c == '\\' and i + 1 < n:
                tokens.append(Token(text[i:i + 2], 'str', line, line, i - line_start))
                i += 2                     # shell `\$`, `\"`, `\#`, `\``: a quoted character
                continue

            # comments --------------------------------------------------
            if cfg.lua_long_brackets and text.startswith('--', i):
                m = re.match(r'--\[(=*)\[', text[i:])
                if m:
                    close = ']' + m.group(1) + ']'
                    end = text.find(close, i + m.end())
                    end = n if end < 0 else end + len(close)
                    self.comment_lines.update(range(line, line + text.count('\n', i, end) + 1))
                    line += text.count('\n', i, end)
                    line_start = text.rfind('\n', 0, end) + 1 if '\n' in text[i:end] else line_start
                    i = end
                    continue
            matched_block = False
            for opener, closer in cfg.block_comments:
                if text.startswith(opener, i):
                    end = self._find_block_end(text, i, opener, closer)
                    newlines = text.count('\n', i, end)
                    self.comment_lines.update(range(line, line + newlines + 1))
                    if newlines:
                        line += newlines
                        line_start = text.rfind('\n', 0, end) + 1
                    i = end
                    matched_block = True
                    break
            if matched_block:
                continue
            if any(text.startswith(marker, i) for marker in cfg.line_comments) and not (
                    cfg.hash_comment_word_start and c == '#' and i > 0 and text[i - 1] not in ' \t\n;|&()'):
                end = text.find('\n', i)
                i = n if end < 0 else end
                self.comment_lines.add(line)
                continue

            col = i - line_start

            if cfg.preprocessor and c == '#' and text[line_start:i].strip() == '':
                end = i
                while True:
                    nl = text.find('\n', end)
                    if nl < 0:
                        end = n
                        break
                    if nl > 0 and text[nl - 1] == '\\':
                        end = nl + 1
                        continue
                    end = nl
                    break
                newlines = text.count('\n', i, end)
                tokens.append(Token(text[i:end].strip(), 'pp', line, line + newlines, col))
                if newlines:
                    line += newlines
                    line_start = text.rfind('\n', 0, end) + 1
                i = end
                continue

            # strings ---------------------------------------------------
            if cfg.here_strings and c == '@' and text[i + 1:i + 2] in ('"', "'") and \
                    text[i + 2:i + 3] in ('\n', '\r'):
                closer = '\n' + text[i + 1] + '@'
                end = text.find(closer, i + 2)
                end = n if end < 0 else end + len(closer)
                newlines = text.count('\n', i, end)
                tokens.append(Token(text[i:end], 'str', line, line + newlines, col))
                line += newlines
                line_start = text.rfind('\n', 0, end) + 1
                i = end
                continue
            if cfg.triple_quotes and (text.startswith('"""', i) or text.startswith("'''", i)):
                quote = text[i:i + 3]
                end = self._scan_string(text, i + 3, quote, escapes=True)
                tokens.append(Token(text[i:end], 'str', line, line + text.count('\n', i, end), col))
                newlines = text.count('\n', i, end)
                if newlines:
                    line += newlines
                    line_start = text.rfind('\n', 0, end) + 1
                i = end
                continue
            if c in cfg.quotes or (c == '`' and (cfg.backtick_strings or cfg.template_literals)):
                if c == "'" and cfg.char_literal_quote == "'" and self._looks_like_lifetime(text, i):
                    pass
                else:
                    if c == '`' and cfg.template_literals:
                        end = self._scan_template(text, i + 1)
                    elif cfg.interpolation and c not in cfg.raw_quotes:
                        end = self._scan_interpolated(text, i + 1, c)
                    else:
                        end = self._scan_string(text, i + 1, c, escapes=(c != '`' and c not in cfg.raw_quotes),
                                                escape=cfg.escape_char)
                    newlines = text.count('\n', i, end)
                    tokens.append(Token(text[i:end], 'str', line, line + newlines, col))
                    if newlines:
                        line += newlines
                        line_start = text.rfind('\n', 0, end) + 1
                    i = end
                    continue
            if cfg.erlang_chars and c == '$' and i + 1 < n:
                end = i + 2
                if text[i + 1] == '\\' and i + 2 < n:
                    end = i + 3
                tokens.append(Token(text[i:end], 'str', line, line, col))
                i = end
                continue
            if (cfg.regex_literals and c == '/' and self._regex_allowed(tokens)
                    and i + 1 < n and text[i + 1] not in ' =/*'):
                end = self._scan_regex(text, i + 1)
                if end > 0:
                    tokens.append(Token(text[i:end], 'str', line, line, col))
                    i = end
                    continue

            if (cfg.ruby_symbols and c == ':' and i + 1 < n and (text[i + 1].isalpha() or text[i + 1] == '_')
                    and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] in '_:'))):
                j = i + 1
                while j < n and (text[j].isalnum() or text[j] in '_?!'):
                    j += 1
                tokens.append(Token(text[i:j], 'str', line, line, col))
                i = j
                continue

            # identifiers -----------------------------------------------
            if c.isalpha() or c in cfg.ident_extra_start:
                j = i + 1
                while j < n and (text[j].isalnum() or text[j] in cfg.ident_extra_part):
                    j += 1
                if cfg.ident_suffixes and j < n and text[j] in cfg.ident_suffixes and not (
                        j + 1 < n and text[j + 1] in '=:'):
                    j += 1
                if cfg.dash_words and text[i] != '$':
                    while j + 1 < n and text[j] == '-' and text[j + 1].isalpha():
                        j += 2
                        while j < n and (text[j].isalnum() or text[j] in cfg.ident_extra_part):
                            j += 1
                word = text[i:j]
                raw_end = self._raw_string_end(text, i, j, word)
                if raw_end:
                    newlines = text.count('\n', i, raw_end)
                    tokens.append(Token(text[i:raw_end], 'str', line, line + newlines, col))
                    if newlines:
                        line += newlines
                        line_start = text.rfind('\n', 0, raw_end) + 1
                    i = raw_end
                    continue
                # String prefix glued to a quote (f"..", r'..', b"..", @"..").
                if (cfg.string_prefixes and j < n and text[j] in cfg.quotes
                        and all(ch in cfg.string_prefixes for ch in word.lower())):
                    if cfg.triple_quotes and text.startswith(text[j] * 3, j):
                        end = self._scan_string(text, j + 3, text[j] * 3, escapes=True)
                    else:
                        end = self._scan_string(text, j + 1, text[j], escapes=True)
                    newlines = text.count('\n', i, end)
                    tokens.append(Token(text[i:end], 'str', line, line + newlines, col))
                    if newlines:
                        line += newlines
                        line_start = text.rfind('\n', 0, end) + 1
                    i = end
                    continue
                if cfg.case_insensitive and word.lower() != word:
                    tokens.append(Token(word.lower(), 'id', line, line, col, word))
                else:
                    tokens.append(Token(word, 'id', line, line, col))
                i = j
                continue
            if c.isdigit():
                m = re.match(r'0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[a-zA-Z]*', text[i:])
                j = i + (m.end() if m else 1)
                tokens.append(Token(text[i:j], 'num', line, line, col))
                i = j
                continue
            if cfg.case_insensitive and c == '.':
                m = re.match(r'\.(and|or|not|eqv|neqv|eq|ne|lt|le|gt|ge|true|false)\.', text[i:], re.IGNORECASE)
                if m:
                    tokens.append(Token(m.group(0).lower(), 'op', line, line, col))
                    i += m.end()
                    continue

            # operators -------------------------------------------------
            if cfg.dash_operators and c == '-':
                m = re.match(r'-([a-zA-Z]+)', text[i:])
                if m and m.group(1).lower() in cfg.dash_operators:
                    tokens.append(Token('-' + m.group(1).lower(), 'op', line, line, col))
                    i += m.end()
                    continue
            for op in self._ops:
                if text.startswith(op, i):
                    if op == '?.' and i + 2 < n and text[i + 2].isdigit():
                        continue
                    tokens.append(Token(op, 'op', line, line, col))
                    i += len(op)
                    break
            else:
                tokens.append(Token(c, 'op', line, line, col))
                i += 1
        return tokens

    # ------------------------------------------------------------------
    def _find_block_end(self, text: str, start: int, opener: str, closer: str) -> int:
        if not self.config.nested_block_comments:
            end = text.find(closer, start + len(opener))
            return len(text) if end < 0 else end + len(closer)
        depth = 0
        i = start
        while i < len(text):
            if text.startswith(opener, i):
                depth += 1
                i += len(opener)
            elif text.startswith(closer, i):
                depth -= 1
                i += len(closer)
                if depth == 0:
                    return i
            else:
                i += 1
        return len(text)

    @staticmethod
    def _scan_string(text: str, i: int, quote: str, escapes: bool, escape: str = '\\') -> int:
        n = len(text)
        single_line = len(quote) == 1 and quote in '"\''
        while i < n:
            if escapes and text[i] == escape:
                i += 2
                continue
            if text.startswith(quote, i):
                return i + len(quote)
            if single_line and text[i] == '\n':
                # Unterminated on this line: stop here rather than eat the file.
                return i
            i += 1
        return n

    def _scan_interpolated(self, text: str, i: int, quote: str) -> int:
        """A string whose `${...}` / `$(...)` hold code, possibly with quotes of their own."""
        cfg = self.config
        n = len(text)
        while i < n:
            ch = text[i]
            if ch == cfg.escape_char:
                i += 2
                continue
            if ch == quote:
                return i + 1
            opener = next((o for o in cfg.interpolation if text.startswith(o, i)), None)
            if opener:
                close = {'{': '}', '(': ')'}[opener[-1]]
                depth = 1
                i += len(opener)
                while i < n and depth:
                    if text[i] in '"\'' and text[i] in cfg.quotes:
                        i = (self._scan_interpolated(text, i + 1, text[i]) if text[i] not in cfg.raw_quotes
                             else self._scan_string(text, i + 1, text[i], escapes=False))
                        continue
                    if text[i] == opener[-1]:
                        depth += 1
                    elif text[i] == close:
                        depth -= 1
                    i += 1
                continue
            i += 1
        return n

    def _raw_string_end(self, text: str, start: int, word_end: int, word: str) -> int:
        """End of a Rust or R raw string starting at `start`, or 0."""
        cfg = self.config
        n = len(text)
        if cfg.rust_strings and word in ('r', 'br', 'cr') and word_end < n and text[word_end] in '#"':
            j = word_end
            while j < n and text[j] == '#':
                j += 1
            if j >= n or text[j] != '"':
                return 0
            closer = '"' + '#' * (j - word_end)
            end = text.find(closer, j + 1)
            return n if end < 0 else end + len(closer)
        if cfg.r_raw_strings and word in ('r', 'R') and word_end + 1 < n and text[word_end] in '"\'':
            m = re.match(r'(-*)([(\[{])', text[word_end + 1:])
            if not m:
                return 0
            closer = {'(': ')', '[': ']', '{': '}'}[m.group(2)] + m.group(1) + text[word_end]
            end = text.find(closer, word_end + 1 + m.end())
            return n if end < 0 else end + len(closer)
        return 0

    def _scan_template(self, text: str, i: int) -> int:
        n = len(text)
        while i < n:
            ch = text[i]
            if ch == '\\':
                i += 2
                continue
            if ch == '`':
                return i + 1
            if text.startswith('${', i):
                depth = 1
                i += 2
                while i < n and depth:
                    if text[i] in '"\'':
                        i = self._scan_string(text, i + 1, text[i], escapes=True)
                        continue
                    if text[i] == '`':
                        i = self._scan_template(text, i + 1)
                        continue
                    if text[i] == '{':
                        depth += 1
                    elif text[i] == '}':
                        depth -= 1
                    i += 1
                continue
            i += 1
        return n

    @staticmethod
    def _scan_regex(text: str, i: int) -> int:
        n = len(text)
        in_class = False
        while i < n:
            ch = text[i]
            if ch == '\n':
                return -1
            if ch == '\\':
                i += 2
                continue
            if ch == '[':
                in_class = True
            elif ch == ']':
                in_class = False
            elif ch == '/' and not in_class:
                i += 1
                while i < n and text[i].isalpha():
                    i += 1
                return i
            i += 1
        return -1

    @staticmethod
    def _regex_allowed(tokens: list[Token]) -> bool:
        if not tokens:
            return True
        prev = tokens[-1]
        if prev.kind in ('num', 'str'):
            return False
        if prev.kind == 'id':
            return prev.text in _REGEX_PRECEDERS
        return prev.text in _REGEX_PRECEDERS

    def _looks_like_lifetime(self, text: str, i: int) -> bool:
        """Rust `'a` (lifetime) or `'outer:` (loop label), not the char literal `'a'`."""
        if not self.config.rust_strings:
            return False
        j = i + 1
        if j >= len(text) or not (text[j].isalpha() or text[j] == '_'):
            return False
        while j < len(text) and (text[j].isalnum() or text[j] == '_'):
            j += 1
        return j >= len(text) or text[j] != "'"


def _blank(text: str, start: int, end: int) -> str:
    segment = text[start:end]
    return text[:start] + re.sub(r'[^\n]', ' ', segment) + text[end:]


def _blank_outside_php(text: str) -> str:
    """Keep only what lies between <?php / <?= and ?>; HTML around it becomes spaces."""
    out = []
    i = 0
    inside = False
    n = len(text)
    while i < n:
        if not inside:
            m = re.compile(r'<\?(?:php|=)?', re.IGNORECASE).search(text, i)
            end = m.start() if m else n
            out.append(re.sub(r'[^\n]', ' ', text[i:end]))
            if not m:
                break
            out.append(' ' * (m.end() - m.start()))
            i = m.end()
            inside = True
        else:
            end = _find_php_close(text, i)
            out.append(text[i:end])
            if end >= n:
                break
            out.append('  ')
            i = end + 2
            inside = False
    return ''.join(out)


def _find_php_close(text: str, i: int) -> int:
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in '"\'':
            i = Lexer._scan_string(text, i + 1, ch, escapes=True)
            continue
        if text.startswith('//', i) or ch == '#':
            nl = text.find('\n', i)
            close = text.find('?>', i)
            if close >= 0 and (nl < 0 or close < nl):
                return close
            i = n if nl < 0 else nl
            continue
        if text.startswith('/*', i):
            end = text.find('*/', i + 2)
            i = n if end < 0 else end + 2
            continue
        if text.startswith('?>', i):
            return i
        i += 1
    return n


_HEREDOC = re.compile(r'<<(-?)\s*([\'"]?)([A-Za-z_][A-Za-z0-9_]*)\2')


def _blank_heredocs(text: str) -> str:
    """Shell here-documents: the lines between `<<EOF` and `EOF` are data, not code."""
    lines = text.split('\n')
    index = 0
    while index < len(lines):
        found = [m for m in _HEREDOC.finditer(lines[index]) if not lines[index][:m.start()].endswith('<')]
        index += 1
        for match in found:
            strip_tabs, delimiter = match.group(1) == '-', match.group(3)
            while index < len(lines):
                body = lines[index].lstrip('\t') if strip_tabs else lines[index]
                lines[index] = ''
                index += 1
                if body.strip() == delimiter:
                    break
    return '\n'.join(lines)


def _blank_fixed_form_comments(text: str) -> str:
    lines = text.split('\n')
    for index, line in enumerate(lines):
        if not line:
            continue
        first = line[0]
        if first in '*!' or (first in 'cCdD' and (len(line) == 1 or not (line[1].isalnum() or line[1] == '_'))):
            lines[index] = ''
    return '\n'.join(lines)


def _blank_line_blocks(text: str, pairs: tuple[tuple[str, str], ...]) -> str:
    lines = text.split('\n')
    inside: str | None = None
    for index, line in enumerate(lines):
        if inside is None:
            for opener, closer in pairs:
                if re.match(opener, line):
                    inside = closer
                    lines[index] = ''
                    break
        else:
            if re.match(inside, line):
                inside = None
            lines[index] = ''
    return '\n'.join(lines)
