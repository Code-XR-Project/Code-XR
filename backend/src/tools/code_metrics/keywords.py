"""Reserved words per language, for the Halstead operator/operand split.

A reserved word is an operator; any other identifier is an operand. The lists
are the languages' reserved words (plus the literal keywords ``true``/
``false``/``null``-like values, which are operands and are therefore left
out). Lists are lower-case for the case-insensitive Fortran.
"""

from __future__ import annotations

_C = {
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern',
    'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed',
    'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
    '_Bool', '_Complex', '_Static_assert', '_Alignas', '_Alignof', '_Atomic', '_Noreturn', '_Thread_local',
}
_CPP = _C | {
    'alignas', 'alignof', 'and', 'and_eq', 'asm', 'bitand', 'bitor', 'bool', 'catch', 'class', 'compl', 'concept',
    'consteval', 'constexpr', 'constinit', 'const_cast', 'co_await', 'co_return', 'co_yield', 'decltype', 'delete',
    'dynamic_cast', 'explicit', 'export', 'friend', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'not_eq',
    'operator', 'or', 'or_eq', 'private', 'protected', 'public', 'reinterpret_cast', 'requires', 'static_assert',
    'static_cast', 'template', 'this', 'thread_local', 'throw', 'try', 'typeid', 'typename', 'using', 'virtual',
    'wchar_t', 'xor', 'xor_eq', 'override', 'final',
}
_OBJC = _C | {'self', 'super', 'id', 'in', 'out', 'inout', 'bycopy', 'byref', 'oneway', 'interface',
              'implementation', 'protocol', 'end', 'property', 'synthesize', 'dynamic', 'selector', 'try',
              'catch', 'finally', 'throw', 'class', 'new', 'delete', 'this', 'template', 'namespace', 'using',
              'virtual', 'public', 'private', 'protected', 'operator'}
_JAVA = {
    'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue',
    'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if',
    'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private',
    'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
    'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'var', 'record', 'yield', 'sealed',
    'permits', 'non-sealed',
}
_CSHARP = {
    'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const',
    'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern',
    'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal',
    'is', 'lock', 'long', 'namespace', 'new', 'object', 'operator', 'out', 'override', 'params', 'private',
    'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc',
    'static', 'string', 'struct', 'switch', 'this', 'throw', 'try', 'typeof', 'uint', 'ulong', 'unchecked',
    'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while', 'async', 'await', 'var', 'when', 'where',
    'yield', 'get', 'set', 'init', 'record', 'nameof', 'dynamic', 'not', 'and', 'or', 'with',
}
_JS = {
    'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
    'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'return',
    'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'async', 'of',
    'static', 'get', 'set',
}
_TS = _JS | {'abstract', 'as', 'declare', 'enum', 'implements', 'interface', 'keyof', 'module', 'namespace',
             'private', 'protected', 'public', 'readonly', 'type', 'is', 'infer', 'override', 'satisfies',
             'any', 'unknown', 'never', 'number', 'string', 'boolean', 'symbol', 'object', 'bigint'}
