# Code-XR Development Workflow

> **Purpose**: Build, test, run and package the extension. Read this before running any command or claiming a change "works".
> **Stability**: Stable — update when scripts, launch configs, or test layers change.
> Verified against `package.json`, `.vscode/launch.json`, `.vscode/tasks.json` and `test/runners/` on 2026-07-08; scripts, paths and the test layout re-verified on 2026-11-25 (story #43).

> **Monorepo (2026-11-25):** run `npm ci` and every `npm run …` from the repository root; scripts delegate to the `code-xr` workspace in `apps/vscode-extension/`, where the paths below live (the Python backend is `backend/src/`, its tests `backend/tests/`). See `docs/monorepo.md`.

## Environment

- **Platform**: developed on Windows 11; npm scripts deliberately call tool binaries via `node ./node_modules/<tool>/bin/...` instead of bare CLI names (Windows robustness). Keep that style when adding scripts.
- **Requirements**: VS Code ≥ 1.98.0, **Node.js 24** (pinned in `.nvmrc`, which CI reads; the unit runner passes `--test-isolation=none`, which older Node versions do not have), Python 3.7+ (the extension creates and manages its own venv — see `PYTHON_ANALYSIS.md`).
- **Git**: work happens on branch `v1.2.1`; `master` is the default/PR target. Expect CRLF warnings from git on this machine — they are noise, but be aware `git status` may list files whose only difference is line endings.

## npm scripts

| Script | What it does | When to use |
|---|---|---|
| `npm run compile` | webpack build → `dist/extension.js` (+ CopyPlugin copies `<repo>/backend/src` into `dist/code_analysis/python`; `templates/` and `examples/` ship as they are, not copied, since 1.2.1) | Before F5 "workspace direct"; quick build check |
| `npm run compile:dev-host` | `compile` + `scripts/prepare-dev-extension.mjs` → stages an isolated dev copy under `.vscode-test/dev-extension` | Used automatically by the primary F5 launch config |
| `npm run watch` | webpack watch mode | Iterating on TS changes |
| `npm run typecheck` | `tsc --noEmit` (non-incremental) over the whole project with `tsconfig.check.json`, which extends `tsconfig.json` and adds `noUnusedLocals`, `noFallthroughCasesInSwitch`, `noImplicitReturns` and `noUnusedParameters` (an unused parameter kept for a signature is named `_x`). `compile`, `compile-tests` and webpack stay on `tsconfig.json`, so an unused symbol fails the gate but never the F5 build. Then a second pass, `tsconfig.tooling.json`: `checkJs` over `scripts/*.mjs`, `webpack.config.js` and `eslint.config.mjs` (strict except `noImplicitAny`; a JSDoc `@type` is the fix for a finding there) | Fast correctness gate; part of `test:basic` |
| `npm run lint` | ESLint (flat config, `eslint.config.mjs`) over explicit roots — `src/`, `test/`, `scripts/`, `templates/`, `webpack.config.js`, `eslint.config.mjs` — with a `--max-warnings` budget (the number in the script). The roots are listed rather than `eslint .`, so the scope is reviewable in the diff | Part of `test:basic` (~7 s: the type-aware block builds the TypeScript program). Style and unused-symbol rules are errors (Node-side JS also gets `no-undef` and `no-eval`). The standalone `templates/` runtimes get a relaxed browser block (classic scripts: top-level names are page globals, `== null` is allowed; the LivePanel page's shared globals are listed in the config); the multi-part runtime directories (`templates/components/codexr/*/*Runtime/`) are ignored, because a part does not parse on its own; `no-console` is an error over `src/**/*.ts` with the log sink (`src/platform/logging/sink.ts`) as the only allowlisted file (extension diagnostics go through the logger, see ARCHITECTURE.md "Logging"); the warn-only budget rules, all on `src/` (`no-explicit-any`; `complexity` 15, `max-depth` 4, `max-params` 5, `max-lines-per-function` 80, `max-lines` 600; type-aware `no-misused-promises`), count toward the budget, which is recorded in the guardrail baseline (`eslint.maxWarnings`) and only ever lowered: when a cleanup removes warnings, lower the number in the script and run `guardrails:update`. The type-aware `no-floating-promises` (with `checkThenables`) is an **error** since v1.2.1 T56-T59: await the promise, or mark a deliberate fire-and-forget with `void` |
| `npm run compile-tests` | Removes `out/`, then `tsc -p . --outDir out`. Starting empty matters: tsc never deletes output for a source that is gone, so a module deleted from `src/` would keep a compiled twin the suites still load | Part of `test:basic` |
| `npm run watch-tests` | `tsc -p . -w --outDir out`: keeps `out/` current while iterating on tests (the runner's stale-output check is per file, so this stays valid) | Iterating with `npm run test:unit` |
| `npm test` = `npm run test:basic` | `typecheck` + `lint` + `compile-tests` (tsc → `out/`) + `test:unit`. Needs **no** webpack build. At the root it then runs `ide:test` | **The default gate. Run before declaring any change done.** |
| `npm run ide:test` / `ide:dev` / `ide:build` / `ide:start` / `ide:smoke` (root only; workspace `code-xr-ide`) | The Code-XR IDE (`apps/ide`, epic #11). `ide:test`: `tsc` over `tsconfig.node.json` and `tsconfig.web.json` + ESLint with `--max-warnings 0` + `node --test` over `apps/ide/test/**/*.test.ts` (Node's type stripping, no compile step); the root `npm test` runs it after the extension gate. `ide:dev`: Vite dev server + Electron restart on main/preload changes. `ide:smoke`: build, launch hidden with `--codexr-smoke`, assert the security baseline from inside the real window (CI job `ide-smoke` on the three OSes; Linux needs `xvfb-run -a`). Details: `apps/ide/README.md` | After touching `apps/ide/` |
| `npm run test:unit` | `test/runners/run-node-tests.cjs` → first refuses to start if `out/` does not match `src/` (a source newer than its output, an uncompiled source, or a compiled file whose source is gone), then collects `test/**/*.test.cjs` and runs `node --test --test-isolation=none --test-concurrency=1` — **every suite in one process**, so a test must never leave global state behind | Unit/runtime tests only (fast) |
| `npm run test:python` (root `test:backend` runs the same file directly) | `backend/scripts/run-python-tests.cjs` → `unittest discover` over `backend/tests/`. A test folder **needs an `__init__.py`** or discovery skips it silently. With no interpreter it skips locally and **fails under `CI`** | After touching `backend/src/` |
| `npm run lint:python` (root only) | `backend/scripts/run-ruff.cjs` → `ruff check` in `backend/` with `backend/ruff.toml`: pyflakes (`F`) plus the pycodestyle error classes `E4`/`E7`/`E9` and the modernization lock-ins of story #56 (`E722`, `UP004`, `UP008`, `UP031`, `UP032`, and `FA100`/`UP006`/`UP007`/`UP037`/`UP045`: builtin generics in annotations behind `from __future__ import annotations`, and `UP012`/`UP015`/`RUF010`; `docs/cleanup/modernization.md`), target Python 3.7, fixture corpora (`manual_test/`, `tests/fixtures/`) excluded, `E402` ignored per file (with the reason) where a module bootstraps `sys.path` before its imports. **Lint only — no formatter, no isort**: tests pin import lines and statement order. Ruff is pinned in `backend/requirements-dev.txt` (`python -m pip install -r backend/requirements-dev.txt`); a missing ruff is a failure, never a skip | After touching `backend/` |
| `npm run test:all` | `test:basic` + `test:python` | Pre-release / after cross-language changes |
| `npm run test:analysis` | `backend/scripts/run-analysis-tests.cjs` (venv in `backend/artifacts/analysis-test-venv`) over the `backend/manual_test/` fixtures (one per supported language); asserts XR and LivePanel produce the same `data.json`. Its venv installs the **lizard version the extension pins** (read from `backend/requirements.txt`, the generated mirror of `pythonPackageManifest.ts`) | After changing analysis output or language support |
| `npm run test:htmlanalysis` | `test/runners/run-html-analysis-tests.cjs`: `test/analysis/livePanelDomIntegration.test.cjs` plus the Python suite `backend/tests/html_dom/` | After touching `backend/src/html/html_dom_parser.py` or DOM mode |
| `npm run test:xr-harness` | `test/runners/run-xr-containment-harness.cjs` (browser harness, uses Playwright) | After touching table/containment runtimes |
| `npm run test:xr-chart-bounds-harness` | `test/runners/run-xr-chart-bounds-harness.cjs` (generates REAL directory scenes with the compiled generator, opens them with A-Frame + BabiaXR in Playwright, asserts every chart type ends on the table for 3/30/300 files and that row-budgeted charts only ever read the slice; `CODEXR_CHART_BOUNDS_TYPES` / `CODEXR_CHART_BOUNDS_ROWS` narrow it; about 4 minutes) | After touching chart generation, containment, the row slice or the Babia compatibility patches |
| `npm run test:xr-mode-harness` | `test/runners/run-xr-mode-cycle-harness.cjs` — static contract over `test/manual/xr-mode-cycle-harness.html`, then (with Playwright) walks the analysis selector through every mode and back, asserting the controller's view/mode state at each step. Then four dependency-graph scenarios (DEPGRAPH-12): drill-down plus late-joiner reload, a 900-node project past the render budget, worker balance over three enter/leave cycles, and entering while a refresh runs; a scenario sets the room entity with `window.__DEP_STATE` and reads the page's requests from `CodeXRHarness.sent`. Served over HTTP (`test/helpers/staticHttpServer.cjs`), so the modes' datasets really load; from `file://` Chromium blocked every fetch | After touching the analysis-mode controller, mapping UI, historical comparison or dependency graph runtimes |
| `npm run test:project-evolution-harness` | `test/runners/run-project-evolution-harness.cjs` — Project Evolution playback harness (screenshots under `output/project-evolution-harness/`) | After touching project-evolution runtime |
| `npm run test:xr-immersive-harness` | `test/runners/run-xr-immersive-harness.cjs` — AR/VR semantics against real A-Frame: AR hide/keep sets, rig floor-align + AR recenter, pointer handover; plus a static contract over both scene templates | After touching the scene templates, pointer-policy or immersive-rig |
| `npm run test:harnesses` | The five browser harnesses in a row (`test:xr-harness`, `test:xr-chart-bounds-harness`, `test:xr-mode-harness`, `test:xr-immersive-harness`, `test:project-evolution-harness`). Offline: `test/helpers/harnessBrowser.cjs` serves the CDN scene libraries from `test/vendor/scene-libraries/` (byte-identical releases with their licences) and aborts every other non-local request, so a harness never depends on a CDN being up. Needs Playwright's Chromium (`npx playwright install chromium`) | After touching any scene runtime; CI runs it in the `harnesses` job on Ubuntu |
| `npm run package` | Production webpack build (hidden source maps) | Pre-packaging |
| `npm run package:vsix` | `package` + `scripts/package-vsix.mjs` → builds the `.vsix` (refuses to package without `dist/extension.js`) | Release preparation |
| `node scripts/dist-fingerprint.mjs --out <file>` · `node scripts/dist-diff.mjs <before> <after> --expect-identical-bundle` | Hash everything under `dist/` and compare two fingerprints. **H1**: an unreachable file was deleted ⇒ `extension.js` byte-identical (the production build is deterministic). `--allow-removed <path|dir/>` names copied assets that are meant to disappear. **H2**: `--bundle-lines <old> <new>` for a dead declaration removed from a live file | Proving a cleanup commit changed nothing that ships (`cleanup` skill §3) |
| `node scripts/vsix-listing.mjs [--vsix <file>] [--out <listing.txt>]` | Reads the built VSIX's zip directory (Node builtins) and checks it: required entries (`dist/extension.js`, the Python `main.py`, `templates/`, `examples/`, the icon, README/CHANGELOG/LICENSE) present; source maps, TypeScript sources, Python bytecode, build configs, `src/`/`test/`/`node_modules/`… absent. Exits 1 on any violation | After `npm run package:vsix`; CI runs it in the package job |
| `npm run report:manual-metrics` | analysis test runner in report-only mode | Metric reports without assertions |
| `npm run guardrails:measure` | `test/tooling/measureGuardrails.cjs` — prints the cleanup metrics from the TypeScript AST (~2 s): `console.*` per module, console-only catch blocks, `any`, suppressions, files over 500 lines, functions over 80 lines, CCN over 10/15/20/30, modules unreachable from `src/extension.ts`, `console.log` in `templates/`, the lint `--max-warnings` | Before and after any cleanup item |
| `npm run guardrails:update` | Same script with `--write`: regenerates `test/tooling/guardrail-baseline.json`. For a commit that moves files, pass the move map: `npm run guardrails:update -- --renamed ../../docs/cleanup/src-move-map.json` re-keys the committed baseline through it (paths at their new location, per-module counts regrouped from the per-file ones), so a pure move reports no change and needs no waiver. `console.byModule` / `any.byModule` group by the first folder under `src/`, or the first two under `src/core/` and `src/features/` | In the **same commit** as a change that moves a metric — the baseline diff is that item's recorded before/after |
| `npm run python:requirements` | `compile-tests` + `test/tooling/pythonRequirements.cjs --write`: regenerates `backend/requirements.txt` from `CODEXR_PYTHON_PACKAGES` in `src/core/python-env/pythonPackageManifest.ts` (the source of truth); `test/python_env/pythonRequirements.test.cjs` fails while the two disagree | In the same commit as any change to the Python package pins |

**Test framework note**: unit tests are **`.test.cjs` files run by Node's native test runner** (`node --test`), *not* Mocha (there is no Mocha in the dependency tree). New unit tests go in `test/<area>/*.test.cjs`.

## Running the extension (F5)

Two launch configs in `.vscode/launch.json`:

1. **"Run CodeXR Extension"** (primary): launches an Extension Development Host with an **isolated copy** of the extension staged under `.vscode-test/dev-extension`, with separate user-data and extensions dirs. preLaunchTask: `CodeXR: compile:dev-host`. Use this for realistic, isolated testing.
2. **"Run CodeXR Extension (workspace direct)"**: loads `${workspaceFolder}` directly as the extension. preLaunchTask: `CodeXR: compile`. Faster, less isolated.

Manual validation flow for a change: F5 → open a workspace with source files → right-click a file/folder → "Code-XR: Analysis" submenu → run the relevant mode (LivePanel / XR / DOM) → for XR, the browser opens the generated scene from a local server; check the Active Servers tree section. Debug APIs available in the browser console are documented in `docs/xr-testing/XR_DEBUG_COMMANDS.md`.

## Test layout

```
test/
├── analysis/            80 .test.cjs suites — runtimes (common, boats, charts, tables, mapping),
│                        collaboration, historical, dependency graph, export, watchers…
├── commands/            commandRegistry.test.cjs (unique-ID checks on synthetic arrays) +
│                        commandContributions.test.cjs: executes the REAL registerAllCommands under the
│                        fake vscode and ties it to package.json; internalCommandIds.cjs lists every
│                        registered-but-uncontributed command with how it is reached
├── directory_analysis/  directory-mode tests
├── logging/, python_env/, servers/, startup/, collaboration/, packaging/, utils/, views/,
│   visualize_data/, visualization_settings/   focused suites per subsystem
│                        (126 .test.cjs files in all, 1,064 tests at the end of 1.2.1)
├── helpers/             sourceText.cjs (LF readers, assertAbsent with a mandatory canary),
│                        fakeVscode.cjs (scoped fake `vscode` to EXECUTE out/ modules),
│                        runtimeAssembly.cjs (test-side mirror of the runtime assembler),
│                        logCapture.cjs, templatesRoot.cjs, sceneAssetModules.cjs
├── baseline/            the feature baseline of the cleanup epic: snapshot of the user-visible
│                        surface + the register of authorized removals (featureSurface.cjs --write)
├── tooling/             measureGuardrails.cjs + guardrail-baseline.json + the ratchet test;
│                        lintContract (what lint/typecheck cover and how strict), npmScripts
│                        (every script target exists; every test:* script is documented here),
│                        dependencyDirection (the folder import matrix and its two-way pairs,
│                        data in folderDependencies.json; `node test/tooling/folderDependencies.cjs`),
│                        srcLayout (src/ = five layers + extension.ts, kebab-case folders, no barrels)
├── manual/              browser-run HTML harnesses (xr-containment, project-evolution-playback…)
└── runners/             the .cjs runner scripts npm scripts point to (the two Python-only ones,
                         run-python-tests and run-analysis-tests, are in backend/scripts/)
```

The Python `unittest` suites (dependencies + goldens, analyzers, scanning, html_dom, xr schema…; `backend_sandbox.py` scopes a fake lizard to one module) live in `backend/tests/`, and the dependency-graph sample sources (~25 languages) with them: `backend/tests/fixtures/dependency-languages/`.

Also `backend/manual_test/`: per-language fixtures consumed by `npm run test:analysis` (see `backend/manual_test/README.md`); that runner drives `backend/tests/manual_metrics_suite.py` and `backend/scripts/report-manual-metrics.py` (reports land in `backend/artifacts/manual_test_reports/`).

## Packaging

- Bundler: **webpack** (`webpack.config.js`), target node, entry `src/extension.ts` → `dist/extension.js` (commonjs2, `clean: true`), `vscode` external.
- **No `.vscodeignore`** — VSIX contents are controlled by the `files` allowlist in package.json: `dist/**`, selected `resources/`, README/LICENSE/notices/CHANGELOG, `templates/**`, `examples/**`. `.claude/` is **not** in the list and never ships; neither does `docs/` since 1.2.1 (nothing reads it at runtime, and vsce rewrites the README links into it to GitHub URLs via `--baseContentUrl`).
- `npm run package:vsix` produces the installable `.vsix`. During release prep, inspect the VSIX contents against the allowlist (see `AI_WORKFLOWS.md`).

## Known tooling quirks (do not "fix" casually)

- **CI** (`.github/workflows/ci.yml`, since 1.2.1) runs on pull requests to `master` and to release branches: `npm test` on `windows-latest`, `ubuntu-latest` and `macos-latest`; on the same three, the Python job (`lint:python` with the pinned ruff from `backend/requirements-dev.txt`, the backend unit suites, `test:analysis`, the HTML DOM suite); and a Windows job that packages the VSIX, checks its listing (`scripts/vsix-listing.mjs`) and uploads it with its dist fingerprint and listing. All jobs block (no `continue-on-error`); making them *required* for merging is a branch-protection setting only the maintainer can change. It runs exactly the local gates — nothing is CI-only. Since S15 (#87) a fourth job, `harnesses` (Ubuntu), installs Playwright's Chromium and runs `npm run test:harnesses`; the scene libraries come from `test/vendor/scene-libraries/`, never from a CDN. The other workflow, `deploy-pages-redirect.yml`, only publishes the GitHub Pages redirect.
- **webpack is the only bundler.** The orphan `esbuild.config.mjs` (no script ran it, `esbuild` was never a dependency) was deleted in 1.2.1.
- `tsconfig.json` `outDir` is `out/` (used for `compile-tests`/typecheck output); the shipped bundle goes to `dist/` via webpack. Don't confuse the two.
- `tsconfig.tsbuildinfo` at root is a build cache — never edit or commit-review it.

## How future agents should use this document

- Pick the *narrowest* test script that covers your change (table above), then finish with `npm run test:basic` before reporting done.
- Never claim a change works without either running the relevant test script or driving the F5 flow.
- If you add an npm script or change the build, update this file in the same session.
