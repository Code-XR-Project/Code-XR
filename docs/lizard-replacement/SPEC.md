# Code-XR's own code-metrics analyzer: specification

Epic #140 replaces Lizard with `backend/src/tools/code_metrics/` (a pure-Python lexical analyzer,
no native code, no network) behind `backend/src/tools/code_metrics_analyzer.py`, which returns the
same JSON envelope and the same keys as `lizard_analyzer.py`. This document states what each value
means, the per-language rules, and every place where the new values deliberately differ from
Lizard 1.17.31. The audit behind it is [`RESEARCH.md`](RESEARCH.md).

The differential tests (`backend/tests/metrics_differential/`) enforce this document: every value
Lizard gets right must come out identical, and every difference must be an entry in
`divergences.json` whose `spec` field names one of the IDs in section 5.

## 1. Output contract (unchanged)

Per function: `name`, `longName`, `lineStart`, `lineEnd`, `lineCount`, `complexity`, `parameters`,
`maxNestingDepth`, `cyclomaticDensity`. Per file: `complexity.average/max/functionCount/high/critical`
(high > 10, critical > 25), the `status`/`unsupported` envelope, and the same language list and
extensions as `metric_language_contract.py`. No key is added, removed or renamed.

## 2. Definitions

**Cyclomatic complexity (`complexity`).** McCabe's V(G) in the "decision points + 1" form, with
short-circuit operators counted (Myers' extension), the convention Lizard, PMD and SonarQube share:

`complexity = 1 + count of:`

- branch keywords: `if`, `elif`/`elsif`/`elseif`, `unless`, `guard` (Swift);
- loops: `for`, `foreach`, `while`, `until`, `do` (Fortran), and the loop condition of `repeat … until` (Lua);
- each non-default `case`/`when` arm, and each non-default arm of Kotlin `when`, PHP `match`,
  C# switch expressions and Zig `switch` (`->`/`=>` arms), plus each C# `when` guard; in Python, each `case` of a `match` except the wildcard `case _:`;
  in GDScript each `match` branch except `_`; in Erlang each extra clause of a function,
  `case`, `if`, `receive`, `try` or multi-clause `fun`, and each `when` guard;
- exception handlers: `catch`, `except`, `rescue`;
- boolean short-circuit operators: `&&`, `||`, `and`, `or`, `andalso`, `orelse`, `.and.`, `.or.`;
- the conditional operator `?:` (counted once, at the `?`);
- null-coalescing: `??`, `??=`, Kotlin/PHP `?:`, Perl `//`, Zig `orelse`.

Never counted: `else`, `default`, `finally`/`ensure`, `case _`/`case else`/`case default`, optional
chaining `?.`, nullable/optional type markers (`Int?`, `a?: T`), negation (`not`, `!`).

**Nesting depth (`maxNestingDepth`).** The deepest control-structure nesting inside the function
body, measured on the real block structure. The function body is depth 0; the body of each
`if`/`else`/`elif`, loop, `switch`/`match`/`when`/`select`, `try`/`catch`/`finally` is one
level deeper than the statement that contains it. A braceless body (`if (a) b();`)
counts as one level. An `else if` chain stays at the level of its first `if`; `case` arms share
the level of their `switch`; lambdas and nested functions are not nesting; `&&`, `||` and `?:` are
not nesting, and neither are blocks that are not control flow (Python `with`, C `{ }`).

**Lines (`lineStart`, `lineEnd`, `lineCount`).** `lineStart` is the line of the function's name
(of the first parameter list for anonymous functions); `lineEnd` the line of its last token;
`lineCount` (NLOC) the number of distinct lines holding at least one code token that belongs to
the function: comments and blank lines are not counted, and a Python docstring is documentation
(PEP 257), not code.

**Parameters.** The number of formal parameters in the declaration. A destructuring pattern is one
parameter; `void` (C), Python's `*`/`/` markers and empty lists are none. Perl subs have no
signature: `my (...) = @_` or `my $x = shift` are counted, as Code-XR already did.

**Names.** `name` follows Lizard: qualified with the enclosing class/namespace in C++, Java, C#,
PHP and Perl (`A::f`), with the module in Fortran (`mod::f`), with the outer function in Python
(`outer.inner`); C# property accessors are `Class::get_P`/`Class::set_P`; JS/TS getters and
setters are `get p`/`set p`; anonymous functions are `(anonymous)` unless assigned
(`const f = () =>` → `f`); Objective-C methods use the selector (`sel: part:`); Lua methods keep
their table path (`Box:compute`). `longName` is `name(parameter text)` in every language.

**What is a function.** Named functions, methods, constructors, accessors and, in JavaScript and
TypeScript, every function expression and arrow function (as Lizard does). In the other languages a
lambda belongs to the enclosing function. A TypeScript function *type* (`cb: (x: T) => void`,
`type F = (a) => b`, `Record<K, (x) => void>`) is not a function.

## 3. Architecture

| Module | Role |
|---|---|
| `lexer.py` | One configurable tokenizer: comments (incl. nested, line-start `=begin`/POD, Fortran fixed form), strings (prefixes, raw, triple, template literals with `${}`), regex literals, Lua long brackets, PHP tags, C preprocessor lines. |
| `languages.py` | The 23 contract languages: decision sets, operators, family, and per-language switches; extension → language map. |
| `common.py` | `is_decision`: the shared CCN rule (member access, default arms, ternary detection). |
| `brace_parser.py` | C, C++, Objective-C, Java, C#, JavaScript, TypeScript, Go, Kotlin, Scala, Swift, Solidity, PHP, Zig, Perl, TTCN-3: block stack, per-paren-level statement headers, braceless bodies. |
| `indent_parser.py` | Python, GDScript: logical lines and indentation blocks. |
| `end_parser.py` | Ruby, Lua: keyword/`end` blocks with modifier detection. |
| `fortran_parser.py` | Fortran free and fixed form: statements, units, labelled DO. |
| `erlang_parser.py` | Erlang forms and clauses. |

Vue: the first `<script>` block is analyzed in place (other lines blanked, so line numbers are the
file's), as TypeScript when `lang="ts"`/`"tsx"`.

## 4. Where the values agree with Lizard

Function list, names, start lines and CCN agree with Lizard for every construct Lizard handles
correctly: the whole `manual_test/` corpus outside the entries below. Parameters and NLOC agree
wherever the function boundaries agree.

## 5. Divergence catalogue

| ID | Languages | Lizard | Ours |
|---|---|---|---|
| C1 | Python | `finally` +1 | not a branch |
| C2 | Python | `match`/`case` ignored | +1 per non-wildcard `case` |
| C3 | GDScript, TTCN-3 | `else` +1 | not a branch |
| C4 | TypeScript, PHP | optional `a?: T` / nullable `?T` +1 | not a branch |
| C5 | JavaScript, TypeScript, PHP | `??` +2 | +1 |
| C6 | Perl | every `:` +1 (ternary = 2) | ternary +1 |
| C7 | Erlang | `not` +1 | not a branch |
| C9 | Ruby | `unless` not counted | +1 |
| C10 | Zig | `else =>` prong +1 | default prong not counted |
| C11 | C# | `foreach` not counted | +1 |
| C12 | Lua | the length operator `#` drops the rest of the line (its `and`/`or` are lost) | counted |
| C13 | Swift | `??` not counted | +1 |
| C14 | Fortran | the `case` of `select case`, and `case default`, +1 | only non-default `case` arms |
| C15 | GDScript | `match` branches not counted | +1 per non-wildcard branch |
| C16 | C# | switch-expression arms and `when` guards not counted | +1 each, except the `_` arm |
| C17 | PHP | a `match` counts once | +1 per non-default arm |
| C18 | Scala | wildcard `case _` +1 | not counted |
| ND | all | token heuristic (`&&`, `?`, `case` raise it; `;` lowers it) | block nesting (section 2) |
| EXT | `.pyw` `.pyi` `.rbw` `.sc` `.ttcn3` `.mm` `.php3-5` | no functions, or parsed as C (functions named `if`/`for`, no PHP rules) | parsed with the language's own rules |
| NAME-SIG | Go, Kotlin, Scala, Swift, Solidity, Zig, Ruby, PHP, Lua, Java anonymous classes | `longName` without parentheses, with parameters repeated, a parenthesis missing or the Go receiver kept | `name(params)` |
| NAME-ANON | JavaScript, Go | an anonymous function is named after the call it is passed to (`list.forEach`) or `unknown` | the variable it is assigned to, else `(anonymous)` |
| NAME-NESTED | Python | a doubly nested function repeats the outer name (`retry.retry.decorator.wrapper`) | `retry.decorator.wrapper` |
| NAME-PERL | Perl | only the first segment of `package A::B` | `A::B::f` |
| LUA-NAMES | Lua | every method named after its table (`MetricBox`) | `MetricBox:compute` |
| ERLANG | Erlang | every function at line 1 with NLOC 1; record fields counted as parameters; with macros, clauses and guards lost | the clause's real lines and decisions |
| LINES | TypeScript, TSX, Vue, Scala, Ruby | `lineEnd` runs into the next member or the enclosing block, or stops before the last `end` | ends at the function's last token |
| TS-GENERIC | TypeScript | a generic function is lost, named `>` or merged into the previous one | detected on its own |
| TS-FUNC-TYPE | TypeScript | a function type (`cb: (x: T) => void`) is read as a function and the real one around it is lost | a type is not a function |
| JS-LEXING | JavaScript | a regex or template literal derails the reader: functions lost or invented | lexed correctly |
| ARROW | JavaScript, TypeScript, TSX | arrow functions or their parameters missed | detected, parameters counted |
| EXPR-BODY | Kotlin, Scala | expression-bodied functions (`fun f() = …`, `def f = …`) missed | detected |
| CS-ACCESSOR, CS-MEMBERS | C# | accessors, expression-bodied members and switch-expression methods missed; an `if` reported as a function | detected; no false function |
| SOL-MEMBERS | Solidity | modifiers, constructors, `receive`/`fallback` skipped | detected |
| SWIFT-INIT | Swift | `private(set)` reported as a function `set`; `init` missed | `init` detected |
| PERL-LEXING | Perl | `//` read as a regex, the function lost | an operator |
| FORTRAN-PROGRAM | Fortran | a main `program` unit is not reported | reported like a subroutine |
| PARAMS-PHP | PHP | `parameters = 1` whatever the list | the real count |
| PARAMS-DESTRUCT | TSX/JS/TS | a destructured `{a, b}` counts its names | one parameter |
| PARAMS-GO | Go | a named result `(total int)` counted as a parameter | not a parameter |
| PARAMS-PERL | Perl | always 0 (Code-XR only re-counted `my (...) = @_`) | also `my $x = shift` |

The impact on Code-XR's numbers: CCN changes only where one of C1–C11 applies; nesting depth
changes in most functions (it was wrong); line ranges, names and parameters change only for the
broken cases above.
