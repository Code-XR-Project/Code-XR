# Session log: #35 part A — simplify the TypeScript analysis pipeline, export and settings code

Date: 2026-11-25. Branch `claude/project-thread-n2s3q6-ts-pipeline`, cut from `origin/v1.2.1` at `ca3eb871`. Story: Code-XR-Project/Code-XR#35 (epic #26), part A. Rows: ROADMAP W4-T01..T28, T34 and T35, with the §E overrides. Part B (T29-T33, T36-T59) is a separate branch.

## Commits

Every refactor follows a characterization commit that was green against the unchanged code.

| Commit | Subject | Row |
|---|---|---|
| `ce2a3489` | test(executePython): characterize results, errors, argv and reports of every entry point | T01-T06 (test first) |
| `1daa09a9` | refactor(executePython): collapse the XR recovery branch that cannot recover | T03 |
| `6bbca836` | refactor(executePython): executeXRAnalysis builds and runs; recoverXRResult maps the outcome | T01 |
| `417763af` | refactor(executePython): spawnAndCollect discriminated union | T02 |
| `8af2a885` | refactor(executePython): finishAnalysis helper | T04 |
| `f353ca6a` | types(watchers): directoryReanalysisData | T05 |
| `328c22e6` | types(python): typed analysis result in executePython | T06 |
| `aa9bfec2` | refactor(fileXRParser): copy steps become a loop | T07 |
| `dd5f83d2` | refactor(directoryXRParser): asset loop | T08 |
| `9d26dd5b` | refactor(fileXRParser): guard list becomes an array with .some, identical membership | T09 |
| `e8fc87ce` | test(active-analyses): characterize the tree item presentation | T11 (test first) |
| `90caac63` | refactor(active-analyses): icon tables and safeResourceUri | T11 |
| `360aaf3f` | test(validator): characterize DimensionValidator.validateMappings | T12 (test first) |
| `c714daeb` | refactor(validator): five named rule functions | T12 |
| `5dd7ac8b` | refactor(visualize-data): one rule for the invalid-path resets | T13 |
| `2806593c` | test(uri): characterize convertToFileSystemPath and the editor fallback | T14 (test first) |
| `bfedba6a` | refactor(uri): resolver chain with a `!== null` gate | T14 |
| `f466b10c` | test(reanalyzer): characterize applyIncrementalChanges | T15 (test first) |
| `6c63d113` | refactor(reanalyzer): applyIncrementalChanges as normalized steps plus publishChanges | T15 |
| `594226e3` | refactor(refresh): runIfNeeded guard as canRun plus the existing needsRefresh | T16 |
| `8bd61289` | test(deps): characterize DependencyGraphService.analyzeFileScope | T17 (test first) |
| `227cfeed` | refactor(deps): analyzeFileScope delegates resolution and eviction | T17 |
| `0b6cf876` | test(visualize-data): characterize handleDimensionFieldMapping | T18 (test first) |
| `bc4b0e0e` | refactor(visualize-data): one "field already used" predicate | T18 |
| `4b31a5e2` | test(export): snapshot buildExportManifest across its gap cases | T19 |
| `7a3b4542` | refactor(export): buildExportManifest phases | T20 |
| `af17f360` | test(export): table of how a failing export revision is classified | T22 (test first) |
| `b29056a3` | refactor(export): module-private classifyExportRevisionFailure | T22 |
| `dbc163f6` | test(export): content-hash de-dup, the under-2-sources cleanup and the gitData shape | T23 |
| `e9274c2e` | refactor(export): runGitRevisionExport phases | T24 |
| `ff87338f` | test(git): characterize listReferences per output format | T25 (test first) |
| `0fce9e1f` | refactor(git): listReferences parsers | T25 |
| `bf6061f0` | test(git): characterize materializeDirectory with a stubbed tree | T26 (test first) |
| `7b7fc07e` | refactor(git): materializeDirectory plan and copy; drop the unreachable guard | T26 |
| `a69259d0` | test(export): edge rows of relativizeExportArtifacts | T27 (test first) |
| `d7155e2d` | refactor(export): relativizeExportArtifacts over one rewriteJsonUrls | T27 |
| `eda0589a` | test(export): validateExportPackage gap cases | T28 (test first) |
| `31adfbfb` | refactor(export): validateExportPackage over assertIsFile and collectManifestPayloadUrls | T28 |
| `9ca28fd4` | test(export): characterize the git export preflight | T34 (test first) |
| `f20071d9` | perf(export): drop the unread repositoryRoot from the preflight | T34 |
| `1a8f47ab` | refactor(export): import GIT_REVISIONS_FOLDER; un-export readGitExportSystemResources | T35 |

