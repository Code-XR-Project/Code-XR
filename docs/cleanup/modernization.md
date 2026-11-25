# Language modernization inventory (story #56)

> **Status:** analysis only, 2026-11-25, measured on `v1.2.1` at `e16b95e8` (after PRs #44–#57, #40 included). No source file is changed by this document. **Story:** [#56](https://github.com/Code-XR-Project/Code-XR/issues/56), epic [#26](https://github.com/Code-XR-Project/Code-XR/issues/26). Companion of [`src-layout.md`](src-layout.md) (#55).
> Every count comes from the AST scripts and commands in the [appendix](#appendix-how-to-re-run-the-numbers). Paths are relative to `apps/vscode-extension/` for TypeScript and templates, and to `backend/` for Python.

## 0. Summary

The code is less old-fashioned than its size suggests. There is no `var`, no `namespace`, no `Function` type, no `arguments` and no callback-style `fs`/`child_process` left in `src/`. The Python has no `%` or `.format()` strings, no bare `except:` and no `class X(object)`. The browser runtimes already ship optional chaining 1,413 times. What remains, by value:

| # | Item | Count | Where it matters | Recommendation |
|---|---|---:|---|---|
| 1 | TS `any` / `as any` | 166 / 36 (of the 166), 51 files | `executePython.ts` 19, `directoryReanalysisData.ts` 17, `activeAnalysesDataService.ts` 11 | Type file by file, outside the files #35 reshapes. Already ratcheted (`any.total`). |
| 2 | Python `typing.List/Dict/Tuple/Optional/…` in annotations | 310 occurrences, 13 files (ruff FA100: 309) | `utils/dependency_analysis_engine.py` (101 lines carry one) | `from __future__ import annotations` + builtin generics and `X \| None`, **in annotations only**. Safe on the 3.7 floor. |
| 3 | Browser `var` | 2,303 in 14 runtimes (2,014 in 9 multi-part runtimes) | `analysisTableRuntime` 494, `dependencyGraphRuntime` 372, `xrChartMappingUiRuntime` 356 | Convert only the 5 standalone runtimes (289) now. The multi-part ones wait for 1.3.0 (§2.3). |
| 4 | TS `x \|\| literal` where `??` may be meant | 239, 72 files | `activeAnalysesCommands.ts` 19, `executePython.ts` 13 | Only where the left side cannot be `''`, `0` or `false`: typed `prefer-nullish-coalescing` with `ignorePrimitives`. Measure what it flags first. |
| 5 | TS inline `require()` of Node built-ins | 15, 4 files | `executePython.ts` 8 (#35's file), `directoryAnalysisLivePanelCommands.ts` 4, `SSEManager.ts` 2, `activeServerItems.ts` 1 | Top-level `import`. The 8 lazy `require()`s in `ModularTreeDataProvider.ts` and the 2 cycle-breaking relative ones stay. |

Then come small, cheap items: `.then()` chains (24), string concatenation (24 in TS, 611 in templates), `a && a.b` (11), `indexOf` compares (5), `substr` (1), `[].slice.call`/`arguments` in templates (7 + 7). **Leave alone:** IIFE/UMD wrappers in templates (22), `self = this` in A-Frame components (25), the 2 enums, the 25 `new Promise` wrappers around event APIs, the 109 synchronous `fs` calls inside async functions, `os.path` → `pathlib` (50 calls), and every contract or text-pinned line listed in §4.

**Ordering with #55:** never modernize and move a file in the same commit. Git's rename detection (50% similarity) and the H3 move proof both rely on a move being path-only. Run this story either before the move wave or after it, not interleaved, and in either case after #34 and #35, which rewrite most of the top files (#40 has merged, PR #57, and these numbers include it).

**Decision for the maintainer:** the Python floor. `backend/ruff.toml` says `target-version = "py37"`, and `venvManager.ts` asks users for "Python 3.7+", not 3.8. Everything proposed here is 3.7-safe (PEP 563's future import exists since 3.7, f-strings since 3.6). Raising the floor to 3.9 would allow builtin generics at runtime too (PEP 585), but that is a user-visible requirement change for 1.3.0, not a cleanup.

## 1. TypeScript (`src/`, 328 files)

Target: `tsconfig.json` compiles to `ES2022` / `Node16` modules, and the extension host is Node ≥ 20 (`engines.vscode ^1.98`). Typed linting is already on for `src/` (`parserOptions.projectService` in `eslint.config.mjs`), so the type-aware `@typescript-eslint` rules below are available without new dependencies.

| Idiom | Count | Top files | Modern replacement | Risk | Lock-in afterwards |
|---|---:|---|---|---|---|
| `var` | **0** | — | — | — | `no-var: error` (free, keeps it at 0) |
| `namespace` | **0** | — | — | — | `@typescript-eslint/no-namespace: error` |
| `Function` type | **0** | — | — | — | `@typescript-eslint/no-unsafe-function-type: error` |
| `arguments` object | **0** | — | — | — | `prefer-rest-params: error` |
| callback-style `fs.*` / `child_process.*` (callback argument) | **0** | — | — | — | — |
| `x != null ? x : d` | **0** | — | — | — | covered by the `??` rule below |
| `require()` of a package (Node built-ins inline in a function) | 15 in 4 files | `code_analysis/engine/utils/executePython.ts` 8, `code_analysis/commands/directory_analysis/directoryAnalysisLivePanelCommands.ts` 4, `servers/runtime/sse/SSEManager.ts` 2, `views/active_servers/items/activeServerItems.ts` 1 | `import * as fs from 'fs'` / `import * as path from 'path'` at the top | Low. Built-ins are already loaded, so evaluation order does not matter. `executePython.ts` is #35's file and 7 test files read it: leave its 8 to #35 | `@typescript-eslint/no-require-imports: error`, with a per-file override (not an `eslint-disable`, which the `suppressions` guardrail counts) for `ModularTreeDataProvider.ts` and the two cycle breakers |
| `require()` of a relative module | 2 (+8 excluded) | `code_analysis/engine/watchers/directoryReAnalyzer.ts` (lazy `SSEManager`), `utils/getVisualizationConfiguration.ts` (lazy settings) | — | **Leave.** Both are lazy loads that avoid a load-time cycle. The 8 in `views/ModularTreeDataProvider.ts` are load-bearing (cleanup skill §4) | same override |
| `.then()` chains | 24 in 15 files (+10 `.catch()` on a call) | `remote_access/services/remoteAccessManager.ts` 3, `servers/commands/serverCommands.ts` 3, `servers/views/interactions/launchNotifications.ts` 3, `code_analysis/historical/gitAnalysisEligibility.ts` 2 | `await` inside an `async` function | Medium. Convert only where the promise is already returned or awaited. A fire-and-forget `showInformationMessage(…).then(choice => …)` stays: making it `await` changes when the caller resumes. `no-floating-promises` (warn) already reports the dangerous ones | none without a new plugin; record only |
| string concatenation with a literal | 24 in 15 files | `code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.ts` 3, `python_env/runtime/venvManager.ts` 3, `remote_access/services/remoteAccessManager.ts` 3, `babia_templates/processing/templateHTMLProcessor.ts` 2 | template literal | Low, with one exception: `templateHTMLProcessor.ts` builds scene HTML, and the generated text must stay byte-identical (feature-baseline goldens) | `prefer-template: error` |
| `a && a.b` / `a && a.f()` | 11 in 5 files | `visualization_settings/utils/settingsAccessors.ts` 4, `views/babia_examples/interactions/handleBabiaExampleClicks.ts` 3, `code_analysis/services/serverWatcherIntegration.ts` 2 | `a?.b` | Low in boolean contexts. Different value when `a` is `0`/`''`/`false` (returns `a`, not `undefined`): the typed rule only rewrites the safe ones | `@typescript-eslint/prefer-optional-chain: error` |
| `x \|\| literal` | 239 in 72 files | `…/active_analyses/commands/activeAnalysesCommands.ts` 19, `code_analysis/engine/utils/executePython.ts` 13, `code_analysis/engine/watchers/directoryReanalysisData.ts` 10, `servers/runtime/remote/remotePairingApi.ts` 9 | `x ?? literal` **only when `x` cannot be `''`, `0` or `false`** | **High if done blindly**: `'' \|\| 'default'` and `'' ?? 'default'` differ, and many of these read settings or user JSON where `''` and `0` are real values. Not behaviour-neutral by default | `@typescript-eslint/prefer-nullish-coalescing: error` with `ignorePrimitives: { string: true, number: true, boolean: true, bigint: true }`, so only object-typed operands are flagged. Run it in report mode first and size the commit by its output |
| `any` (incl. `as any`) | 166 (36 `as any`) in 51 files | `code_analysis/engine/utils/executePython.ts` 19, `code_analysis/engine/watchers/directoryReanalysisData.ts` 17, `…/active_analyses/services/activeAnalysesDataService.ts` 11, `code_analysis/engine/watchers/directoryReAnalyzer.ts` 9 | precise types, `unknown` plus narrowing at JSON boundaries | Low per change (types only: H1 identical bundle applies), high in volume | Already ratcheted: `any.total` in `guardrail-baseline.json` and `no-explicit-any: warn` under the warning budget. Turn it into `error` per folder once a folder reaches 0 |
| `indexOf(…) !== -1` / `=== -1` | 5 in 3 files | `executePython.ts` 3, `export/gitExportPythonWorkerPool.ts` 1, `historical/gitBatchObjectReader.ts` 1 | `includes()` | Low | `@typescript-eslint/prefer-includes: error` |
| `substr()` | 1 | `servers/runtime/multiServerLauncher.ts` | `slice()` (same result for non-negative arguments; check the call) | Low | `no-restricted-properties` on `substr` |
| classic index `for` loops | 2, both use the index | `historical/gitTimelineSampler.ts`, `historical/projectEvolutionService.ts` | — | **Leave**: the index is needed | — |
| `enum` | 2 | `utils/errorHandler.ts` (`ErrorDomain`, `ErrorSeverity`) | `as const` object + union type | **Leave**: not clearly better. Both are only used as values inside the extension, and the change is pure churn | — |
| `new Promise(…)` | 25 in 14 files | `export/gitExportPythonWorkerPool.ts` 4, `historical/gitBatchObjectReader.ts` 4, `remote_access/services/cloudflaredBinaryManager.ts` 3 | — | **Leave**: they wrap event APIs (`spawn`, streams, `server.listen`), which have no promise form. `events.once()` fits a few but is not clearer | — |
| `fs.*Sync` inside an `async` function | 109 in 36 files | `export/exportManifest.ts` 13, `…/profile_configuration/profileConfigurationCommands.ts` 10, `commands/clean_analysis/cleanAnalysisCommands.ts` 8, `babia_examples/runtime/exampleLauncher.ts` 6 | `fs.promises` | **Leave in a cleanup**: it changes interleaving (another handler can run between awaited steps) and the atomicity the export transaction relies on. If profiling shows a blocked extension host, it is #35/#41 performance work with its own characterization | — |

Text pins on the TypeScript candidates (test files that read the file, from `pins`, appendix of `src-layout.md`): `executePython.ts` 7 (left to #35), `activeAnalysesCommands.ts` 3, `remoteAccessManager.ts` 2, `serverCommands.ts` 1, `multiServerLauncher.ts` 1, `settingsAccessors.ts` 1, `directoryReanalysisData.ts` 1, `activeAnalysesDataService.ts` 1. `directoryAnalysisLivePanelCommands.ts`, `launchNotifications.ts`, `handleBabiaExampleClicks.ts` and `errorHandler.ts` have none. Before each commit, read the pinning tests and classify each pin G/S/L (cleanup skill): an idiom change that alters a pinned line (for example an import line) is S or L, never silently updated.

## 2. Browser JavaScript (`templates/`, 100 files → 31 runtime units, 33,995 lines)

### 2.1 Which browsers, which ES level

- Scenes run A-Frame **1.7.1** (`aframe.io/releases/1.7.1`) with aframe-extras 7.5.4 and babia-components 1.3.4, in the Meta Quest Browser (Chromium-based), desktop Chrome/Edge/Firefox, and VS Code's webview (Electron/Chromium) for the LivePanel. A-Frame 1.7 already needs a WebXR-era browser.
- The shipped runtimes **already use ES2020**: optional chaining 1,413 times in 19 units, `let`/`const` 1,013, arrow functions 251, template literals 171, classes 6. ES2020 is therefore the proven floor, and moving `var` code to ES2015 constructs adds no new browser requirement. ESLint parses `templates/**/*.js` as `ecmaVersion: 2022`, `sourceType: "script"`.
- **Stay with classic scripts.** Runtimes are injected inline into generated HTML in a fixed load order (`templates/components/COMPONENTS.md`), read by Node tests through UMD footers (`module.exports` behind `typeof module`), and assembled from parts (`runtimeAssembly.ts`). ES modules would change all three.

### 2.2 Inventory

Multi-part runtimes are counted assembled (`manifest.json` order), because their parts cannot be parsed alone. That is also why `eslint.config.mjs` ignores `templates/components/codexr/*/*Runtime/**`.

| Idiom | Count | Top units | Modern replacement | Risk | Lock-in |
|---|---:|---|---|---|---|
| `var` | 2,303 in 14 units | multi-part: `analysis-table` 494, `dependency-graph` 372, `xr-chart-mapping-ui` 356, `project-evolution` 236, `historical-comparison` 192, `analysis-mode` 153, `xr-chart-debug` 120, `guide-screen` 46, `logo` 45 (= 2,014); standalone: `common/codexrGitRefPickerRuntime.js` 120, `common/codexrCommonRuntime.js` 84, `codexr/debug` 37, `render-budget` 26, `dependency-visual-budget` 22 (= 289) | `const` / `let` | See §2.3 | `no-var: error` + `prefer-const` per converted file (ESLint `files:` entry), standalone runtimes only |
| top-level IIFE/UMD wrapper | 22 units | every runtime | — | **Leave**: it is the module system of a classic script and the hook for the Node `require()` tests | — |
| `self = this` (and `that`) | 25 in 5 units | `dependency-graph` 11, `analysis-table` 6, `logo` 5, `pointer-policy` 2, `debug` 1 | arrow functions | **Leave**: idiomatic in A-Frame component definitions (`init()` handlers), and changing handler functions to arrows changes `this` for any handler that is also removed by reference | — |
| string `+` concatenation | 611 in 17 units | `dependency-graph` 102, `project-evolution` 92, `historical-comparison` 79 | template literals | Low per line, high churn. Several build HTML or A-Frame attribute strings that tests compare as text | `prefer-template` only on files already converted; otherwise opportunistic |
| index `for` loops | 25 in 8 units | `xr-chart-debug` 7, `xr-chart-mapping-ui` 5, `analysis-table` 4 | `for…of` where the index is unused | Low; review each (several use the index) | — |
| `[].slice.call(list)` / `Array.prototype.forEach.call` | 7 in 3 units | `analysis-table` 3, `xr-chart-mapping-ui` 3, `analysis-mode` 1 | `Array.from(list)` / `for…of` over the `NodeList` | Low (ES2015, already below the floor) | — |
| `arguments` | 7 in 3 units | `analysis-table` 4, `project-evolution` 2, `analysis-mode` 1 | rest parameters | Low-medium: check `arguments.length` uses for optional-argument logic | `prefer-rest-params` on converted files |
| `X.prototype.m = …` classes | **0** | — | — | — | — |
| manual loops over DOM lists (`querySelectorAll(…).length`) | **0** | — | — | — | — |
| `XMLHttpRequest` | **0** | — | — | — | — |

### 2.3 Why `var` is not a mechanical change here

`var` → `let`/`const` is behaviour-neutral only when none of these four apply:

1. **Global scope of a classic script.** A top-level `var` becomes a `window` property and `let`/`const` do not. Code that reads `window.X` (A-Frame's registries, other runtimes, the harnesses) breaks.
2. **Use before declaration.** `var` hoists as `undefined`, while `let` throws (TDZ). In a multi-part runtime the parts are concatenated into one IIFE in manifest order, so a part that touches a binding declared by a later part at load time is exactly this case.
3. **Redeclaration** in one function: legal for `var`, a `SyntaxError` for `let`.
4. **Closures in loops.** A `var` loop variable is shared by every closure, a `let` one is per iteration.

ESLint's `no-var` fixer declines exactly these cases. So for the **5 standalone runtimes** (289 `var`s), the safe procedure is to run the fixer with this rule alone on the commit's file, review the diff, and convert by hand whatever it left. The multi-part runtimes cannot be linted part by part, so the fixer cannot help there: converting 2,014 declarations by hand across 9 runtimes is high churn for no user-visible gain. **Defer them to 1.3.0, or convert a runtime when a feature touches it anyway**, with its harness.

Gates for any template change: the matching harness (`npm run test:xr-harness`, the runtime's unit suite under `test/analysis/*Runtime.test.cjs`), `runtimeAssemblyParity.test.cjs`, and the feature-baseline test (it pins every file under `templates/`, so an edited file is not a removal, but a new part file needs `featureSurface.cjs --write`).

## 3. Python (`backend/src`, 22 files, 3,318 lines)

Floor: **Python 3.7** (`backend/ruff.toml` `target-version = "py37"`; `venvManager.ts` asks users for "Python 3.7+"). Numbers from `grep` and `ruff 0.16.9`; the pinned version is 0.17.6 (`backend/requirements-dev.txt`), so re-run with it before acting.

| Idiom | Count | Top files | Modern replacement | Risk | Lock-in |
|---|---:|---|---|---|---|
| `"…" % x` / `"…".format()` | **0** / **0** (the 2 `%` hits are `time.strftime` patterns) | — | f-strings (55 already) | — | ruff `UP031`, `UP032` |
| bare `except:` | **0** (12 `except Exception`, which are fine) | — | — | — | ruff `E722` |
| `class X(object)` | **0** | — | — | — | ruff `UP004` |
| `super(X, self)` | **0** | — | — | — | ruff `UP008` |
| `typing.List/Dict/Tuple/Set/Optional/Union` in annotations | 310 occurrences in 13 files (ruff `FA100`: 309) | `utils/dependency_analysis_engine.py` (101 lines carry one), `tools/class_counter_analyzer.py` 26, `tools/lizard_analyzer.py` 10, `utils/directory_scan_utils.py` 9 | add `from __future__ import annotations`, then `list[str]`, `dict[str, Any]`, `X \| None` **in annotations** | Low: with PEP 563 annotations are never evaluated, and nothing calls `typing.get_type_hints()` (0 uses). **One runtime alias must keep `typing`**: `TargetTuple = Tuple[str, str, str]` (`utils/dependency_analysis_engine.py:719`) is evaluated at import, and `tuple[...]` would be a `TypeError` on 3.7/3.8 | ruff `FA100` (require the future import wherever old generics remain) and `UP006`/`UP007`/`UP035` (check with the pinned ruff that they fire under `py37` once the future import is present). Do not raise `target-version` |
| `os.path.*` | 50 calls in 17 files; `pathlib` already in 10 files | `utils/dependency_analysis_engine.py` 17 lines, `utils/directory_scan_utils.py` 7, `utils/file_analysis_engine.py` 4 | `pathlib.Path` | **Leave**: `Path` objects would flow into JSON output and subprocess arguments where strings are expected, the Windows path text is part of what tests compare, and the gain is readability only. Convert a function when it is rewritten for another reason | none (`PTH` rules would force a sweep) |
| small pyupgrade items | `RUF010` 6 (`str()` inside f-strings), `UP015` 5 (redundant `open(…, 'r')`), `UP012` 1 (`.encode('utf-8')`) | — | ruff's fixes | Low | add the three codes to `select` |
| `contextlib.suppress` (`SIM105`) | 2 | — | — | Stylistic: leave | — |

**Files the Python sweep must not touch:**

- `utils/xr_field_schema.py`, the XR field-schema contract. A test regex-matches its `_text_field(…)` / `_numeric_field(…)` call syntax, and the cleanup skill §4 puts the whole file off-limits.
- `main.py`'s import block, whose lines and order tests pin. Adding the future import there changes that block. `main.py` has no old generics anyway.
- `utils/metric_language_contract.py`. `test/baseline/featureSurface.cjs` and the language contract tests read it as text. Annotation-only edits are allowed after checking those patterns.

## 4. Leave alone (load-bearing, contract or pinned)

| What | Where | Why |
|---|---|---|
| 8 lazy `require()` | `src/views/ModularTreeDataProvider.ts` | cleanup skill §4: load-bearing. They survived #40 (PR #57) |
| 2 lazy relative `require()` | `directoryReAnalyzer.ts`, `getVisualizationConfiguration.ts` | break load-time cycles; revisit only after #42 removes the cycles |
| `HttpServer.stop()` statement order | `src/servers/runtime/httpServer.ts` | shipped deadlock fix (§4 of the skill). Idiom edits must not reorder it |
| `executePython.ts`, `exportManifest.ts`, settings storage | `src/code_analysis/…` | #35 rewrites them. Modernize inside #35, not before it |
| `ModularTreeDataProvider.ts`, scene-asset files | `src/views/`, `src/code_analysis/engine/components/customComponents/` | #40 (PR #57) just rewrote them; let them settle. The tree provider is down to 5 `any` |
| XR field-schema contract, `build_complexity_band`, `summarize_function_metrics` | `backend/src/utils/xr_field_schema.py`, `xrFieldSchemaService.ts` | contract (skill §4) |
| IIFE/UMD wrappers, part boundaries, `manifest.json` order | `templates/components/**` | load order and Node-require tests (`COMPONENTS.md`) |
| Generated text | `templateHTMLProcessor.ts`, `createStructure.ts`, `createChart.ts`, LivePanel HTML builders | the HTML they produce is compared as text. A concatenation → template change must keep every byte, whitespace included |
| `enum ErrorDomain` / `ErrorSeverity`, `new Promise` around events, sync `fs` in async functions, `os.path` | §1, §3 | no clear benefit, or a behaviour change |

## 5. Proposed commit plan

One idiom × one area per commit, in this order (value ÷ risk). Each commit lists the idiom's count before and after in its body, runs the gates of the touched area, and adds its lock-in rule in the **same** commit, so the count can only go down. With `npm run guardrails:update`, the `eslint.maxWarnings` budget goes down whenever warnings disappear.

| # | Commit | Area | Count | Proof | Gates |
|---|---|---|---:|---|---|
| 1 | `chore(lint): lock the idioms already at zero` (`no-var`, `prefer-rest-params`, `no-namespace`, `no-unsafe-function-type` for `src/`; ruff `E722`, `UP004`, `UP008`, `UP031`, `UP032`) | config only | 0 → 0 | lint green, no source diff | `npm run lint`, `npm run lint:python` |
| 2 | `refactor(python): builtin generics in annotations` | `backend/src`, 12 files (`xr_field_schema.py` excluded) | 310 → 10 (`TargetTuple` and the 9 in `xr_field_schema.py` remain) | annotations only (`python -m compileall` on 3.7 if available, ruff `FA100` count) | `npm run test:python`, `npm run test:analysis`, `npm run lint:python` |
| 3 | `refactor(python): ruff pyupgrade leftovers` (`RUF010`, `UP015`, `UP012`) | `backend/src` | 12 → 0 | ruff, and identical analyzer output on `test:analysis` | same |
| 4 | `refactor(ts): static imports for Node built-ins` | 3 files (not `executePython.ts`) | 7 → 0 (8 left to #35) | H2: the bundle changes only where the `require` moves to the module top | `npm test` |
| 5 | `refactor(ts): includes() and slice()` | 3 files | 3 → 0 (the 3 in `executePython.ts` are left to #35) | H2 | `npm test` |
| 6 | `refactor(ts): optional chaining where it is safe` | 5 files | 11 → 0 | rule-driven; H2 | `npm test` |
| 7 | `refactor(ts): template literals` | 15 files (generated-HTML builders last, against goldens) | 24 → 0 | H2 | `npm test`, XR harness when a template builder is touched |
| 8 | `refactor(ts): type the any in <folder>` (one folder per commit; start with `code_analysis/historical`, `export`, `servers/runtime`) | per folder | 166 → … | types only: H1 identical bundle | `npm test`, `npm run typecheck` |
| 9 | `refactor(ts): ?? for object-typed defaults` | as reported by the typed rule with `ignorePrimitives` | measure first | H2; each changed line reviewed for falsy values | `npm test` + characterization for any setting reader |
| 10 | `refactor(ts): await instead of then() where the promise is awaited` | ≤ 15 files | ≤ 24 | H2, ordering reviewed | `npm test` |
| 11 | `refactor(runtime): const/let in <runtime>` (one standalone runtime per commit) | 5 standalone runtimes | 289 → 0 | `no-var` fixer + manual; harness | `test:xr-harness`, the runtime's unit suite, `runtimeAssemblyParity` |
| 12 | `refactor(runtime): Array.from / rest parameters` | 3 runtimes | 14 → 0 | harness | same |

Deferred to 1.3.0 (record in the session log, do not open in 1.2.1): `var` in the 9 multi-part runtimes (2,014), string concatenation in templates (611), `fs.promises` for the 109 sync calls (only with a measured hot path).

## 6. Progress (Python and browser runtimes)

Landed on `claude/project-thread-n2s3q6-modernize-py-js` (session log `.claude/docs/v1.2.1/sessions/56a-modernize-py-js.md`). The TypeScript rows of §5 are not part of it. Counts are measured with ruff 0.17.6 (`backend/`) and the A.2 script (`apps/vscode-extension/`).

| Plan row | Idiom × area | Before | After | Lock-in |
|---|---|---:|---:|---|
| 1 (Python part) | bare `except:`, `class X(object)`, `super(X, self)`, `%` and `.format()` in `backend/` | 0 | 0 | ruff `E722`, `UP004`, `UP008`, `UP031`, `UP032` in `backend/ruff.toml` |
| 2 | `typing.List/Dict/Tuple/Set/Optional` in `backend/src` (A.3 grep; ruff `FA100`) | 310 (FA100 309) in 13 files | 12 (FA100 11) in 3 files | ruff `FA100`, `UP006`, `UP007`, `UP037`, `UP045`; `FA100` ignored per file for the two exceptions |
| 3 | `RUF010` `str()` in f-strings, `UP015` `open(…, 'r')`, `UP012` `.encode('utf-8')` in `backend/src` | 6 + 5 + 1 = 12 | 0 | ruff `RUF010`, `UP015`, `UP012` |
| 11 | `var` in the 5 standalone runtimes (A.2 script) | 289 (2,303 in all 14 units) | **0** (2,014, all in the 9 multi-part runtimes): `dependencyVisualBudgetRuntime.js` 22, `renderBudgetRuntime.js` 26, `codexrDebugRuntime.js` 37, `codexrCommonRuntime.js` 84, `codexrGitRefPickerRuntime.js` 120 → 0 | ESLint `prefer-const` per converted file, and `no-var` for every linted template script (`apps/vscode-extension/eslint.config.mjs`; all 0) |

Row 2 leaves exactly three places on `typing` generics: `TargetTuple` (a runtime alias, see §3), `utils/xr_field_schema.py` (contract, 9) and `html/html_dom_parser.py` (2), whose `def emit_json_result(result: Dict[str, Any]) -> None:` line `livePanelDomIntegration.test.cjs` pins verbatim (an S pin: relaxing it needs its own characterization commit first, so the file was left whole rather than half-converted).

## Appendix: how to re-run the numbers

From the repository root, after `npm ci` (the scripts resolve `typescript` and `acorn` from the workspace). Copy each script to a scratch folder first: they are kept here, not in `scripts/`, because only #56 needs them.

### A.1 TypeScript idioms (AST)

`node ts-idioms.cjs apps/vscode-extension --files`

```js
// node ts-idioms.cjs <extRoot> [--files]  — counts outdated TypeScript idioms in src/ with the TS AST.
// Run from the repo root after `npm ci` (uses the workspace's typescript). Read-only.
const fs = require('fs'); const path = require('path');
const root = path.resolve(process.argv[2]);
const ts = require(require.resolve('typescript', { paths: [root, process.cwd()] }));
const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p); } })(path.join(root, 'src'));
const K = ts.SyntaxKind; const totals = {}; const byFile = {};
const hit = (id, f) => { totals[id] = (totals[id] || 0) + 1; (byFile[id] ??= {})[f] = (byFile[id][f] || 0) + 1; };
const isStr = n => n && (n.kind === K.StringLiteral || n.kind === K.NoSubstitutionTemplateLiteral || n.kind === K.TemplateExpression);
for (const abs of files) {
  const f = path.relative(root, abs).split(path.sep).join('/'); const text = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2022, true);
  const lazyTree = f.endsWith('views/ModularTreeDataProvider.ts');
  (function visit(n, inAsync) {
    switch (n.kind) {
      case K.VariableDeclarationList: if (!(n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) hit('var', f); break;
      case K.ModuleDeclaration: if (!(n.flags & ts.NodeFlags.GlobalAugmentation) && n.name.kind === K.Identifier) hit('namespace', f); break;
      case K.EnumDeclaration: hit('enum', f); break;
      case K.AnyKeyword: hit('any', f); break;
      case K.AsExpression: if (n.type.kind === K.AnyKeyword) hit('as any', f); break;
      case K.TypeReference: if (n.typeName.getText(sf) === 'Function') hit('Function type', f); break;
      case K.CallExpression: {
        const c = n.expression.getText(sf);
        if (c === 'require' && !(lazyTree)) hit(n.arguments[0] && /^['"]\./.test(n.arguments[0].getText(sf)) ? 'require (relative)' : 'require (package)', f);
        if (n.expression.kind === K.PropertyAccessExpression && n.expression.name.text === 'then') hit('.then()', f);
        if (n.expression.kind === K.PropertyAccessExpression && n.expression.name.text === 'catch' && n.expression.expression.kind === K.CallExpression) hit('.catch() on a call', f);
        if (/^fs\.\w+Sync$/.test(c) && inAsync) hit('fs.*Sync inside async fn', f);
        if (/^(fs|child_process|cp)\.(readFile|writeFile|readdir|stat|access|mkdir|unlink|rm|exec|execFile)$/.test(c) && n.arguments.some(a => a.kind === K.ArrowFunction || a.kind === K.FunctionExpression)) hit('callback-style fs/child_process', f);
        if (n.expression.kind === K.PropertyAccessExpression && n.expression.name.text === 'indexOf' && n.parent.kind === K.BinaryExpression) hit('indexOf() compare (-> includes)', f);
        if (n.expression.kind === K.PropertyAccessExpression && n.expression.name.text === 'substr') hit('substr()', f);
        if (/\.hasOwnProperty$/.test(c)) hit('hasOwnProperty', f);
        if (n.expression.kind === K.PropertyAccessExpression && n.expression.name.text === 'apply' && n.arguments.length === 2) hit('fn.apply(this, args)', f);
        break; }
      case K.NewExpression: if (n.expression.getText(sf) === 'Promise') hit('new Promise(...)', f); break;
      case K.BinaryExpression: {
        const op = n.operatorToken.kind;
        if (op === K.PlusToken && (isStr(n.left) || isStr(n.right)) && n.parent.kind !== K.BinaryExpression) hit('string concatenation (+ with a string literal)', f);
        if (op === K.AmpersandAmpersandToken && n.right.kind === K.PropertyAccessExpression || op === K.AmpersandAmpersandToken && n.right.kind === K.CallExpression) {
          const l = n.left.getText(sf); const r = n.right.getText(sf); if (r.startsWith(l + '.') || r.startsWith(l + '[')) hit('a && a.b (-> a?.b)', f); }
        if (op === K.BarBarToken && (n.right.kind === K.StringLiteral || n.right.kind === K.NumericLiteral || n.right.kind === K.FalseKeyword || n.right.kind === K.TrueKeyword)) hit('x || literal (?? candidate, review falsy)', f);
        break; }
      case K.ConditionalExpression: {
        const c = n.condition.getText(sf).replace(/\s*(!==?|===?)\s*(undefined|null)$/, '');
        if (n.whenTrue.getText(sf) === c && /(!==?)\s*(undefined|null)$/.test(n.condition.getText(sf))) hit('x != null ? x : d (-> ??)', f);
        break; }
      case K.ForStatement: {
        const init = n.initializer && n.initializer.getText(sf); const body = n.statement.getText(sf);
        const m = init && init.match(/^(?:let|var)\s+(\w+)\s*=\s*0$/); if (m && n.condition && /\.length$/.test(n.condition.getText(sf))) { const arr = n.condition.getText(sf).split(/\s*<\s*/)[1].replace(/\.length$/, ''); const uses = body.split(`${arr}[${m[1]}]`).length - 1; const other = body.split(m[1]).length - 1 - uses; if (uses > 0 && other === 0) hit('index for-loop (-> for...of)', f); else hit('index for-loop (index used)', f); }
        break; }
      case K.Parameter: if (n.dotDotDotToken === undefined && n.name.getText(sf) === 'arguments') hit('arguments', f); break;
      case K.Identifier: if (n.text === 'arguments' && ![K.Parameter, K.PropertyAccessExpression, K.PropertyAssignment, K.ShorthandPropertyAssignment, K.PropertySignature, K.PropertyDeclaration].includes(n.parent.kind)) hit('arguments object', f); break;
    }
    const async = (ts.isFunctionLike(n) ? !!(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Async) : inAsync);
    ts.forEachChild(n, c => visit(c, async));
  })(sf, false);
}
for (const [id, n] of Object.entries(totals).sort()) {
  const top = Object.entries(byFile[id]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([f, c]) => `${f.replace('src/', '')} ${c}`).join('; ');
  console.log(`${id}\t${n}\t${Object.keys(byFile[id]).length} files\t${process.argv.includes('--files') ? top : ''}`);
}
```

### A.2 Browser JavaScript idioms (acorn, multi-part runtimes assembled)

`node js-idioms.cjs apps/vscode-extension --files`

```js
// node js-idioms.cjs <extRoot> [--files] — counts old idioms in the browser runtimes under templates/.
// Multi-part runtimes are assembled from their manifest.json first (parts are not parseable alone).
// Uses the workspace's acorn (a webpack dependency). Read-only.
const fs = require('fs'); const path = require('path');
const root = path.resolve(process.argv[2]); const req = m => require(require.resolve(m, { paths: [root, process.cwd()] }));
const acorn = req('acorn');
const walk = { full(node, cb) { (function v(n) { if (!n || typeof n.type !== 'string') return; cb(n); for (const k of Object.keys(n)) { const c = n[k]; if (Array.isArray(c)) c.forEach(v); else if (c && typeof c === 'object' && typeof c.type === 'string') v(c); } })(node); } };
const units = []; const partDirs = new Set();
(function scan(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const m = path.join(p, 'manifest.json'); if (fs.existsSync(m)) { const man = JSON.parse(fs.readFileSync(m, 'utf8')); partDirs.add(p); units.push({ name: path.relative(root, path.join(d, man.output)), text: man.parts.map(x => fs.readFileSync(path.join(p, x), 'utf8')).join('\n') }); } else scan(p); } else if (p.endsWith('.js') && ![...partDirs].some(x => p.startsWith(x))) units.push({ name: path.relative(root, p), text: fs.readFileSync(p, 'utf8') }); } })(path.join(root, 'templates'));
const totals = {}; const byFile = {}; const hit = (id, f) => { totals[id] = (totals[id] || 0) + 1; (byFile[id] ??= {})[f] = (byFile[id][f] || 0) + 1; };
const DOMLIST = /querySelectorAll|getElementsBy|childNodes|children|\.attributes/;
let lines = 0;
for (const { name, text } of units) {
  lines += text.split('\n').length; let ast;
  try { ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); } catch (e) { hit('UNPARSEABLE', name); continue; }
  for (const st of ast.body) { const ex = st.type === 'ExpressionStatement' ? st.expression : null; const call = ex && (ex.type === 'UnaryExpression' ? ex.argument : ex); if (call && call.type === 'CallExpression' && /Function/.test((call.callee.type === 'MemberExpression' ? call.callee.object : call.callee).type)) hit('top-level IIFE wrapper', name); }
  walk.full(ast, n => {
    if (n.type === 'VariableDeclaration') hit(n.kind === 'var' ? 'var' : 'let/const (already modern)', name);
    if (n.type === 'ArrowFunctionExpression') hit('arrow fn (already modern)', name);
    if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') hit('class (already modern)', name);
    if (n.type === 'ChainExpression') hit('optional chaining (already modern)', name);
    if (n.type === 'TemplateLiteral') hit('template literal (already modern)', name);
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.type === 'MemberExpression' && n.left.object.property.name === 'prototype') hit('X.prototype.m = (prototype class)', name);
    if (n.type === 'Identifier' && n.name === 'arguments') hit('arguments', name);
    if ((n.type === 'VariableDeclarator' && n.init && n.init.type === 'ThisExpression') || (n.type === 'AssignmentExpression' && n.right.type === 'ThisExpression' && n.left.type === 'Identifier')) hit('self = this', name);
    if (n.type === 'ForStatement' && n.test && n.test.type === 'BinaryExpression' && n.test.right.type === 'MemberExpression' && n.test.right.property.name === 'length') hit(DOMLIST.test(text.slice(n.test.right.start, n.test.right.end)) ? 'index loop over a DOM list' : 'index for-loop', name);
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'call' && n.callee.object.type === 'MemberExpression' && /slice|forEach|map|filter/.test(n.callee.object.property.name || '')) hit('[].slice/forEach.call(list)', name);
    if (n.type === 'BinaryExpression' && n.operator === '+' && [n.left, n.right].some(s => s.type === 'Literal' && typeof s.value === 'string')) hit('string + concatenation', name);
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'bind' && n.callee.object.type === 'FunctionExpression') hit('function(){}.bind(this)', name);
    if (n.type === 'NewExpression' && n.callee.name === 'XMLHttpRequest') hit('XMLHttpRequest', name);
  });
}
console.log(`${units.length} runtime units (multi-part assembled), ${lines} lines`);
for (const [id, n] of Object.entries(totals).sort()) { const top = Object.entries(byFile[id]).sort((a, b) => b[1] - a[1]).slice(0, process.argv.includes('--all') ? 99 : 3).map(([f, c]) => `${f.replace('templates/', '')} ${c}`).join('; '); console.log(`${id}\t${n}\t${Object.keys(byFile[id]).length} files\t${process.argv.includes('--files') ? top : ''}`); }
```

### A.3 Python

```bash
cd backend/src
grep -rnE '\.format\(' --include=*.py . | wc -l                                   # 0
grep -rnE "['\"]\s*%\s*[\(a-zA-Z_]" --include=*.py .                               # 2, both strftime
grep -rnoE '\b(List|Dict|Tuple|Set|Optional|Union|Type|FrozenSet)\[' --include=*.py . | wc -l   # 310
grep -rnoE 'os\.path\.\w+' --include=*.py . | wc -l                                # 50
grep -rnE '^\s*except\s*:' --include=*.py . | wc -l                                # 0
grep -rnE 'class \w+\(object\)' --include=*.py . | wc -l                           # 0
grep -rnE '^[A-Za-z_]+\s*=\s*(List|Dict|Tuple|Optional|Union)\[' --include=*.py .  # the runtime aliases (1)
cd .. && ruff check src --config ruff.toml --select UP,E722,PTH,FA,SIM105,RUF010 \
  --target-version py37 --statistics --no-cache --exit-zero
```
