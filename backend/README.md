# Code-XR analysis backend (Python)

The Python service that produces every analysis Code-XR shows: Lizard-based code metrics for about 23 languages, the dependency engine, the XR / LivePanel / DOM data producers, and the Git export worker.

| Path | Content |
|---|---|
| `src/` | The backend. Entry point `src/main.py`; modules grouped by capability (`utils/`, `XR/`, `livePanels/`, `html/`, `export/`, `tools/`, ...). |
| `tests/` | `unittest` suites grouped by capability, plus golden snapshots of the dependency engine. Some suites read fixtures from `apps/vscode-extension/` (`test/fixtures/`, `manual_test/`, the DOM template). |

## How the apps use it

The VS Code extension does not import it: it runs it as a separate process in a virtual environment the extension manages. At build time `apps/vscode-extension/webpack.config.js` copies `backend/src/` into `dist/code_analysis/python/`, which is where the packaged extension looks for it. During development (an Extension Development Host), if that copy is missing, the extension falls back to `backend/src/` directly; an installed extension never does. The future IDE will run the same backend the same way.

## Running the tests

From the repository root:

```bash
npm run test:backend
# or directly, without npm:
python -m unittest discover -s backend/tests -p "test_*.py"
```

The goldens of the dependency engine are regenerated (only when an engine change is intended) with:

```bash
python backend/tests/dependencies/regenerate_golden.py
```

Python 3 is required; Linux, Windows and macOS are supported. The per-language end-to-end fixtures (`npm run test:analysis`) and the HTML DOM suite (`npm run test:htmlanalysis`) also exercise this backend.
