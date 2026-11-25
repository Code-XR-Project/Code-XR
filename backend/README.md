# Code-XR analysis backend (Python)

The Python service that produces every analysis Code-XR shows: Lizard-based code metrics for about 23 languages, the dependency engine, the XR / LivePanel / DOM data producers, and the Git export worker.

| Path | Content |
|---|---|
| `src/` | The backend. Entry point `src/main.py`; modules grouped by capability (`utils/`, `XR/`, `livePanels/`, `html/`, `export/`, `tools/`, ...). |
| `requirements.txt` | The exact Python packages (lizard, tree-sitter-language-pack) the extension installs into its managed venv. **Generated** from `apps/vscode-extension/src/python_env/runtime/pythonPackageManifest.ts` by `npm run python:requirements`; a unit test fails while they disagree. |
| `tests/` | `unittest` suites grouped by capability, plus golden snapshots of the dependency engine and the sample sources they are built from (`tests/fixtures/dependency-languages/`). `tests/manual_metrics_suite.py` is not a discovered `test_*.py` suite: `npm run test:analysis` runs it, with the pinned lizard, over `manual_test/`. |
| `manual_test/` | Per-language fixtures (one or more per supported language, plus `deep/`) for the end-to-end analysis checks and for manual validation in the extension. |
| `requirements-dev.txt`, `ruff.toml` | Development tools only (never installed into the user's venv): the pinned `ruff` and its lint configuration (pyflakes, the pycodestyle error classes and a few pyupgrade lock-ins; no formatter, no import sorting; fixture corpora excluded). |
| `scripts/` | `run-python-tests.cjs`, `run-analysis-tests.cjs` and `run-ruff.cjs`, the Node-builtins-only runners behind `npm run test:python` / `test:backend`, `npm run test:analysis` / `report:manual-metrics` and `npm run lint:python`; `report-manual-metrics.py`: writes per-fixture XR / LivePanel reports to `artifacts/manual_test_reports/`. |

The HTML DOM suite also reads the extension's DOM template from `apps/vscode-extension/templates/`.

## How the apps use it

The VS Code extension does not import it: it runs it as a separate process in a virtual environment the extension manages. At build time `apps/vscode-extension/webpack.config.js` copies `backend/src/` into `dist/code_analysis/python/`, which is where the packaged extension looks for it. During development (an Extension Development Host), if that copy is missing, the extension falls back to `backend/src/` directly; an installed extension never does. The future IDE will run the same backend the same way.

## Running the tests

From the repository root:

```bash
npm run test:backend             # = node backend/scripts/run-python-tests.cjs (finds a Python for you)
# or directly, without npm:
python -m unittest discover -s backend/tests -p "test_*.py"

npm run test:analysis            # = node backend/scripts/run-analysis-tests.cjs: pinned-lizard venv in
                                 #   artifacts/, manual_metrics_suite.py, then the reports

python -m pip install -r backend/requirements-dev.txt   # once: the pinned ruff
npm run lint:python              # = node backend/scripts/run-ruff.cjs: `ruff check` with backend/ruff.toml
```

The goldens of the dependency engine are regenerated (only when an engine change is intended) with:

```bash
python backend/tests/dependencies/regenerate_golden.py
```

Python 3 is required; Linux, Windows and macOS are supported. The per-language end-to-end fixtures (`npm run test:analysis`) and the HTML DOM suite (`npm run test:htmlanalysis`) also exercise this backend.
