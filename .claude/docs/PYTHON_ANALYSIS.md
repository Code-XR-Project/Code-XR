# Code-XR Python Analysis Backend

> **Purpose**: Understand the only non-TypeScript subsystem — the Python engine that produces all code metrics — and its contract with the extension.
> **Stability**: Stable — update when CLI modes, the field schema contract, or the venv mechanism change.
> Verified against `src/code_analysis/python/` and `src/python_env/` structure on 2026-07-08; paths re-verified on 2026-11-25 (story #43) against the monorepo (`backend/src/`) and the feature-first `src/` (story #55).

## Why this file exists

The Python backend is a frequent source of confusion:
- It lives in `backend/src/` (outside the extension package since the monorepo move; it was `src/code_analysis/python/`) and is **not compiled** — webpack's CopyPlugin copies it verbatim into `dist/code_analysis/python` at build time (excluding `__pycache__`). In Development mode only, the extension falls back to `<repo>/backend/src` when the `dist/` copy is missing.
- It runs inside a **managed virtual environment** created by the extension itself, not the system Python.
- Its output schema drives TypeScript-side validation, so Python and TS must change together.

## Entry point and CLI

`backend/src/main.py` — argparse CLI, JSON output on stdout.

- `--mode {livePanel, xr, schema, dependencies, functions}` (`functions`, added for the Code-XR IDE's Problems panel #173, returns each analysable file's functions with line range, CCN, NLOC and parameter count, from `utils/function_metrics.py`; with `--type file`, `--project-root` makes the path relative; the extension does not use it)
- `--type {file, directory}` (the unused `project` alias and the unread `--output` flag were removed in 1.2.1; `--target`, `--files`, `--deep`, `--cache`, `--dependency-refresh`, `--project-root` remain)
- Three more scripts are spawned directly by TypeScript: `html/html_dom_parser.py` (DOM mode), `summaryFiles/file_reanalysis_coordinator.py` (watcher re-analysis; the folder was misspelled `sumaryFiles/` until 1.2.1) and `export/git_export_analysis_worker.py` (Git export worker pool).

The TS bridge is `src/core/analysis/python/executePython.ts`, which spawns the venv's interpreter against `main.py` and parses the JSON. Progress is streamed on stderr as JSON lines (`{"progress": {...}}`, `{"debug": ...}`, `{"warning": ...}`, `{"error": ...}`) by `backend/src/utils/progress_logger.py`; `src/core/analysis/python/pythonStderrStream.ts` classifies them and `executePython.ts` reports the progress.

## Layout

```
backend/src/
├── main.py                 CLI entry; wires sys.path for subpackages
├── tools/                  analyzer wrappers
│   ├── code_metrics_analyzer.py per-function metrics (CCN, NLOC, params, nesting, cognitive, Halstead, MI), same JSON as the old Lizard wrapper plus the epic #219 fields
│   ├── code_metrics/            the analyzer itself: lexer + one parser per language family (spec: docs/lizard-replacement/SPEC.md)
│   ├── class_counter_analyzer.py
│   └── python_comment_analyzer.py
├── export/                 git_export_analysis_worker.py (Git export worker)
├── utils/                  engines and shared helpers
│   ├── file_analysis_engine.py / directory_analysis_engine.py
│   ├── dependency_analysis_engine.py      (dependency graph; tree-sitter-language-pack)
│   ├── metric_language_contract.py        per-language metric capabilities
│   ├── xr_field_schema.py                 ★ the field schema (see contract below)
│   ├── file_metric_summary.py, line_metric_utils.py, directory_scan_utils.py
│   └── babia_path_utils.py, progress_logger.py
├── livePanels/             LivePanel coordinators (file/directory, deep)
├── XR/                     xr_file_analysis_coordinator.py, xr_directory_analysis_coordinator.py
├── html/                   html_dom_parser.py (DOM visualization backend)
└── summaryFiles/           file reanalysis coordinator (watcher re-analysis)
```

## The field-schema contract (critical seam)

1. `backend/src/utils/xr_field_schema.py` defines which metric fields exist per analysis type.
2. TS fetches it via `main.py --mode schema`, cached/served by `src/core/analysis/python/xrFieldSchemaService.ts` (prefetched at startup by the `StartupCoordinator`).
3. `src/core/charts/processing/dimensionValidator.ts` validates user dimension mappings against that schema before launching an XR scene.

**Rule**: any metric added/renamed/removed in Python must flow through the schema, and the analysis/manual-metrics tests must be re-run. A mismatch surfaces as dimension-mapping validation failures or empty charts.

**Do not touch in a cleanup (audited 2026-09-18).** The contract is five hops long (`xr_field_schema.py` → `get_xr_schema` → `main.py --mode schema` → `executePython.ts` → `xrFieldSchemaService.ts` → `dimensionValidator.ts`), frozen by tests on both sides, and the schema is **persisted** in the user's `globalState` (`codeXR.analysis.xrFieldSchemaCache.v1`), so a Python-side change can be masked locally and surface later as a mapping failure. Therefore none of these is cleanup material:
- `XR_SCHEMA_VERSION` — a bump invalidates every user's cached schema.
- The order, count and exact label strings of `XR_FILE_FIELDS` (13) and `XR_DIRECTORY_FIELDS` (25); `backend/tests/xr_schema/test_xr_schema.py` pins the counts.
- The `_text_field(…)` / `_numeric_field(…)` call syntax — `test/analysis/xrFieldSchemaIntegration.test.cjs` regex-matches five of those source lines, double quotes included.
- The `build_complexity_band` thresholds (`>25`, `>10`), mirrored in `code_metrics_analyzer.calculate_complexity_metrics` and `summarize_function_metrics`. Three copies on purpose: de-duplicating them is a contract change, not a cleanup.
- `summarize_function_metrics` — Lizard reported CCN 18, but that is `or 0` guards inside comprehensions, not branching. Leave it alone.
- Every id in `XR_DIRECTORY_FIELDS` must stay a key emitted by `utils/file_metric_summary.py`, and every id in `XR_FILE_FIELDS` a key emitted by `utils/file_analysis_engine.py` (subset checks in `backend/tests/manual_metrics_suite.py`).

Python source is also pinned on **quote style and import order** by source-text tests (`main.py`'s `choices=['livePanel', …]`, `print('=== JSON_START ===')`, the imports that follow the `sys.path` setup). No formatter, no isort.

## Virtual environment (`src/core/python-env/`, commands and tree in `src/features/python-env/`)

- `venvManager.ts` creates/verifies/reinstalls the venv; the package manifest (`pythonPackageManifest.ts`), storage and env UI state live alongside it. User-facing commands: `codeXR.pythonEnv.*` (create/delete/status/reinitialize/verify/debug).
- Python dependencies are installed into this venv at runtime. The source of truth for the pins is `CODEXR_PYTHON_PACKAGES` in `src/core/python-env/pythonPackageManifest.ts` (only `tree-sitter-language-pack` 1.8.1 since 1.2.1: the metrics need no third-party package); `backend/requirements.txt` is its generated mirror (`npm run python:requirements`, checked by `test/python_env/pythonRequirements.test.cjs`). Note: `tree-sitter-language-pack` 1.x downloads parser libraries from GitHub on first use. Since 1.2.1 only the set-up does that: `VenvManager` runs `backend/src/tools/download_parsers.py` after installing the packages (and in the startup repair path, which fetches only missing parsers), into `<venv>/codexr-tree-sitter`; `backend/src/utils/tree_sitter_parsers.py` points the pack there, and the dependency engine calls `process()` only when `is_available(grammar)`, otherwise it uses its regex fallback. The install verification only imports the package.
- Context key `codeXR.pythonEnv.uiLocked` gates analysis context menus while the env is being set up.

## Languages and metrics

- Metrics: cyclomatic complexity (CCN), cognitive complexity, Halstead (volume, difficulty, effort, estimated bugs), maintainability index, LOC/comment lines, function/class counts, parameters, nesting depth — computed by Code-XR's own analyzer (`backend/src/tools/code_metrics/`, spec in `docs/lizard-replacement/SPEC.md`, differential tests against frozen Lizard output in `backend/tests/metrics_differential/`). Dependency relations via **tree-sitter-language-pack** (pinned; confidence levels exact/best-effort/unsupported/ambiguous — see `docs/features/DEPENDENCY_GRAPH_XR.md`).
- Language support: README claims 24, dependency-graph doc and roadmap say 23, and `backend/tests/fixtures/dependency-languages/` holds ~25 fixture languages. **The source of truth is `src/core/analysis/languages/languageMetadata.ts` (TS side) + `backend/src/utils/metric_language_contract.py` (Python side: 28 languages, 55 extensions since epic #219 added Rust, Dart, Shell, PowerShell and R, plus HTML as DOM-only)** — check those, not the docs, when a language question matters. (Recorded as documentation debt in `V1.2.0_STATUS.md`.)

## Testing the Python side

| Command | Covers |
|---|---|
| `npm run test:python` | `unittest` suites in `backend/tests/` (analyzers + goldens, dependencies + goldens, directory scanning, git export, html_dom protocol, path normalization, xr file analysis, xr schema): 73 tests at the end of 1.2.1. They need Python 3.10+ (two tests use 3.9/3.10 APIs), while `backend/src` itself targets 3.7 |
| `npm run test:analysis` | End-to-end metric equivalence over `backend/manual_test/` fixtures (one per language); asserts XR and LivePanel produce identical `data.json` |
| `npm run test:htmlanalysis` | HTML/DOM parser (`backend/tests/html_dom/` + `test/analysis/livePanelDomIntegration.test.cjs`) |
| `npm run lint:python` | `ruff check` over `backend/` (`backend/ruff.toml`, ruff pinned in `backend/requirements-dev.txt`); lint only, never a formatter |
| `backend/tests/manual_metrics_suite.py` | Manual metrics suite (driven by the analysis runner) |

## How future agents should use this document

- Touching anything under `backend/src/`? Plan the TS-side schema/validation impact first (section "field-schema contract"), then run `test:python` + `test:analysis`.
- Never assume system Python is used — always reason in terms of the managed venv.
- Don't edit anything under `dist/` — the Python files there are build artifacts copied from `backend/src/`.