T10 and T21 landed in #38 and were skipped.

## Measurements

Guardrail baseline (`test/tooling/guardrail-baseline.json`). Each commit that moved a metric also lowered the baseline and, where it changed, the ESLint `--max-warnings` budget.

| Metric | Before (`ca3eb871`) | After |
|---|---|---|
| ESLint warning budget | 553 | 496 |
| `complexity.over10` | 69 | 56 |
| `complexity.over15` | 25 | 11 |
| `complexity.over20` | 6 | 1 |
| `complexity.over30` | 3 | 0 |
| `functions.over80Lines` | 45 | 38 |
| `any.total` | 166 | 131 |
| `npm test` (unit tests) | 920 | 998 |

The worst functions this part reshaped, CCN before → after:

| Function | Before | After |
|---|---|---|
| `buildExportManifest` | 61 | under 5 (largest phase `buildAnalysisViewEntity`, 8) |
| `runGitRevisionExport` | 46 | 8 (largest step `assembleGitData`, 10) |
| `GitRepositoryService.listReferences` | 26 | under 6 (largest parser 8) |
| `materializeDirectory` | 19 | under 8 (`planDirectorySnapshot`, 10) |
| `relativizeExportArtifacts` | 18 | under 7 |
| `validateExportPackage` | 16 | 5 |

The worst TS function in the repository is now CCN 22: `handleDependencyGraphSettingsMessage`, a part B row. No function exceeds CCN 30. `gitRevisionExportCore.ts` stays under 500 lines (490), so `size.filesOver500` did not move.

## Gates

- After every commit: `npm test` (typecheck, lint at the current budget, compile-tests, unit tests).
- After every refactor that touched the analysis pipeline or export: `npm run test:analysis` as well.
- T05 and T06 (types only): the H1 check. `dist/extension.js` was byte-identical before and after (`CODEXR_NO_SOURCEMAPS=1 npm run package`, sha256 `b4e639a0be8e…`). T06 also ran `npm run test:python` (73/73).
- The new tests are platform-agnostic: temp roots go through `fs.realpathSync.native`, and paths are compared with `path.join` or as forward-slash relatives. The listReferences, materializeDirectory and runGitRevisionExport characterizations stub git, so no git process runs. The preflight test needs `git` on PATH, like the existing gitRevisionExporter tests.

## New characterization files

- `test/analysis/executePythonResults.test.cjs`: a fake backend (node scripts as the interpreter).
- `test/analysis/activeAnalysesPresentation.test.cjs`
- `test/analysis/dimensionValidator.test.cjs`
- `test/utils/uriPathConverter.test.cjs`
- `test/directory_analysis/directoryReAnalyzer.test.cjs`
- `test/analysis/dependencyFileScope.test.cjs`
- `test/visualize_data/dimensionFieldMapping.test.cjs`
- `test/analysis/exportManifestSnapshot.test.cjs`: whole-manifest snapshots compared as serialized JSON, so the key order and the entity order are pinned.
- `test/analysis/gitRevisionExportPhases.test.cjs`: a fake Git service.
- `test/analysis/gitListReferences.test.cjs`
- `test/analysis/gitMaterializeDirectory.test.cjs`
- `test/analysis/exportPackageValidation.test.cjs`
- `test/analysis/gitExportPreflight.test.cjs`

