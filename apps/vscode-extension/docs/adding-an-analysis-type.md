# Adding an analysis type

An **analysis type** is *what* the analysis table shows: the classic chart,
the dependency graph, the historical comparison, the project evolution. A
**launch kind** is *how* a page is produced and served for a target: an XR
scene, a LivePanel webview, a DOM visualization. Since 1.2.1 (S5, issue #77)
both are declared once, as descriptors, and the host tables that used to
restate them are derived.

| Descriptor list | File | Read by |
|---|---|---|
| `ANALYSIS_TYPES` | `src/core/analysis/launch/analysisTypes.ts` | server features per surface (`core/server/analysisServerCapabilities.ts`), the default controller view per mode (`core/analysis/refresh/analysisViewModes.ts`, also used by the export manifest), the room-cache probes of the collaboration router (`core/server/analysis/analysisMessageRouter.ts`) |
| `LAUNCH_KINDS` | `src/core/analysis/launch/launchKinds.ts` | `AnalysisOrchestrator` (dispatch through `resolveLauncher`) |
| `ANALYSIS_STORAGE_FOLDERS` | `src/core/analysis/launch/storageFolders.ts` | the launchers (where to write) and startup cleanup (what to sweep) |

## Checklist: a new in-scene analysis

1. **Descriptor.** Add an entry to `ANALYSIS_TYPES`: `id` (also the
   coordinator mode and the browser runtime id), `label`, `controllerView`,
   `serverFeature` (or `null`), `surfaces`, and a `snapshotProbe` if the room
   can replay its result from a cached entity. Keep the file import-free: the
   export manifest requires it from `out/` without a vscode stub.
2. **Server feature** (only if it needs endpoints). Add the name to
   `AnalysisServerFeature` and a boolean to `AnalysisServerCapabilities`, then
   attach the service where the existing ones are attached (follow
   `projectEvolution` through `core/server/analysis/analysisFeatureHost.ts`).
   A service that resolves an XR-only session must only be listed on the
   surfaces that serve it, or it aborts every other launch.
3. **Browser runtime.** Register the mode in the analysis-mode runtime
   (`templates/components/codexr/analysis-mode/`) with the same `id`, and add
   its view to `MODE_CONTROLLER_VIEW_BY_ID` there.
   `test/analysis/controllerViewMapSync.test.cjs` fails until the browser map
   and the descriptors agree. Respect the load order in
   `templates/components/COMPONENTS.md` and rebuild the assembled runtimes
   (`node test/manual/buildAssembledRuntimes.cjs`).
4. **Chart.** Build and rebuild its chart through the analysis-table
   containment (`beginRebuild` → fit → reveal) and read rows through a
   row-budgeted slice (`prepareChartDataSlice`), never the raw source; see
   "Rebuild and reveal (1.2.1)" in `COMPONENTS.md`.
5. **Tests.** Extend `test/analysis/launchTransaction.test.cjs` ("the host
   tables derived from the analysis types are unchanged") with the new row,
   plus the capability test (`analysisServerCapabilities.test.cjs`) if it
   attaches a feature.

## Checklist: a new launch kind

1. Add the id to `LaunchKindId` (`analysisTypes.ts`) and to `AnalysisMode`.
2. Write a launcher that builds a `LaunchPipelineConfig` and calls
   `executeLaunchPipeline` (see `launchers/launcherLivePanel.ts`). Do not start
   a server or a watcher yourself: the pipeline starts the server, then the
   watcher, and owns their teardown.
3. Add a folder to `ANALYSIS_STORAGE_FOLDERS` and pass it as `folderName`
   (never a string literal: the cleanup test checks it).
4. Add the descriptor to `LAUNCH_KINDS` with one launcher per supported target
   type; an unsupported combination is refused by `resolveLauncher` with a
   message that names it.
5. List the kind in the `surfaces` of the analysis types it serves.

## What the pipeline guarantees

Every launch runs as a transaction under `LaunchControl`
(`launch/launchControl.ts`):

- one session per target: the registry reserves the target **before** its
  first `await`, and compares targets through `targetKey()` (resolved, no
  trailing separator, case-folded on Windows and macOS);
- steps run in order pre-validation → analysis → save → server → watcher, and
  each step that starts something records how to undo it;
- a failure, the 10-minute deadline or **Close Analysis** aborts the launch,
  kills a running Python analysis, and undoes the started steps newest first,
  exactly once. A closed launch shows nothing; a failed one shows one error;
- the server's live channel and file mapping are keyed by the session id, so
  two sessions on the same file never cross their live reloads.
