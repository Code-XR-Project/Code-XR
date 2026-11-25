# Session log: #38 — unify the historical comparison, project evolution and export services

Date: 2026-11-25. Branch `claude/project-thread-n2s3q6-git-services`, cut from `origin/v1.2.1` at `9c52ca85`. Story: Code-XR-Project/Code-XR#38. Rows: ROADMAP W5-01..W5-11 with the §E overrides, plus their prerequisites T21 and T10.

## Commits

| Commit | Subject | Row |
|---|---|---|
| `34dc636a` | refactor(export): pure analysisViewModes table; exportManifest consumes it | T21 |
| `661c4170` | test(active-analyses): characterize the session prelude and the close outcomes | T10 (test first) |
| `83589398` | refactor(active-analyses): session-resolution prelude helper | T10 |
| `b9a61a3b` | test(historical): behavioural characterization of both services and bridges | W5-01 |
| `df6b210f` | refactor(historical): one toPortableRelativePath and one analyzer cache key | W5-02 |
| `65523362` | refactor(analysis-bridges): shared reference and error replies | §E (bridge replies) |
| `cecef1eb` | refactor(historical): GitAnalysisSessionContext and SingleJobGate, by composition | W5-03 |
| `037a9c0f` | chore(historical): delete the unreachable missing-target guard | W5-04 |
| `379b9375` | refactor(historical): shared analyzeSource with an explicit missing-target policy | W5-05 |
| `aeac4f75` | refactor(historical): one directory decorator for every Git mode | W5-06 |
| `ff999726` | chore(historical): drop the redundant re-validation in the evolution worker loop | W5-07 |
| `64ff1272` | refactor(historical): executeEvolution phases 2 and 4 as named methods | W5-08 |
| `80a01eaf` | test(router): characterize analysis-mode-activate per mode and snapshot | W5-09 precondition |
| `726c61fa` | refactor(router): mode activation reads a snapshot probe table | W5-09 |
| `cf21a1b5` | test(export): pin the Export Analysis Folder wizard order positionally | W5-10 |
| `1272f0a1` | refactor(export): exportFolder wizard as named steps with a discriminated Git prompt | W5-11 |

## Shape of the result

- **Composition, not a base class (§E).**
  - `src/code_analysis/historical/gitAnalysisSessionContext.ts` holds:
    - `GitAnalysisSessionContext`: the source catalogue (owned or injected), the per-commit payload cache, `analyzeSource` with a `GitRevisionAnalysisPolicy` (cache version, error code, session-id infix, metadata key, missing-target `throw` or `cache-empty`, decorator), `excludeSource` and `dispose`;
    - `SingleJobGate`: a busy code, one job at a time, and the last successful request.
  - Each service keeps its constructor wiring, `getAvailability`, `getSession` and `filterSources` in its own file, because tests pin their text.
- **Pure helpers** in `src/code_analysis/historical/gitAnalysisShared.ts`: `toPortableRelativePath`, `decorateDirectoryEntries` and `buildAnalyzerCacheKey`. The export core (`gitRevisionExportCore.ts`) uses the same two helpers, so all three Git consumers decorate directory payloads identically.
- **Bridge replies** in `src/servers/runtime/analysis/analysisBridgeReplies.ts`: the filtered-references broadcast, the references reply and `describeBridgeError`.
- **W5-04** has its dataflow argument in the commit, plus the precondition test in `gitHistoryServices.test.cjs`: a missing target never reaches the historical decorator, because `analyzeSource` throws first.
- **W5-07** applies the same argument to the evolution worker loop. `analyzeSource` only ever returns a missing target or `requireUsablePayload`'s records, so the second validation could never reject a payload. A precondition test covers it.
- **W5-08** extracts phases 2 (the worker pool, with both cancellation checks) and 4 (the artifact writer) only. Phases 1 and 3 stay inline.
- **W5-09**: `SNAPSHOT_PROBE_BY_MODE` plus `defaultControllerView` (T21). The pinned `allowsEmptyShell` text is kept verbatim.
- **W5-11**: `exportFolder` is now the wizard only. `promptGitExportRequest` returns `{ kind: 'cancelled' } | { kind: 'request', request }`. The other steps follow it in call order:
  - `confirmGitExport`
  - `promptGitRevisionScope`
  - `chooseExportDestination`
  - `writeExportPackage`
  - `completeXrExport`
  - `exportGitTimeline`
  - `reportExportPublished`

  Placement constraint: `canPickMany: true` still precedes `openLabel: 'Select Export Destination'`.

## Measurements

**Duplication method** (reproducible):
1. Normalize each line of both files: strip it, collapse whitespace, and drop blank, comment-only and bracket-only lines.
2. Count the lines of file A that fall inside a window of 4 consecutive normalized lines that also occurs, as a sequence, in file B.

