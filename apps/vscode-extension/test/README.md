# CodeXR Test Suite

This folder contains the local validation suite for CodeXR.

## Structure

Every `*.test.cjs` below `test/` is collected by `npm run test:unit`, except under `test/runners/`, which the collector skips on purpose.

- `test/analysis`: the largest group: browser runtimes (tables, charts, mapping UI, modes, dependency graph, historical comparison, project evolution, collaboration), parsers, export, Git services, watchers.
- `test/baseline`: the feature baseline of the cleanup epic (#26): a snapshot of everything a user can see, invoke or rely on, and the register of the only removals the maintainer authorized. `node test/baseline/featureSurface.cjs --write` regenerates it and refuses to drop an unauthorized entry.
- `test/collaboration`: collaborative XR sessions.
- `test/commands`: command registration contract tests (the real `registerAllCommands` under the fake vscode, tied to package.json).
- `test/directory_analysis`: directory watcher and reanalysis data tests.
- `test/helpers`: shared helpers (`sourceText.cjs`, `fakeVscode.cjs`, `runtimeAssembly.cjs`, `logCapture.cjs`) and their own tests.
- `test/logging`, `test/python_env`, `test/servers`, `test/startup`, `test/utils`, `test/visualization_settings`, `test/visualize_data`: focused suites per subsystem.
- `test/manual`: the HTML pages the browser harnesses load, their data, and `buildAssembledRuntimes.cjs`.
- `test/packaging`: what ships (VSIX layout, dist characterization, Marketplace listing, the menu surface).
- `test/runners`: the runner scripts npm scripts point to (the unit runner, the HTML-analysis runner, the four browser harnesses).
- `test/tooling`: the guardrail ratchet (`measureGuardrails.cjs`, `guardrail-baseline.json`), the lint/typecheck contract, the npm-script checks, the folder dependency-direction test (`dependencyDirection.test.cjs`, data in `folderDependencies.json`).
- `test/views`: the sidebar tree: a golden snapshot of every item `ModularTreeDataProvider` builds and of the section-item bridge behind it (`CODEXR_WRITE_TREE_SNAPSHOT=1` regenerates it, for an intended change only).
- `../../backend/tests` (outside this package): backend Python tests grouped by capability; `../../backend/scripts/run-python-tests.cjs` runs them (`npm run test:python`).

## Commands

- `npm run test` (= `test:basic`): typecheck, lint, compile the TypeScript sources, and run Node-based unit tests.
- `npm run test:unit`: the unit suites only, against the existing `out/` (it refuses a stale one).
- `npm run test:python`: run Python backend tests if a Python interpreter is available (under `CI`, a missing interpreter fails).
- `npm run test:all`: run both the Node and Python suites.
- `npm run test:analysis`: per-language end-to-end metrics over `backend/manual_test/` with the pinned lizard.
- `npm run test:htmlanalysis`: the HTML/DOM analysis suite.
- `npm run test:xr-harness`, `test:xr-mode-harness`, `test:xr-immersive-harness`, `test:project-evolution-harness`, `test:xr-chart-bounds-harness`: browser harnesses (Playwright's Chromium and live CDNs; local only). The mode and immersive harnesses serve the project over HTTP on 127.0.0.1 (`test/helpers/staticHttpServer.cjs`) instead of opening `file://`, so `fetch()` works in them.

The full table, with when to run each, is in `.claude/docs/DEVELOPMENT.md`.

## How the suites load code

Three mechanisms coexist, and it matters which one a test uses:

1. **Executed from `out/`** — the suite `require`s the tsc output. `npm test` rebuilds `out/` from scratch first; `npm run test:unit` on its own refuses to start when `out/` does not match `src/`.
2. **Browser runtimes evaluated from `templates/`** — usually through `test/helpers/runtimeAssembly.cjs`, the test-side mirror of the production runtime assembler.
3. **Source-text assertions** — the suite reads a `src/` or `templates/` file with `readFileSync` and matches regexes against it. About half the suites do this.

## Source-text assertions

They pin intent that no runtime call can express (a removed feature must stay removed, a settings migration must exist, two artefacts must agree). They also have sharp edges: moving a line can turn one red with identical behaviour, a **negative** assertion keeps passing forever once the code it guards moves to another file, and a file that a test reads as text is not dead even with zero importers.

Use `test/helpers/sourceText.cjs` for new or edited assertions:

- `readSource(path)` / `readConcatenated(paths)` / `readSourceTree(dir, options)` return **LF text**, so a pattern never depends on the checkout (the working tree is CRLF on Windows, LF elsewhere). A missing file throws an error that says what to do.
- `assertAbsent(text, pattern, { canary })` — the canary is mandatory and must match. It proves the haystack still holds the code the guard is about.
- `assertOrdered(text, patterns)` — sequence, not just presence.

Before changing a file, run `grep -rn "<basename>" test/ scripts/` and classify every hit:

| Class | What it is | Rule |
|---|---|---|
| **G** — permanent guard | negative removal guards; cross-artefact contracts (manifest and src, TypeScript and Python, TypeScript and its browser mirror); security or privacy intent; packaging; policy walks | Keep it. If the file is split, retarget the haystack to the successor files with `readConcatenated` and a canary, in the same commit. The regex itself does not change |
| **S** — shape pin | an exact signature, an `as any` cast, an import line, identifier adjacency, ordering, whitespace | A behavioural characterization, loaded from `out/`, lands in a **prior** commit and is green against the unchanged source. Only then may the refactor relax the pin |
| **L** — log-literal pin | message text that the test finds only inside a log call | The text survives verbatim in the same file or its successors |

A commit never edits a regex and the source it guards together, unless the edit is pure retargeting. There is no mass rewrite: existing assertions move to the helper when the file they read is touched.
