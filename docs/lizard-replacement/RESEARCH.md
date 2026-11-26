# Lizard audit: what Code-XR consumes and whether Lizard gets it right

Status: research (epic "Replace Lizard"). Lizard version audited: **1.17.31** (the pinned one in
`apps/vscode-extension/src/core/python-env/pythonPackageManifest.ts`). Every behaviour below was
reproduced by running that exact version, with the `ND` extension loaded exactly as
`backend/src/tools/lizard_analyzer.py` loads it; the probe snippets are in the appendix.

## 1. Where Lizard enters the pipeline

One file imports it: `backend/src/tools/lizard_analyzer.py`. Its only caller is
`build_file_snapshot()` in `backend/src/utils/file_analysis_engine.py`, which every analysis mode
goes through (XR, LivePanel, directory, re-analysis, Git export worker, and the dependency graph's
symbol pass, which has a lexical fallback for when Lizard is missing).

`file_metric_summary.py`, `line_metric_utils.py`, `python_comment_analyzer.py` and
`class_counter_analyzer.py` are already Lizard-free: **file-level line counts (`totalLines`,
`codeLines`, `commentLines`, `blankLines`), classes and file size do not come from Lizard.**

## 2. The exact values taken from Lizard

Per function (`lizard.FunctionInfo`), and nothing else:

| Lizard field | Code-XR field | Notes |
|---|---|---|
| `name` | `functionName` (+ `treePath`) | |
| `long_name` | `qualifiedName` | signature text, Lizard's own spacing |
| `start_line` / `end_line` | `lineStart` / `lineEnd` / `spanLines` | `.vue`: offset of the `<script>` block added by Code-XR |
| `nloc` | `lineCount` | non-blank, non-comment lines of the function |
| `cyclomatic_complexity` | `complexity`, `complexityBand` | |
| `parameter_count` | `parameters` | Code-XR re-counts when Lizard says 0 (Obj-C, Lua, Perl, generic fallback) |
| `max_nesting_depth` | `maxNestingDepth` | from the `lizard_ext.lizardnd` extension |
| `len(function_list)` | `functionCount` | |

Derived by Code-XR from those (unchanged by a replacement): `cyclomaticDensity` (CCN / nloc),
file `averageComplexity` / `maxComplexity`, `highComplexityFunctions` (CCN > 10),
`criticalComplexityFunctions` (CCN > 25), `cyclomaticComplexityNumber` (= the file's **average**
CCN, not a file total), `cyclomaticComplexityDensity`, and the parameter / length / nesting
averages and maxima in `xr_field_schema.summarize_function_metrics`.

Lizard's file `nloc` is copied into the intermediate record but never reaches the JSON.

So a replacement has to produce exactly **seven things per function** — name, qualified name,
start line, end line, NLOC, CCN, parameter count, max nesting depth — and the function list itself.

## 3. How Lizard computes them

Lizard is not a parser. It is a per-language **token stream** run through a chain of generators:
`preprocessing → comment_counter → line_counter → token_counter → condition_counter → [ND]`, with a
small per-language state machine deciding where a function starts and ends.

- **CCN** = `1 + number of tokens that belong to the language's condition set`. Nothing else: no
  control-flow graph, no context. A token counts wherever it appears (signature, type annotation,
  string-free code). Default set: `if for while && || ? catch case`. Each language overrides it
  (table in §5).
- **NLOC** = lines carrying at least one non-comment token, between the function's first and last
  token. Standard definition; no problems found.
- **Parameters** = top-level commas in the token list between the parentheses that follow the name.
- **Nesting depth (ND extension)** = a counter incremented on every token in a fixed set
  (`if foreach for while && || ? catch case try def`) and decremented on `}` or, through a
  "hidden bracket" flag, on `;`. It is a heuristic over tokens, not a measure of block nesting.

## 4. Is the cyclomatic complexity right?

**The rule is the standard one; the per-language token sets and the tokenizer are where it breaks.**