_GO = {
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go',
    'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type',
    'var',
}
_KOTLIN = {
    'as', 'break', 'class', 'continue', 'do', 'else', 'for', 'fun', 'if', 'in', 'interface', 'is', 'object',
    'package', 'return', 'super', 'this', 'throw', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while',
    'by', 'catch', 'constructor', 'finally', 'get', 'import', 'init', 'set', 'where', 'abstract', 'companion',
    'data', 'enum', 'final', 'inline', 'inner', 'internal', 'lateinit', 'open', 'operator', 'override', 'private',
    'protected', 'public', 'sealed', 'suspend', 'vararg',
}
_SCALA = {
    'abstract', 'case', 'catch', 'class', 'def', 'do', 'else', 'extends', 'final', 'finally', 'for', 'forSome',
    'if', 'implicit', 'import', 'lazy', 'match', 'new', 'object', 'override', 'package', 'private', 'protected',
    'return', 'sealed', 'super', 'this', 'throw', 'trait', 'try', 'type', 'val', 'var', 'while', 'with', 'yield',
    'given', 'using', 'enum', 'then', 'export',
}
_SWIFT = {
    'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout',
    'internal', 'let', 'open', 'operator', 'private', 'protocol', 'public', 'rethrows', 'static', 'struct',
    'subscript', 'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough',
    'for', 'guard', 'if', 'in', 'repeat', 'return', 'switch', 'where', 'while', 'as', 'catch', 'is', 'super',
    'self', 'Self', 'throw', 'throws', 'try', 'await', 'async', 'actor', 'some', 'any',
}
_SOLIDITY = {
    'contract', 'library', 'interface', 'function', 'modifier', 'event', 'struct', 'enum', 'mapping', 'returns',
    'return', 'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'emit', 'public', 'private', 'internal',
    'external', 'pure', 'view', 'payable', 'constant', 'immutable', 'memory', 'storage', 'calldata', 'new',
    'delete', 'try', 'catch', 'revert', 'require', 'assert', 'using', 'is', 'override', 'virtual', 'constructor',
    'fallback', 'receive', 'unchecked', 'assembly', 'import', 'pragma', 'uint', 'int', 'address', 'bool',
    'string', 'bytes', 'uint256', 'int256', 'bytes32', 'error', 'type',
}
_PHP = {
    'abstract', 'and', 'array', 'as', 'break', 'callable', 'case', 'catch', 'class', 'clone', 'const', 'continue',
    'declare', 'default', 'do', 'echo', 'else', 'elseif', 'empty', 'enddeclare', 'endfor', 'endforeach', 'endif',
    'endswitch', 'endwhile', 'extends', 'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto',
    'if', 'implements', 'include', 'include_once', 'instanceof', 'insteadof', 'interface', 'isset', 'list',
    'match', 'namespace', 'new', 'or', 'print', 'private', 'protected', 'public', 'readonly', 'require',
    'require_once', 'return', 'static', 'switch', 'throw', 'trait', 'try', 'unset', 'use', 'var', 'while', 'xor',
    'yield', 'enum',
}
_ZIG = {
    'addrspace', 'align', 'allowzero', 'and', 'anyframe', 'anytype', 'asm', 'async', 'await', 'break',
    'callconv', 'catch', 'comptime', 'const', 'continue', 'defer', 'else', 'enum', 'errdefer', 'error', 'export',
    'extern', 'fn', 'for', 'if', 'inline', 'linksection', 'noalias', 'noinline', 'nosuspend', 'opaque', 'or',
    'orelse', 'packed', 'pub', 'resume', 'return', 'struct', 'suspend', 'switch', 'test', 'threadlocal', 'try',
    'union', 'unreachable', 'usingnamespace', 'var', 'volatile', 'while',
}
_PERL = {
    'my', 'our', 'local', 'sub', 'if', 'elsif', 'else', 'unless', 'while', 'until', 'for', 'foreach', 'do',
    'last', 'next', 'redo', 'return', 'package', 'use', 'no', 'require', 'and', 'or', 'not', 'xor', 'eq', 'ne',
    'lt', 'gt', 'le', 'ge', 'cmp', 'given', 'when', 'default', 'die', 'eval', 'wantarray', 'shift', 'print',
    'BEGIN', 'END',
}
_TTCN = {
    'module', 'import', 'from', 'all', 'type', 'record', 'set', 'union', 'enumerated', 'of', 'function',
    'testcase', 'altstep', 'runs', 'on', 'system', 'mtc', 'return', 'var', 'const', 'template', 'if', 'else',
    'for', 'while', 'do', 'select', 'case', 'alt', 'interleave', 'repeat', 'goto', 'label', 'stop', 'and', 'or',
    'xor', 'not', 'in', 'out', 'inout', 'timer', 'port', 'component', 'create', 'start', 'send', 'receive',
    'activate', 'deactivate', 'verdict', 'setverdict', 'integer', 'float', 'boolean', 'charstring',
}
_PYTHON = {
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
    'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass',
    'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case',
}
_GDSCRIPT = _PYTHON | {'func', 'var', 'const', 'signal', 'extends', 'class_name', 'enum', 'static', 'export',
                       'onready', 'tool', 'self', 'preload', 'setget', 'remote', 'master', 'puppet'}
_RUBY = {
    'BEGIN', 'END', 'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined?', 'do', 'else', 'elsif',
    'end', 'ensure', 'for', 'if', 'in', 'module', 'next', 'not', 'or', 'redo', 'rescue', 'retry', 'return', 'self',
    'super', 'then', 'undef', 'unless', 'until', 'when', 'while', 'yield',
}
_LUA = {
    'and', 'break', 'do', 'else', 'elseif', 'end', 'for', 'function', 'goto', 'if', 'in', 'local', 'not', 'or',
    'repeat', 'return', 'then', 'until', 'while',
}
_FORTRAN = {
    'program', 'module', 'submodule', 'subroutine', 'function', 'end', 'contains', 'use', 'implicit', 'none',
    'integer', 'real', 'double', 'precision', 'complex', 'character', 'logical', 'type', 'class', 'dimension',
    'allocatable', 'pointer', 'target', 'intent', 'in', 'out', 'inout', 'parameter', 'optional', 'save', 'if',
    'then', 'else', 'elseif', 'endif', 'do', 'enddo', 'while', 'select', 'case', 'default', 'exit', 'cycle',
    'return', 'call', 'stop', 'goto', 'continue', 'allocate', 'deallocate', 'where', 'forall', 'interface',
    'recursive', 'pure', 'elemental', 'result', 'print', 'write', 'read', 'open', 'close', 'format', 'public',
    'private', 'only', 'procedure', '.and.', '.or.', '.not.', '.eqv.', '.neqv.',
}
_ERLANG = {
    'after', 'and', 'andalso', 'band', 'begin', 'bnot', 'bor', 'bsl', 'bsr', 'bxor', 'case', 'catch', 'cond',
    'div', 'end', 'fun', 'if', 'let', 'not', 'of', 'or', 'orelse', 'receive', 'rem', 'try', 'when', 'xor',
    'maybe', 'else',
}

RESERVED: dict[str, frozenset] = {
    'C': frozenset(_C), 'C++': frozenset(_CPP), 'Objective-C': frozenset(_OBJC), 'Java': frozenset(_JAVA),
    'C#': frozenset(_CSHARP), 'JavaScript': frozenset(_JS), 'TypeScript': frozenset(_TS), 'Go': frozenset(_GO),
    'Kotlin': frozenset(_KOTLIN), 'Scala': frozenset(_SCALA), 'Swift': frozenset(_SWIFT),
    'Solidity': frozenset(_SOLIDITY), 'PHP': frozenset(_PHP), 'Zig': frozenset(_ZIG), 'Perl': frozenset(_PERL),
    'TTCN-3': frozenset(_TTCN), 'Python': frozenset(_PYTHON), 'GDScript': frozenset(_GDSCRIPT),
    'Ruby': frozenset(_RUBY), 'Lua': frozenset(_LUA), 'Fortran': frozenset(_FORTRAN), 'Erlang': frozenset(_ERLANG),
}


def reserved_words(language_name: str) -> frozenset:
    return RESERVED.get(language_name, frozenset())
