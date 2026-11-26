"""Per-language rules: how to tokenize, which constructs are decisions, which nest.

The decision sets implement the CCN convention fixed in
``docs/lizard-replacement/SPEC.md``: 1 + one per branching construct, with the
short-circuit boolean operators, ternaries and null-coalescing operators
counted, every non-default ``case``/arm counted, and ``else``/``default``/
``finally`` never counted.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from code_metrics.lexer import LexerConfig

C_OPS = ('&&', '||')
WORD_BOOL = ('and', 'or')


@dataclass
class Language:
    name: str
    family: str                                   # brace | indent | ruby | lua | fortran | erlang
    lexer: LexerConfig
    decisions: frozenset = frozenset()            # keywords, each occurrence +1
    bool_ops: frozenset = frozenset(C_OPS)
    coalesce_ops: frozenset = frozenset()
    ternary: bool = False
    case_keywords: frozenset = frozenset({'case'})
    default_markers: frozenset = frozenset({'default', 'else', '_'})
    # Brace family ------------------------------------------------------
    control: frozenset = frozenset()              # keywords whose body is one nesting level deeper
    cond_keywords: frozenset = frozenset()        # control keywords followed by a condition
    brace_required: bool = False                  # Go/Swift: `if cond {` without parentheses
    arm_keywords: frozenset = frozenset()         # blocks whose arms (`->`/`=>`) are decisions
    arm_separators: frozenset = frozenset()
    function_keywords: frozenset = frozenset()    # `function name(`, `fun name(`...
    declaration_functions: bool = False           # C-style `type name(params) {`
    method_shorthand: bool = False                # JS/TS `name(params) {` in classes/objects
    separate_closures: bool = False               # JS/TS: function expressions and arrows are functions
    expression_body_ops: frozenset = frozenset()  # `fun f() = x`, `int F() => x;`
    scope_keywords: frozenset = frozenset()
    qualify: bool = False                         # prefix methods with their class: A::f
    paramless_functions: bool = False             # Perl `sub name {`
    objc_methods: bool = False
    csharp_accessors: bool = False
    zig_captures: bool = False
    try_keywords: frozenset = frozenset({'try', 'finally'})   # bodies that are not nesting (cognitive)
    # Indentation family -------------------------------------------------
    match_arm_keyword: str = ''
    extra: dict = field(default_factory=dict)


C_CONTROL = frozenset({'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally'})
C_COND = frozenset({'if', 'for', 'while', 'switch', 'catch'})
C_DECISIONS = frozenset({'if', 'for', 'while', 'case', 'catch'})
C_SCOPES = frozenset({'class', 'struct', 'union', 'namespace', 'interface', 'enum'})


def _c_lexer(**kwargs) -> LexerConfig:
    return LexerConfig(string_prefixes=kwargs.pop('string_prefixes', 'lLuU8R'), preprocessor=True, **kwargs)


def _brace(name, **kwargs) -> Language:
    kwargs.setdefault('control', C_CONTROL)
    kwargs.setdefault('cond_keywords', C_COND)
    kwargs.setdefault('decisions', C_DECISIONS)
    kwargs.setdefault('ternary', True)
    return Language(name=name, family='brace', **kwargs)


JS_LEXER = dict(quotes=('"', "'"), template_literals=True, regex_literals=True, ident_extra_start='_$',
                ident_extra_part='_$')

LANGUAGES: dict[str, Language] = {
    'C': _brace('C', lexer=_c_lexer(), declaration_functions=True, scope_keywords=C_SCOPES),
    'C++': _brace('C++', lexer=_c_lexer(), declaration_functions=True, scope_keywords=C_SCOPES, qualify=True),
    'Objective-C': _brace('Objective-C', lexer=_c_lexer(string_prefixes='@'), declaration_functions=True,
                          scope_keywords=C_SCOPES, objc_methods=True),
    'Java': _brace('Java', lexer=LexerConfig(triple_quotes=True), declaration_functions=True,
                   scope_keywords=frozenset({'class', 'interface', 'enum', 'record'}), qualify=True),
    'C#': _brace('C#', lexer=LexerConfig(string_prefixes='@$'), declaration_functions=True,
                 decisions=C_DECISIONS | {'foreach', 'when'}, control=C_CONTROL | {'foreach'},
                 arm_keywords=frozenset({'switch-expr'}), arm_separators=frozenset({'=>'}),
                 cond_keywords=C_COND | {'foreach'}, coalesce_ops=frozenset({'??', '??='}),
                 scope_keywords=frozenset({'class', 'struct', 'interface', 'enum', 'record', 'namespace'}),
                 qualify=True, csharp_accessors=True, expression_body_ops=frozenset({'=>'})),
    'JavaScript': _brace('JavaScript', lexer=LexerConfig(**JS_LEXER), coalesce_ops=frozenset({'??', '??='}),
                         function_keywords=frozenset({'function'}), method_shorthand=True,
                         separate_closures=True, scope_keywords=frozenset({'class'})),
    'TypeScript': _brace('TypeScript', lexer=LexerConfig(**JS_LEXER), coalesce_ops=frozenset({'??', '??='}),
                         function_keywords=frozenset({'function'}), method_shorthand=True,
                         separate_closures=True,
                         scope_keywords=frozenset({'class', 'interface', 'enum', 'namespace', 'module'})),
    'Go': _brace('Go', lexer=LexerConfig(backtick_strings=True, operators=(':=',)), ternary=False, brace_required=True,
                 decisions=frozenset({'if', 'for', 'case'}),
                 control=frozenset({'if', 'else', 'for', 'switch', 'select'}),
                 cond_keywords=frozenset({'if', 'for', 'switch', 'select'}),
                 function_keywords=frozenset({'func'}), separate_closures=False),
    'Kotlin': _brace('Kotlin', lexer=LexerConfig(triple_quotes=True, operators=('?:', '!!')), ternary=False,
                     decisions=frozenset({'if', 'for', 'while', 'catch'}),
                     control=C_CONTROL | {'when'}, cond_keywords=C_COND | {'when'},
                     coalesce_ops=frozenset({'?:'}), arm_keywords=frozenset({'when'}),
                     arm_separators=frozenset({'->'}), function_keywords=frozenset({'fun'}),
                     expression_body_ops=frozenset({'='}),
                     scope_keywords=frozenset({'class', 'interface', 'object', 'enum'})),
    'Scala': _brace('Scala', lexer=LexerConfig(triple_quotes=True), ternary=False,
                    decisions=frozenset({'if', 'for', 'while', 'case'}),
                    control=C_CONTROL | {'match'}, cond_keywords=frozenset({'if', 'for', 'while'}),
                    function_keywords=frozenset({'def'}), expression_body_ops=frozenset({'='}),
                    scope_keywords=frozenset({'class', 'object', 'trait'})),
    'Swift': _brace('Swift', lexer=LexerConfig(triple_quotes=True), brace_required=True,
                    decisions=frozenset({'if', 'for', 'while', 'guard', 'case', 'catch'}),
                    control=frozenset({'if', 'else', 'for', 'while', 'repeat', 'switch', 'guard', 'do', 'catch'}),
                    cond_keywords=frozenset({'if', 'for', 'while', 'switch', 'guard', 'catch'}),
                    coalesce_ops=frozenset({'??'}), function_keywords=frozenset({'func', 'init', 'deinit',
                                                                                  'subscript'}),
                    try_keywords=frozenset({'do'}),
                    scope_keywords=frozenset({'class', 'struct', 'enum', 'protocol', 'extension', 'actor'})),
    'Solidity': _brace('Solidity', lexer=LexerConfig(), decisions=frozenset({'if', 'for', 'while', 'catch'}),
                       function_keywords=frozenset({'function', 'modifier', 'constructor', 'fallback', 'receive'}),
                       scope_keywords=frozenset({'contract', 'library', 'interface', 'struct', 'enum'})),
    'PHP': _brace('PHP', lexer=LexerConfig(php_tags=True, line_comments=('//', '#'), ident_extra_start='_$',
                                          ident_extra_part='_', operators=('?->', '?:', '<=>')),
                  decisions=C_DECISIONS | {'foreach', 'elseif'}, control=C_CONTROL | {'foreach', 'elseif', 'match'},
                  cond_keywords=C_COND | {'foreach', 'elseif', 'match'}, bool_ops=frozenset(C_OPS + WORD_BOOL),
                  coalesce_ops=frozenset({'??', '??=', '?:'}), arm_keywords=frozenset({'match'}),
                  arm_separators=frozenset({'=>'}), function_keywords=frozenset({'function'}),
                  scope_keywords=frozenset({'class', 'interface', 'trait', 'enum'}), qualify=True),
    'Zig': _brace('Zig', lexer=LexerConfig(line_comments=('//',), block_comments=(), ),
                  ternary=False, decisions=frozenset({'if', 'for', 'while', 'catch', 'try'}),
                  bool_ops=frozenset({'and', 'or', 'orelse'}), control=frozenset({'if', 'else', 'for', 'while',
                                                                                  'switch'}),
                  cond_keywords=frozenset({'if', 'for', 'while', 'switch'}), arm_keywords=frozenset({'switch'}),
                  arm_separators=frozenset({'=>'}), function_keywords=frozenset({'fn'}), zig_captures=True),
    'Perl': _brace('Perl', lexer=LexerConfig(line_comments=('#',), block_comments=(), regex_literals=True,
                                            line_block_comments=((r'=[a-zA-Z]', r'=cut\b'),),
                                            ident_extra_start='_$@%', ident_extra_part='_', operators=('//',)),
                   decisions=frozenset({'if', 'elsif', 'unless', 'while', 'until', 'for', 'foreach', 'when'}),
                   bool_ops=frozenset(C_OPS + WORD_BOOL + ('//',)),
                   control=frozenset({'if', 'elsif', 'else', 'unless', 'while', 'until', 'for', 'foreach', 'do'}),
                   cond_keywords=frozenset({'if', 'elsif', 'unless', 'while', 'until', 'for', 'foreach'}),
                   function_keywords=frozenset({'sub'}), paramless_functions=True, qualify=True),
    'TTCN-3': _brace('TTCN-3', lexer=LexerConfig(), ternary=False,
                     decisions=frozenset({'if', 'for', 'while', 'case'}),
                     bool_ops=frozenset({'and', 'or'}),
                     control=frozenset({'if', 'else', 'for', 'while', 'do', 'select', 'alt', 'interleave'}),
                     cond_keywords=frozenset({'if', 'for', 'while', 'select'}),
                     function_keywords=frozenset({'function', 'testcase', 'altstep'}),
                     scope_keywords=frozenset({'module'})),
    'Python': Language('Python', 'indent', LexerConfig(line_comments=('#',), block_comments=(),
                                                       triple_quotes=True, string_prefixes='rbfuRBFU',
                                                       raw_strings_prefix='r'),
                       decisions=frozenset({'if', 'elif', 'for', 'while', 'except', 'case'}),
                       bool_ops=frozenset(WORD_BOOL), match_arm_keyword='case'),
    'GDScript': Language('GDScript', 'indent', LexerConfig(line_comments=('#',), block_comments=(),
                                                           triple_quotes=True),
                         decisions=frozenset({'if', 'elif', 'for', 'while'}),
                         bool_ops=frozenset(C_OPS + WORD_BOOL), case_keywords=frozenset(),
                         match_arm_keyword='*'),
    'Ruby': Language('Ruby', 'ruby', LexerConfig(line_comments=('#',), block_comments=(), regex_literals=True,
                                                 line_block_comments=((r'=begin\b', r'=end\b'),),
                                                 ident_extra_start='_@$', ident_suffixes='?!', ruby_symbols=True),
                     decisions=frozenset({'if', 'elsif', 'unless', 'while', 'until', 'for', 'when', 'rescue'}),
                     bool_ops=frozenset(C_OPS + WORD_BOOL), ternary=True, case_keywords=frozenset()),
    'Lua': Language('Lua', 'lua', LexerConfig(line_comments=('--',), block_comments=(), lua_long_brackets=True),
                    decisions=frozenset({'if', 'elseif', 'for', 'while', 'until'}),
                    bool_ops=frozenset(WORD_BOOL), case_keywords=frozenset()),
    'Fortran': Language('Fortran', 'fortran', LexerConfig(line_comments=('!',), block_comments=(),
                                                          case_insensitive=True),
                        decisions=frozenset({'if', 'do', 'case'}),
                        bool_ops=frozenset({'.and.', '.or.'})),
    'Erlang': Language('Erlang', 'erlang', LexerConfig(line_comments=('%',), block_comments=(), quotes=('"',),
                                                       erlang_chars=True, operators=('=:=', '=/=', '<-', '||')),
                       decisions=frozenset(), bool_ops=frozenset({'and', 'or', 'andalso', 'orelse'})),
}

# Vue single-file components are analysed as the language of their <script>.
EXTENSION_LANGUAGE = {
    '.py': 'Python', '.pyw': 'Python', '.pyi': 'Python',
    '.rb': 'Ruby', '.rbw': 'Ruby',
    '.java': 'Java',
    '.c': 'C', '.h': 'C',
    '.cpp': 'C++', '.cxx': 'C++', '.cc': 'C++', '.hpp': 'C++', '.hxx': 'C++',
    '.cs': 'C#',
    '.erl': 'Erlang', '.hrl': 'Erlang',
    '.f90': 'Fortran', '.f95': 'Fortran', '.f03': 'Fortran', '.f08': 'Fortran', '.f': 'Fortran',
    '.gd': 'GDScript',
    '.go': 'Go',
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.kt': 'Kotlin', '.kts': 'Kotlin',
    '.lua': 'Lua',
    '.m': 'Objective-C', '.mm': 'Objective-C',
    '.php': 'PHP', '.phtml': 'PHP', '.php3': 'PHP', '.php4': 'PHP', '.php5': 'PHP',
    '.pl': 'Perl', '.pm': 'Perl',
    '.scala': 'Scala', '.sc': 'Scala',
    '.sol': 'Solidity',
    '.swift': 'Swift',
    '.ts': 'TypeScript', '.tsx': 'TypeScript',
    '.ttcn': 'TTCN-3', '.ttcn3': 'TTCN-3',
    '.zig': 'Zig',
}

FIXED_FORM_EXTENSIONS = {'.f'}