## Deliberately not touched

- **T10 and T21**: already landed in #38.
- **T29-T33 and T36-T59**: part B, on another branch.
- **ROADMAP §D.8 items**: not touched, per the brief.
- **No file moves and no idiom sweeps**: those belong to stories #55 and #56.
- **`classifyIndexedRevision` in `gitAnalysisEligibility.ts`**: T22 says not to touch it. It classifies indexed revisions, not error messages.
- **`private parsePythonOutput(stdoutData: string): any {`**: kept verbatim, because `livePanelDomIntegration.test.cjs` pins it. T06's `PythonPayload` alias covers the rest of the file's `any`s.
- **Classifier disagreements in `classifyExportRevisionFailure`**: the code regex and the stage regex disagree on some messages. Both were moved verbatim (see quirks).
- **Shape pins retargeted, never dropped**: in T08, the `generatedFiles.set(NAME, var)` pins in `virtualScreenRuntime.test.cjs` and `xrDataSource.test.cjs` became `[NAME, readXContent]` pair pins.

## Behaviour quirks (record only, candidates for 1.3.0)

1. **Session tree item dropped:** a session whose `targetPath` is not a string and that has no `targetName` makes `path.basename` throw, and the item is skipped from the Active Analyses tree.
2. **Status-bar count:** the directory re-analysis count is the size of the change set, not the number of files that actually changed.
3. **Missing-asset error after T08:** the directory XR assets are now read in `.set()` order. This only changes which missing asset an error names when several are missing.
4. **Unresolved `file://%zz`:** under the fake vscode, it resolves to `null` and the editor fallback is used.
5. **Replay list without the server capability:** the export manifest fills `historicalComparison.comparisons` even when the server lacks the historical capability. The entity is still withheld.
6. **"0 revision source(s)":** a partial git export without a skip list reads "Partial export: 0 revision source(s) could not be prepared."
7. **Regex disagreements:** the export classifier's code and stage regexes disagree on:
   - `git-revision-target-missing`: target-missing, at the analysis stage;
   - `…no-analyzable-content` and "no data records": no-analyzable-content, at the analysis stage;
   - "exceeds the configured": limit-exceeded, at the analysis stage;
   - "rate limit": analysis-failed, at the index stage.
8. **Progress increment:** each exported revision reports a progress increment of `10/total`, so the export step always adds up to 10, whatever its real share of the work.
9. **Size-less ls-tree entry:** an entry whose size is `-` is reported as an "oversized file" when snapshots are materialized.

## F5 checks for the maintainer

None of these changed on purpose. They exercise the reshaped code end to end.

1. **XR scene:** Analyze a file in XR and a directory in XR (with and without deep analysis). Both scenes load, and editing a file re-analyses it (T01-T04, T07-T09, T15).
2. **LivePanel and DOM:** run a LivePanel and a DOM analysis of a file. Both open and refresh (T04, T06).
3. **Active Analyses tree:** check the icons, colours and tooltips for file and directory sessions (T11).
4. **Visualize Data:**
   - Pick a chart and a JSON file.
   - Map a field already used by another dimension. The warning names that dimension.
   - Check that the validation messages match 1.2.0 (T12, T13, T18).
5. **Dependency graph:** open a file's dependency scope twice, then edit the file and open it again (T17).
6. **Export Analysis Folder:**
   - Export an XR directory analysis with all modes selected and with "latest N" commits.
   - Serve the copy and open the dependency graph, a historical comparison and a project evolution movie.
   - Export again with only Normal selected. The copy must open in Single.
   - Check `codexr-export-manifest.json`, `git-revisions/` and `README-EXPORT.md` (T19-T28, T34, T35).
7. **Historical comparison:** compare two branches and a tag in a repository with a merge commit and a remote branch, then compare a nested folder (T25, T26).

## CHANGELOG

No entry: nothing here is user-visible.
