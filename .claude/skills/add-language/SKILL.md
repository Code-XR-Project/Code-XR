---
name: add-language
description: Add or adjust supported-language coverage in CodeXR — the Python metric contract, TS language metadata, dependency-graph support, fixtures, and the analysis test matrix. Use when adding a language, changing per-language metric capabilities, or investigating language-count discrepancies.
---

# Language support changes

Language support spans two worlds that must change together. The **source of truth** is code, not docs (28 languages and 55 extensions since epic #219; older docs say 23 or 24):

- TS side: `src/core/analysis/languages/languageMetadata.ts`
- Python side: `src/code_analysis/python/utils/metric_language_contract.py`

## Checklist for adding/changing a language

1. **Python contract**: declare the language's metric capabilities in `metric_language_contract.py`. Metrics come from Code-XR's own analyzer (`backend/src/tools/code_metrics/languages.py` declares the language and its family; `keywords.py` its reserved words, which Halstead needs; extend `EXTENSION_LANGUAGE`). A language Lizard never measured has no differential oracle: add its extensions to `POST_LIZARD_EXTENSIONS` in `backend/tests/metrics_differential/differential.py` and pin hand-counted values in `backend/tests/new_languages/` instead (the epic #219 pattern: XR = LivePanel rows, every schema field filled, every function's values pinned). Otherwise add a corpus file to `backend/tests/metrics_differential/corpus/`; dependency relations from `tree-sitter-language-pack` (`utils/dependency_analysis_engine.py`) with confidence levels exact / best-effort / unsupported / ambiguous.
2. **Field schema impact**: if any metric field is added/renamed, it must flow through `python/utils/xr_field_schema.py` → `--mode schema` → `xrFieldSchemaService.ts` → `dimensionValidator.ts`. A mismatch surfaces as dimension-mapping failures or empty charts. See `.claude/docs/PYTHON_ANALYSIS.md` §field-schema contract.
3. **TS metadata**: mirror the language in `src/core/analysis/languages/languageMetadata.ts` (extensions, display name, capabilities).
3b. **The analyzers keyed on extension**, which a new language silently reads as zero otherwise: `tools/class_counter_analyzer.py` (an arm, even an empty one), `tools/python_comment_analyzer.py` (`LEXER_COMMENT_EXTENSIONS` uses the metrics lexer), `utils/tree_sitter_parsers.py` (`_GRAMMAR_ALIASES` when the grammar name differs), the dependency patterns, and on the TS side `supportedLanguages.ts`, `getLanguageFromExtension` in `watchers/directoryReanalysisData.ts` and the watcher's `DIRECTORY_ANALYSIS_EXTENSIONS`. Then update the pinned tables on purpose: `tests/analyzers/` (partition + class-counter golden), `tests/dependencies/` goldens, `test/utils/languageTables.test.cjs`, `test/analysis/watcherExtensionContract.test.cjs`, the feature baseline (`node test/baseline/featureSurface.cjs --write`).
4. **Fixtures**:
   - `backend/manual_test/<lang>_metrics.<ext>` (flat, one or more files per language; `deep/` holds the recursive-directory extras) — consumed by `npm run test:analysis` (see `backend/manual_test/README.md`).
   - `backend/tests/fixtures/dependency-languages/` — sample source for dependency-graph tests.
5. **Venv dependencies**: if a new Python package is needed, it goes through the managed venv manifest in `src/core/python-env/` (`venvManager.ts`, `pythonPackageManifest.ts`) — never assume system Python, never add an implicit download (no downloads without explicit user consent).

## Validation

```
npm run test:python      # Python suites (dependencies, scanning, schema)
npm run test:analysis    # end-to-end: XR and LivePanel must produce identical data.json per language
npm test                 # default gate
```

## Docs to touch in the same session

- `docs/features/DEPENDENCY_GRAPH_XR.md` language table (if dependency support changed).
- The language-count claims are inconsistent across README/roadmap/docs — if your change alters the real count, update the count **everywhere it appears** or record the remaining mismatch in `.claude/docs/V1.2.1_STATUS.md` (the historical list is `V1.2.0_STATUS.md` §Documentation debt).
