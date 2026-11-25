# Session log: #33 — turn on the guardrails: strict ESLint, strict tsc and ruff, with a ratchet

Date: 2026-11-25. Branch `claude/project-thread-n2s3q6-guardrails`, cut from `origin/v1.2.1` at `ac610402` (PRs #44–#52 merged). Story: Code-XR-Project/Code-XR#33 (epic #26). Rows: ROADMAP wave W3 with the §E overrides (W3-07 was moved to W1 and already exists; W3-18 belongs to the logging story).

## Commits

| Commit | Subject | Row |
|---|---|---|
| `81a6ba5c` | chore(lint): scope the parser block and add global ignores | W3-01 |
| `a7d21351` | chore(lint): the five existing rules become errors, with --max-warnings 0 | W3-02 |
| `4a61b8d8` | build(tsc): typecheck with noFallthroughCasesInSwitch | W3-03 |
| `a091868a` | build(tsc): typecheck with noImplicitReturns | W3-04 |
| `004bc6e9` | build(tsc): typecheck with noUnusedParameters, underscore convention | W3-05 |
| `530bb97c` | build(tsc): drop "DOM" from the extension's lib | W3-06 |
| `3653154f` | chore(lint): no-explicit-any as warn, budget raised to the measured 201 | W3-08 |
| `37597925` | chore(lint): size and complexity ceilings as warn, budget 201 -> 311 | W3-09 |
| `496f03d0` | chore(lint): type-aware no-floating-promises / no-misused-promises as warn | W3-10 |
| `f971e0a3` | chore(lint): lint test/, scripts/ and the two config files | W3-11 |
| `dcfc70d0` | chore(lint): lint the standalone templates runtimes in a relaxed block | W3-12 |
| `cf158eda` | build(tsc): checkJs for the build scripts and config files | W3-13 |
| `0b68f232` | test(packaging): menu-surface table and the icon-iff-rendered rule | W3-14 |
| `12ef52d0` | build(python): ruff config and the lint:python script | W3-15 |
| `a79b7aca` | test(tooling): every npm script's target exists | W3-16 |
| `6d45e131` | docs(test): document every test script and directory, with a guard | W3-17 |
| `299880a4` | ci: lint:python and the VSIX listing check; every OS blocks | W3-19 |

Every commit ran `npm test` green before it landed. Each rule landed with its fallout fixes in the same commit.

## The lint warning budget (`--max-warnings`, guardrail baseline `eslint.maxWarnings`)

| Step | Rule(s) added as warn | Warnings | Budget |
|---|---|---|---|
| W3-02 | — (every existing rule is now an error) | 0 | null → **0** |
| W3-08 | `@typescript-eslint/no-explicit-any` | +201 (= the ratchet's `any.total`) | **201** |
| W3-09 | `complexity` 15 (37), `max-depth` 4 (5), `max-params` 5 (28), `max-lines-per-function` 80 (35), `max-lines` 600 (5) | +110 | **311** |
| W3-10 | type-aware `no-floating-promises` with `checkThenables` (296), `no-misused-promises` (1) | +297 | **608** |

Each raise is recorded as a waiver in `test/tooling/guardrail-baseline.json`, with the per-rule counts as its reason. This is the mechanism `measureGuardrails.cjs --allow-regression` exists for. From here the budget only goes down. When a cleanup removes warnings, lower the number in the `lint` script and run `npm run guardrails:update`: the ratchet fails while the number is stale in either direction.

All budget rules apply only to `src/`. Everything else added in W3 is an error.

## Before / after

| Gate | Before | After |
|---|---|---|
| `npm test` | 789 tests | **811** (+22, four new files: lintContract 9, menuSurface 5, npmScripts 5, vsixListing 3) |
| ESLint scope | `src` | `src test scripts templates webpack.config.js eslint.config.mjs`. Newly linted: 31,720 lines of test `.cjs`, 612 lines of scripts and configs, and 20 standalone template runtimes |
| ESLint result | 0 messages, unable to fail | 0 errors, 608 warnings, budget 608 |
| Lint wall time | 2.8 s | 7.1 s (the type-aware block builds the TypeScript program) |
| `tsconfig.check.json` | `noUnusedLocals` | + `noFallthroughCasesInSwitch` (0 fallout), `noImplicitReturns` (0), `noUnusedParameters` (24 renamed to `_x`) |
| `tsconfig.json` lib | ES2022 + DOM | ES2022 (0 errors without DOM) |
| checkJs | none | `tsconfig.tooling.json`: 4 scripts + 2 configs. 2 findings, fixed with JSDoc |
| Python lint | none | `ruff check` over 46 files, 0 findings (46 × E402, each ignored per file with its reason) |
| `dist/extension.js` (production) | `6ff4a57d3188…` | identical after W3-05 and W3-06 (H1) |
| VSIX | — | 199 entries, 4,203,158 bytes packed; listing check passes |

## Gates run

- `npm test` after every commit: 789 → 811, all green.
- H1 for W3-05 (parameter renames) and W3-06 (lib). Production build `CODEXR_NO_SOURCEMAPS=1 npm run package`: the sha256 was identical before and after.
- `npm run test:python`: 73 OK (W3-15).
- `npm run test:analysis`: OK (W3-19).
- `npm run lint:python`: clean with ruff 0.17.6 (the pin) and with 0.16.9. With no ruff installed it exits 1.
- `npm run package:vsix` + `node scripts/vsix-listing.mjs`: passes. The entry count matches Python's `zipfile`.
- No template file changed, so no browser harness was due.

## Decisions worth knowing

- **ESLint roots are explicit**, never `eslint .` (audit skeptic, LINT-03'). `lintContract.test.cjs` pins the list and checks that each root exists.
- **`globals@14.0.0` is now a devDependency.** It was already in the lockfile through `@eslint/eslintrc`, so the lock diff is one line. Using it as a transitive import would have relied on hoisting.
- **The templates block is relaxed**, so that W3-12 changed no shipped source:
  - These are classic scripts, so a top-level name is a page global. `no-unused-vars` therefore checks locals only.
  - `eqeqeq` is set to `smart`. All 16 hits were the `x == null` idiom.
  - The LivePanel page's 20 cross-script globals are listed in the config. This is the first written record of that contract.
  - The 11 multi-part runtime directories are ignored, because a part does not parse on its own. A test checks that each ignored directory holds only its manifest-listed parts.
- **`tsconfig.tooling.json` uses `strict` minus `noImplicitAny`.** With `noImplicitAny` the fallout was 27 unannotated-parameter reports in untyped JS: noise, not defects.
- **ruff runs lint only (`E4`, `E7`, `E9`, `F`, target py37).** It has no formatter and no isort, because tests pin import lines. Target py37 comes from the "Python 3.7+" message in `venvManager.ts`. Fixture corpora (`manual_test/`, `tests/fixtures/`) are excluded. `lint:python` is a root-only script, so the extension's pinned script list does not change.
- **CI: every OS blocks now.** I removed `continue-on-error` from the gate and Python matrices, because ubuntu and macOS have been green (run 45601066462). The VSIX listing check runs in the Windows package job and is path-agnostic.

## Deliberately not done

- **Branch protection (W3-19 "required")**: making the CI checks *required* on `master` / `v1.2.1` is a GitHub repository setting that only the maintainer can change. **Maintainer action**: in Settings → Branches, require `npm test (windows-latest)`, `npm test (ubuntu-latest)`, `npm test (macos-latest)`, the three `python suites (…)` jobs and `package the VSIX`.
- **`no-console`** and the console migration are left to story #34. **W3-18** (the "what may be logged" rule) also belongs to the logging programme.
- **Linting the multi-part runtimes** (`templates/components/codexr/*/*Runtime/`): it would mean linting the *assembled* output. Record-only.
- **The backend's `.cjs` runners** (`backend/scripts/*.cjs`) sit outside the extension workspace's ESLint roots. Record-only. A root-level ESLint config would be the place for them.
- **The 53 inert command icons** (MENU-02): the guard landed with the 53 as seeded exemptions. Deleting them is a manifest-only cleanup for a later commit.
- **The `void` sweeps for the 296 floating promises** (T56–T59) are later W4 work. The budget tracks them.

## Behaviour quirks found (record-only for 1.3.0)

- `HttpServer.handleSSERequest` and `staticAssets.serveStaticFile` never read the request. `MultiServerLauncher.handleAutoOpening` never reads `htmlFile`. `LivePanelParser.loadTemplateFiles` ignores `analysisMode`, and `VisualizeDOMParser.processHTMLTemplates` ignores `virtualScreenSessionId`. All of them are now `_`-prefixed. Dropping the parameters changes signatures that tests call positionally, so it is a separate refactor.
- `handleAnalysisClicks.ts` still holds three TODO stubs (`handleContextMenuAction`, `handleDoubleClick`, `getHoverInfo`).

## CHANGELOG

No line was added. Everything here is internal tooling (lint, typecheck, ruff, tests, CI), and a user cannot notice any of it. The "Internal improvements" summary in `[1.2.1]` already covers this.

## F5 checks for the maintainer

None needed: no runtime file changed behaviour. The only `src/` edits are parameter renames (H1, dist-identical). The templates, the Python backend and the manifest are untouched.