McCabe's V(G) = E − N + 2P equals *decision points + 1* for structured code with one entry and one
exit. Lizard implements that "+1 per decision" form and also counts the short-circuit operators
`&&`/`||` (Myers' extension). That is the same choice as PMD, SonarQube's "cyclomatic" and most
modern tools, so it is a **defensible, documented convention, not a bug**. Two convention points
Lizard takes the common side of, and which we should keep to stay comparable:

- every `case` label counts (`case 1: case 2:` = 2). Strict McCabe counts fall-through labels once;
  Lizard only does that with its optional `-E McCabe` extension, which Code-XR does not load.
- `default` / `else` do not count.

Confirmed correct on probes: C, C++, Java, Go, JavaScript, Lua, Fortran, Solidity, Swift (`guard`
counted, `Int?` not), Kotlin `when` arms, C# for `??`, Java `catch`, switch expressions (`case 1 ->`).

Confirmed **wrong** (each reproduced with 1.17.31):

| # | Language | Problem | Effect |
|---|---|---|---|
| C1 | Python | `finally` is in the condition set | +1 per `finally` (it is not a branch) |
| C2 | Python | `match`/`case` (3.10+) not counted | −1 per case arm |
| C3 | GDScript, TTCN-3 | `else` is in the condition set | +1 per `else` |
| C4 | TypeScript | the `?` of an optional parameter / property (`a?: number`) is counted | +1 per optional parameter |
| C5 | JavaScript, TypeScript | `??` is tokenized as two `?` | +2 instead of +1 per `??` |
| C6 | Perl | `:` is in the condition set | a ternary counts +2; any other `:` also counts |
| C7 | Erlang | `not` is in the condition set | +1 per `not` (negation is not a branch) |
| C8 | Kotlin | (withdrawn after re-checking: `when` arms are counted, `else ->` is not — correct) | — |
| C9 | Ruby, Lua | Lua inherits Ruby's set (`&&`, `||`, `rescue`, `ensure`, `when` in Lua) — harmless, those tokens never occur; Ruby misses `unless` | −1 per `unless` in Ruby |
| C10 | Zig | the `else =>` prong is counted like a case | +1 per `switch` with `else` |
| C11 | C# | `foreach` is not in the condition set (found by the differential run on `manual_test/csharp_metrics.cs`) | −1 per `foreach` |

C12–C18 were found later by the differential run on the hard-case corpus
(`backend/tests/metrics_differential/corpus/`); [`SPEC.md`](SPEC.md) section 5 lists them with every
other divergence: Lua `#` drops the rest of the line (C12), Swift `??` not counted (C13), Fortran
`select case`/`case default` counted (C14), GDScript `match` branches not counted (C15), C#
switch-expression arms not counted (C16), a PHP `match` counted once (C17), Scala `case _` counted
(C18). C4 also applies to PHP nullable types.

## 5. Is the rest right?

**Nesting depth is not reliable in any language.** It is the weakest metric Code-XR shows:

| Probe | Lizard ND | Real depth |
|---|---|---|
| `if (a && b) { }` | 2 | 1 |
| three sequential braceless `if (a) a++;` | 3 | 1 |
| `if { for(;;) { while { } } }` in C | **2** | 3 |
| the same in JavaScript (`for…of`) | 3 | 3 |
| `if { if { if (a && b) { } } }` in Java | 4 | 3 |
| a `switch` with three `case` labels | 2 | 1 |
| a 24-line Python function | 10 | 3 |

`&&`, `||`, `?` and `case` raise the depth; `;` inside a `for(;;)` header lowers it. Results depend
on punctuation, not structure.

**File extensions advertised by Code-XR that Lizard does not know** (`metric_language_contract.py`
lists them; Lizard silently falls back to its C reader or finds nothing):

| Extension | What happens |
|---|---|
| `.pyw`, `.pyi`, `.rbw`, `.sc` | **zero functions** — the file looks function-less |
| `.ttcn3` | parsed as C: every `if (…) {` becomes a function **named `if`** (`manual_test/ttcn_metrics.ttcn3` reports two functions called `if`) |
| `.phtml`, `.php3`, `.php4`, `.php5` | parsed as C (no PHP rules) |
| `.hxx` | parsed as C (no C++-specific rules; mostly harmless) |

**Function detection and names**:

- TypeScript generics: `function f<T extends object>(a: T)` is reported as a function **named `>`**,
  and two consecutive generic functions are **merged into that one `>` record** (the second one
  disappears). In the corpus file `typescript_optional.ts`, `identity<T>` is missing altogether.
- TypeScript: a method with a `: void` return annotation swallows the next class member
  (`long_name = 'm ( x : number ) ( )'`, the getter after it is lost).
- C#: properties (`P { get { … } }`) are never detected; a class with only properties has zero
  functions.
- Kotlin: nesting depth is always 0.
- PHP (`.php`): `function f($a, $b)` → `parameters = 1` and `long_name = 'f $a $a $b $b'`.
  Code-XR's fallback only re-counts when Lizard says 0, so PHP parameter counts are wrong.
- Perl: `parameter_count` is always 0 (Code-XR's `my (...) = @_` fallback fixes the common case).
- Cosmetic `long_name` damage in Ruby (`'f a , b )'`), Lua, Kotlin, Scala, Zig, Solidity.

**NLOC and line ranges**: correct wherever the function boundaries are correct.

## 6. Verdict

- The **definition** Lizard uses for CCN is standard and worth keeping exactly, so existing numbers
  stay comparable and most of them do not move.
- The **implementation** has seventeen confirmed per-language CCN errors (C1–C18 without C8), a nesting-depth metric that is
  wrong in every language, four extension families that are silently mis-parsed, and broken names or
  parameter counts for TypeScript generics, accessors and PHP.
- None of this needs a schema change: every fix changes a **value**, never a key.

## 7. What a replacement must keep and what it may change

Keep (the differential tests demand an exact match with Lizard): function list, names, line ranges,
NLOC, parameters, and CCN for every construct Lizard handles right — which is most of them.

Change on purpose (each one an entry in the divergence list of the differential tests, with the
reason): C1–C18 (except the withdrawn C8), nesting depth everywhere (real block nesting; `&&`/`||`/`?` do not nest), the
extension gaps, TypeScript generic names, accessors, PHP parameters.

### Parser choice (decided: option 1)

`tree-sitter-language-pack` 1.8.1 is already installed, but it **downloads each grammar from
github.com on first use** (verified: it fails with no network), and Code-XR's rule is no network
without consent. Lizard works offline. Options:

1. **Own pure-Python lexical analyzer** (Lizard's architecture, rewritten with correct per-language
   rules and a real block stack for nesting). Offline, no native code, same on Linux/Windows/macOS,
   easy to match Lizard where it is right. *Chosen on 2026-11-26; specified in [`SPEC.md`](SPEC.md).*
2. Tree-sitter for everything — most accurate, but metrics stop working offline or until the grammar
   is fetched, and 23 grammars must all exist (TTCN-3 has none in the pack).
3. Hybrid: tree-sitter when the grammar is already cached, the lexical analyzer otherwise — two
   implementations, and the same file can give different numbers on two machines.

## Appendix: reproducing

```bash
python -m venv /tmp/lz && /tmp/lz/bin/pip install lizard==1.17.31
```

```python
import lizard, tempfile, os
fa = lizard.FileAnalyzer(lizard.get_extensions(['ND']))   # same as lizard_analyzer.py
def run(ext, src):
    with tempfile.NamedTemporaryFile('w', suffix=ext, delete=False) as f: f.write(src)
    r = fa(f.name); os.unlink(f.name)
    return [(x.name, x.cyclomatic_complexity, x.parameter_count, x.max_nesting_depth)
            for x in r.function_list]

run('.c',  'int f(int a, int b) {\n  if (a && b) {\n    return 1;\n  }\n  return 0;\n}\n')  # ND 2
run('.ts', 'function f<T extends object>(a: T): T { return a; }\n')                           # name '>'
run('.gd', 'func f(a):\n\tif a:\n\t\treturn 1\n\telse:\n\t\treturn 2\n')                     # CCN 3
run('.js', 'function f(a){\n  return a ?? 1;\n}\n')                                           # CCN 3
run('.pyw', 'def f(a):\n    return a\n')                                                      # []
```
