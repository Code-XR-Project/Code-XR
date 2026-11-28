# Drill-down (XR)

Analyse any file or folder of the analysis from inside the XR scene, in place
(mode id `drill-down`, controller view `single.mapping`, accent `#0ea5e9`; epic
#333, stories #334-#340). The person picks a building (a file) or a district
(a folder) of the chart on the table, presses **Analyze file** or **Analyze
folder**, and the table switches to the analysis of that target on the same
server: no new session, no new server, no page reload, so an immersive
session survives the jump. A breadcrumb bar climbs back up. Manual test guide:
`docs/drill-down/test-guide.md` (repository root).

## Pipeline

```
scene click ──► inspector card ──► drilldown-open {path, kind} ──► DrillDownService
                                                                     │ history (back / forward / home)
                                                                     │ per-file cache by content hash
                                                                     ▼
            drillDownRuntime.js ◄── room entity `drill-down` ◄── drilldown/drill-<rev>.json
            (drilled chart, bar,     + analysis-view mode switch
             loading card)             ('drill-down' or 'single')
```

| Layer | Where | Notes |
|---|---|---|
| Models | `src/core/drilldown/drillDownModels.ts` | `DrillDownEntity` (the room entity), `DrillCrumb`, `DRILL_DOWN_MESSAGES`. No imports |
| Paths | `drillDownPaths.ts` | The boundary root (the deepest workspace folder holding the analysed target, else the target folder), scene path resolution (absolute first, then relative; never outside the root), crumbs |
| History | `drillDownHistory.ts` | Home is always the first entry; 50 entries; a new jump drops the forward stack; Home is a move like any other, so Back returns to the drilled target |
| File cache | `drillDownFileCache.ts` | One entry per file: value, size, mtime, SHA-256. Unchanged size and mtime: reused without reading the file. Otherwise the hash decides, so a touch without an edit costs a hash, not a Python run. Same rule as `FileHashTracker` in the live re-analysis |
| Datasets | `drillDownDatasetBuilder.ts` | Seeds the cache with the session's own rows (`data.json`) and the hashes the session tracks (`filesToHash`): files of the project analysis are never analysed again. A folder lists its files with the analyzer's own policy (`scanDirectoryScope`), sends only stale ones to Python in batches of 80 (`file_reanalysis_coordinator.py`, the per-file summaries of the incremental re-analysis) re-roots `relativePath` at the folder and adds `drillPath` (`<folder>/<relativePath>`, the tree path). A file runs the XR file analysis (function rows), cached by hash too |
| Service | `drillDownService.ts` | One per server. Owns history, caches and datasets (`<staticRoot>/drilldown/drill-<rev>.json`, keeps the previous one for slow peers). Publishes `loading` only when a jump takes longer than 150 ms. A refused or failed jump puts the history back and reports on the bar; the table keeps what it showed |
| Room bridge | `src/core/server/analysis/drillDownBridge.ts` | `drilldown-open`, `drilldown-goto`, `drilldown-back`, `drilldown-forward`, `drilldown-home`, `drilldown-state-request` → `drilldown-error` to the requester. Any peer may drive it, like the mode selector: it only reads the project |
| Host wiring | `drillDownHostWiring.ts` (`wireDrillDown`, one slot in `AnalysisFeatureHost`) | XR only (`drillDown` server feature). The Python runner and the configured chart defaults (Analysis settings). A re-analysis (save) refreshes the drilled view after 300 ms. The Analyses menu leaving `drill-down` for `single` makes home current |
| Host entry | `sceneDrillDown.ts` (`drillDownInScenes`) | "Code-XR: Analyze in XR Scene" in VS Code (`analyzeInSceneCommand.ts`) and in the IDE: every running scene whose boundary holds the path switches to it |
| Browser runtime | `templates/components/codexr/drill-down/drillDownRuntime/` | Multi-part runtime assembled to `drillDownRuntime.js`, loaded after `agentFlowRuntime.js` |

All of `src/core/drilldown/` is vscode-free and uses erasable TypeScript only:
the IDE imports it as `@codexr/core/drilldown/*`.

## The scene

- **Inspector card.** A scene-level click listener resolves the picked
  element's `babiaRawData` (walking up to the first element that has it,
  without leaving the chart): a building of a folder analysis is a file, a
  district is a folder, a building of a file analysis is a function. The card
  floats above the chart's highest point, turned toward the viewer, with
  **Analyze file**, **Analyze folder** (the file's own folder for a file) and
  **Open in editor**. Targets outside the boundary root are refused on the card.
- **Drilled chart.** Its own root (`codexrDrillDownRoot`), built with the
  declarative builders of the mapping UI. The classic chart is parked, never
  removed, so Home is instant. A folder's tree is built on `drillPath`,
  so the city starts at the folder (its one top district, which keeps files
  at the folder's top level inside a district) instead of climbing every
  level of the absolute path; its tree uids are namespaced (`drill-down:`) because boats
  ids its entities after them and the parked chart has the same paths.
- **Breadcrumb bar.** Hangs on the table's front edge, its top under the
  tabletop so it never hides the chart. Back, Forward, Home, then the crumbs:
  the root and the current target always show, the middle collapses into one
  `...` crumb that jumps to the deepest hidden ancestor. One status line:
  `53 files: all up to date, nothing analysed.`, `57 functions: freshly analysed.`
- **Loading card.** Over the table while the server analyses, with the elapsed
  time (text, not motion: it ticks under reduced motion too).
- **Controller.** The table keeps the analysis controller (`single.mapping`,
  mapping context `normal-analysis`): the drilled chart is drawn with the
  controller's chart type and metrics, and a change there rebuilds it (the
  mapping UI delegates the entity apply in mode `drill-down`, as it does for
  project evolution, and the runtime redraws on `codexr-mapping-confirmed`).
  When the drilled rows do not have the session's schema (the functions of
  one file in a project analysis) the chart keeps the server's mapping and the
  controller is locked with the reason. Home restores the classic analysis as
  it was. Navigation lives on the bar only.
- **Card metrics, no Babia legend.** A building's card lists its height, area
  and colour metrics with their values, read from the chart's own mapping.
  Babia's hover/click legend is hidden (and shrunk) while the card can open,
  because it covered the card.

The `drill-down` entity is passive (COMPONENTS.md): it carries data, never
intent. The server switches the room's mode through `analysis-view`, and the
runtime draws only while its mode is active. A late joiner replays the entity;
a scene that joined before any jump asks for it with `drilldown-state-request`.

## Limits

- The inspector needs a chart that hangs `babiaRawData` on its entities:
  boats (the default for both analyses) and the other hierarchical charts.
  Flat charts draw the drilled data but offer no card.
- **Open in editor** reaches files inside the session's analysed folder only
  (`editorNavigation`).
- Drill-down is XR-only; LivePanel and DOM analyses do not carry it.

## Tests

- `test/analysis/drillDownCore.test.cjs`: paths, crumbs, history, the file
  cache, the service end to end over real files with a fake analyzer (only
  new or changed files reach it), the bridge, the host entry and the wiring
  through the real refresh coordinator.
- `test/analysis/drillDownRuntime.test.cjs`: target resolution, crumb layout,
  status lines, the inspector's actions and the messages they send.