| Measure | Before (`9c52ca85`) | After |
|---|---|---|
| historical ↔ evolution service, duplicated lines (window 4) | 146 | **18** (target ≤ 25; 99 after W5-03, 29 after W5-05, 22 after W5-06) |
| historical ↔ evolution bridge, duplicated lines (window 4) | 33 | 19 |
| `historicalComparisonService.ts` lines | 507 | 335 |
| `projectEvolutionService.ts` lines | 668 | 499 |
| new: `gitAnalysisSessionContext.ts` / `gitAnalysisShared.ts` / `analysisBridgeReplies.ts` | - | 269 / 104 / 82 |
| `analysisMessageRouter.ts` lines | 136 | 129 |
| `activeAnalysesCommands.ts` lines | 685 | 783 (`exportFolder` CCN 44 → 7; the steps are named methods) |
| guardrail `size.filesOver500` | 18 | 16 |
| guardrail `functions.over80Lines` | 57 | 52 |
| guardrail `complexity.over10 / 15 / 20 / 30` | 81 / 31 / 10 / 6 | 77 / 29 / 9 / 5 |
| unit tests | 720 | 782 |

The brief's "about 95" duplicated lines came from a different tool. The window-4 method above counts more, because it also matches short shared runs. Compare before and after by the same method.

## Gates

- `npm test` was green on every commit (782/782 on the last one before the merge).
- `npm run test:analysis` was green after W5-02, W5-06 and W5-11 (24 root fixtures, 3 deep).
- `npm run test:project-evolution-harness` **could not run its browser scenario in this container**, for two reasons:
  1. The pinned Playwright expects chromium 1228, but the image ships 1243. This was worked around with an aliased `PLAYWRIGHT_BROWSERS_PATH`.
  2. The page then cannot load A-Frame/BabiaXR from aframe.io/unpkg (proxy 403).

  The harness never loads the services, so the gate for W5-08 is the unit characterization in `test/analysis/gitHistoryServices.test.cjs`. That file covers progress messages, frames, artifacts, exclusions, cache counts and clear.

New behavioural suites:
- `test/analysis/analysisViewModes.test.cjs`
- `test/analysis/activeAnalysesCommands.test.cjs` (prelude, close outcomes, export wizard order)
- `test/analysis/gitHistoryServices.test.cjs` (both services and both bridges, against a real fixture repository)
- `test/analysis/gitAnalysisShared.test.cjs`
- `test/analysis/analysisMessageRouter.test.cjs`

## Deliberately not done

- **W2-29** (dead types in `historicalComparisonModels.ts`) and **W2-39** (`clearActiveComparison`) belong to the parallel dead-code worker. `clearActiveComparison` now delegates to `this.jobs.forgetLastRequest()`. If W2-39 lands first, resolve the conflict by deleting the method.
- **The file-branch decorators stay per service.** Historical and evolution add different keys and the export core decorates both. Only the directory branch had byte-identical logic.
- **`requireUsablePayload` was not made a free function.** The audit proposed one, but it needs the policy's error code and the catalogue's exclusion, so it lives in the context.
- **`getReferences` / `filterSources` / `getAvailability` / `getSession` and the constructor wiring stay per service**, because tests pin their text (§E).
- **The historical service keeps the private getters `sourceCatalog` and `activeRequest`.** They are text-pinned (`livePanelHistorical.test.cjs:78`, `historicalComparison.test.cjs:237`). The evolution service reads `this.analysis.sourceCatalog` / `this.jobs.lastRequest` directly to stay under the 500-line ratchet.
- **The evolution bridge's clear and apply-frame handlers** keep their own error replies, because their messages differ from the reference and start paths.
- **No CHANGELOG line**: every change is internal and behaviour-neutral.

## Quirks for 1.3.0

- In `gitRevisionExportCore.ts`, `decorateRevisionPayload` still decorates file payloads with both `comparisonKey` and `evolutionKey` inline. A file-branch helper could join `decorateDirectoryEntries` once the two services' file keys are reconciled.
- `activeAnalysesCommands.ts` is now 783 lines. Its export wizard could move to its own module (`exportFolderWizard.ts`), but that changes the haystack of `activeAnalysesActions.test.cjs`, which reads this one file by path.
- The project-evolution harness needs CDN access (or vendored A-Frame/BabiaXR) and a Playwright that matches the image's chromium before it can be a gate in this kind of container.

## F5 checklist (manual, before merge)

Run "Run CodeXR Extension", then on a Git project folder:

1. **Historical comparison**
   - Start an XR directory analysis and enter Historical comparison: the selection panel lists branches, tags, commits and the working copy.
   - Compare two commits: boats appear, the mapping view opens, and progress messages read as before.
   - Re-enter the mode from the menu: it opens on mapping with the cached result.
   - Start a second compare while one runs: you get the "busy" reply.
2. **Project evolution**
   - Generate a movie over 3 or more commits: progress reads "Analyzing N project revisions with C workers".
   - Frames play, and `dataN.json` / `data.json` / `manifest.json` sit in `evolution/revision-N/`.
   - Clear the movie: the room returns to the empty shell. Generate again: the revision number increments.
3. **Export Analysis Folder**
   - From Active Analyses, export with all modes and choose "latest N" with N=5 and Balanced.
   - The confirmation reads "Historical comparison and Project evolution will export 5 Git commits plus the working copy using W persistent workers." Continue Export, then pick the destination.
   - The exported folder has the same layout as a 1.2.0 export (`git-revisions/`, `dependencies/`, `manifest`, README).
   - Cancel mid-way: "Analysis export cancelled. No partial folder was published."
   - Export to an existing folder: the "already exists" warning appears.
