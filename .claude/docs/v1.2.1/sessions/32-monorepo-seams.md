# Session log: #32 — monorepo seams and stale project documentation

Date: 2026-11-25. Branch `claude/project-thread-n2s3q6-monorepo-seams`, cut from `origin/v1.2.1` at `399494af`, merged with `origin/v1.2.1` (PR #44, feature baseline) mid-session. Source of the items: the sweep of non-`src` areas (now `docs/cleanup/sweep-outside-src.md`), items S1-S5, R1, R5, C1-C10, M6.

## Commits

| Commit | Subject | Sweep item |
|---|---|---|
| `ed30312e` | fix(python-runner): limit the ../../backend/src fallback to development mode | S4 |
| `229763a9` | chore(backend): move the dependency-languages fixtures into backend/tests | S2 |
| `b5fe1e63` | chore(backend): move manual_test and its suite and report tool into backend/ | S3, E9, C7 |
| `cb8a8e4e` | build(backend): generate backend/requirements.txt from the package manifest | S5 |
| `29bdb871` | merge origin/v1.2.1 (PR #44) | - |
| `e423cbc2` | test(baseline): record the python:requirements npm script | - |
| `8bc51617` | chore(backend): move the Python-only test runners into backend/scripts | S1 |
| `e7e4bd43` | docs(monorepo): document why .mcp.json stays Windows-only | R1 |
| `47bf2a60` | docs: fix agent-guide and doc drift left by the 1.2.0 close and the move | C1-C5, C9, C10, M6 |

## Results

- **Python dev fallback.** `src/code_analysis/engine/utils/backendScriptPath.ts` resolves every backend script for `executePython.ts` and `gitRevisionExporter.ts`: the `dist` copy, or `<repo>/backend/src` only in `ExtensionMode.Development`. Before, a missing `dist` copy in an installed extension resolved to `~/backend/src/...`. New test `test/analysis/backendScriptPath.test.cjs` plants `<home>/backend/src/main.py` and asserts production and test modes never reach it. CHANGELOG `[1.2.1]` Fixed line added.
- **Backend test material now lives in `backend/`:** `tests/fixtures/dependency-languages/`, `manual_test/`, `tests/manual_metrics_suite.py`, `scripts/report-manual-metrics.py`, `scripts/run-python-tests.cjs`, `scripts/run-analysis-tests.cjs`, and the analysis venv and reports under `backend/artifacts/` (gitignored). `run-html-analysis-tests.cjs` stays in the extension because it also runs an extension suite that needs `out/`. npm script names did not change; root `test:backend` now runs the backend runner directly.
- **`backend/requirements.txt`** is generated from `CODEXR_PYTHON_PACKAGES` (which stays the source of truth) by `npm run python:requirements`. `test/python_env/pythonRequirements.test.cjs` fails while the two disagree. The analysis runner reads its lizard pin from that file, so the backend no longer reads extension TypeScript.
- Equivalence of the manual-metrics move: the reports before and after differ only in the absolute fixture paths and `reportRoot`. `rootFixtureCount` is 24 and `deepFixtureCount` is 3 both times.

## Gates (last commit)

`npm test` 720/720; `test:python` 52 OK; `test:backend` OK; `CI=1 node backend/scripts/run-python-tests.cjs` OK; `test:analysis` 5 OK; `test:htmlanalysis` OK; `report:manual-metrics` OK. Guardrails: only the informational counters moved (`src.files` 369 → 370), recorded in `ed30312e`.

## Deliberately not done

- **`.mcp.json` stays `cmd /c npx`.** On native Windows, Claude Code cannot spawn `npx` without the wrapper, and the format has no per-platform variant. This is documented in `docs/monorepo.md`, along with the local-scope override for Linux and macOS.
- **`engines.node`** was already added by PR #44.
- **`repository.url`** and the `aMonteSl/CodeXR` URLs were left alone (maintainer decision pending). The fixed README link uses the same host and the `v1.2.0` tag as the image URLs.
- **The root README `media/` claim** (R10) is left to the worker that owns it.
- **Planning docs** (`ROADMAP.md` W1-16/W1-17/W3-01, `DESIGN_*.md`, `AUDIT.md`) still name the old locations. They are records, so they were not rewritten. W3-01's planned `manual_test/**` ESLint ignore is now moot, because ESLint only lints the extension package. W1-17 should edit `backend/tests/manual_metrics_suite.py`.
- **The uiPolicy emoji/NUL scans** already cover `../../backend`, so they now also cover the moved fixtures and the corpus. Both stay clean.

## Quirks recorded for 1.3.0

- `backend/tests/fixtures/dependency-languages/javascript_sample.js` and `typescript_sample.ts` are still byte-identical (sweep X10).

## F5 checks for the maintainer

1. "Run CodeXR Extension" (staged dev copy): run a file and a directory analysis (XR and LivePanel). The scripts come from `dist/`, so nothing should change.
2. The "workspace direct" launch config, with `dist/code_analysis/python` temporarily renamed: the analysis should still run from `backend/src` (Development mode fallback).
3. Optional, on an installed VSIX with `dist/code_analysis/python/main.py` removed: the analysis must fail with "Python script does not exist" and must not run anything outside the extension folder.
