# Session: #55 Reorganize `src/` feature-first (epic #26)

Date: 2026-11-25. Branch `claude/project-thread-n2s3q6-src-layout`, from `v1.2.1` at `41cfc523` (`origin/v1.2.1` did not move during the session, so nothing was merged). Story: Code-XR-Project/Code-XR#55. Plan and map: `docs/cleanup/src-layout.md` (§4 map refreshed in the first commit, §7 the result) and `docs/cleanup/src-move-map.json`. Every batch of the plan landed.

## Commits

| SHA | Subject | Files |
|---|---|---|
| `cbcd9d24` | docs(cleanup): refresh the src/ move map on the current tree | map JSON + §4.1 |
| `992f84b2` | test(tooling): move-aware guardrail ratchet and layered folder units | tooling |
| `87506796` | refactor(src): dissolve the views and analysis-views barrels (#55 B0) | 26 barrels |
| `4867f66f` | refactor(src): dissolve the analysis-commands barrels (#55 B0) | 10 barrels |
| `c8a1511a` | refactor(src): dissolve the collaboration and remote-access barrels (#55 B0) | 2 barrels |
| `e5e99e5b` | refactor(src): dissolve the remaining re-export barrels (#55 B0) | 8 barrels |
| `d69654c8` | B1 platform and shared | 9 |
| `98d443e4` | B2 learn-more | 5 |
| `e91522f5` | B3 python-env | 9 |
| `e7d9166e` | B4 visualization settings | 13 |
| `74eba0b0` | B5 visualize-data | 12 |
| `81c806d0` | B6 examples | 10 |
| `d5ad7dd0` | B7 core/charts | 11 |
| `4cab8b25` | B8 collaboration and remote access | 11 |
| `f27411a8` | B9 core/server | 44 |
| `0caf1d5f` | B10 servers and active-servers | 16 |
| `7f129583` | B11 core/dependencies, core/history, core/export | 21 |
| `46321462` | B12 core/analysis | 64 |
| `a730f894` | B13 features/analysis | 55 |
| `11cf9c8f` | B14 app/ | 7 |
| (this commit) | test(tooling): pin the src/ layout; CHANGELOG, docs, §7, this log | - |

Each move commit body lists its rows of the map, the renames, the pins it retargeted, the eslint and `folderDependencies.json` changes and its H3 result.

## Proof (H3, `src-layout.md` §6), every batch

- `compare-out.mjs` (A.6): 291 of 291 compiled modules equivalent, 0 problems. Batch 0 used a barrel-aware variant (a `require` of a barrel resolved to the declaring module): 311 → 301 → 299 → 291 modules, 0 problems.
- webpack `mode: none` stats: 512 modules, 279 of them under `src/`, after every move batch.
- `test/baseline/featureBaseline.test.cjs` green without `--write` (commands, menus, views, settings, shipped files unchanged).
- `npm test` after every commit: 1,059 of 1,059 (1,064 with the closing commit's layout test), typecheck clean, lint 0 errors and 158 warnings (the budget), `unreachable = 0`.
- Guardrails: `guardrails:update -- --renamed` each batch, ratcheted metrics unchanged, waivers still the 6 pre-existing ones.
- Extra suites: B3, B11, B12 `test:python` (73) and `test:analysis` green; B7, B9, B12 `test:xr-harness` green (B7 and B12 also `test:xr-immersive-harness`). In this sandbox the harnesses run with a Playwright preload that serves the CDN scripts locally.
- `npm run package:vsix` against a build of `41cfc523`: the same 199 files, all byte-identical except `CHANGELOG.md`, `dist/extension.js` (21 KB smaller: the 46 barrel modules are gone) and the lazy `get-port` chunk, renamed `756.extension.js` → `515.extension.js` by webpack's deterministic ids (its contents are identical apart from the id).

## Decisions and deviations

- **Map refresh (§4.1):** six files changed destination against the original analysis (`sink.ts`, `settingsFile.ts`, `xrFieldModels.ts`, `pythonStderrStream.ts`, `chartTypeCommandFactory.ts`, and `sha256Generator.ts`, which goes to `core/analysis/utils/` instead of `shared/` because it now imports the logger).
- **`vscodeFreeFloor` 109 → 106** (batch 0). Only the three deleted vscode-free barrels left the count; no surviving file lost the property. The note in `folderDependencies.json` says so.
- **Any-free lint locks followed their files.** When a locked file moved into a folder that also holds files with `any`, the lock moved to the whole folder and those files went into `ignores` (`activeServerItems.ts`, `executePython.ts`, the seven `core/server` files). B10 also restored the lock on `platform/webview/panelManager.ts`, which B1 had moved without carrying it.
- **Vacuous guards retargeted.** Three "this must not exist" checks would have passed for free once their folder was gone. They now look at the folder the file would occupy today: `visualStyleComponentAsset.ts` (scene-assets), the removed agent-context feature (features/analysis) and the legacy storage folder (core/analysis). The asserted value is unchanged.
- **New test helper** `test/helpers/sceneAssetModules.cjs`: four tests loaded the `customComponents/index.js` barrel. They now merge the 20 scene-asset modules by name, and the folder is named once.
- **Not edited:** `templates/components/COMPONENTS.md` (shipped) still says `src/.../customComponents/runtimeAssembly.ts`. Historical docs keep the old paths.
- **Comments in `src/`:** the codemod changed specifiers only. The one comment that named a moved path (`platform/commands/commandRegistry.ts` → `src/commands/index.ts`) was updated in B14. H3 compares with `--removeComments`, so this is safe.

## F5 smoke checklist (maintainer)

The plan asks for an F5 run ("Run CodeXR Extension") after B9, B12 and B14. This environment has no VS Code host, so the three runs are still open. Run each against its commit (`f27411a8`, `46321462`, `11cf9c8f`), or once on the branch head, which covers all three:

- [ ] The sidebar opens. All eight root sections render: Servers, Active Servers (with the nested Collaboration group), Examples, Visualize Data, Analyses, Python Env, Visualization Settings, Learn More.
- [ ] One XR analysis runs: right-click a source file → XR analysis. The scene opens in the browser, and editing the file live-reloads it.
- [ ] A server starts and stops: Servers → start the default server, it appears under Active Servers, then stop it from the tree.
- [ ] The CodeXR output channel shows no activation error.

## Risks

- Open branches that touch `src/` will conflict on every moved path. A rebase needs the A.5 codemod run on that branch with `docs/cleanup/src-move-map.json`; resolving by hand does not scale.
- Tests read compiled modules from `out/` by path. A stale `out/` from before the move can hide a missing retarget, so always run `rm -rf apps/vscode-extension/out` first.
