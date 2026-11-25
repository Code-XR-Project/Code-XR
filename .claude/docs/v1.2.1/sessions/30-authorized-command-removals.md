# Session log — #30 Remove the scaffold, debug and unreachable commands (W2-45..W2-52)

> Date: 2026-11-25 · Branch: `claude/project-thread-n2s3q6-commands` (cut from `origin/v1.2.1` at `399494af`, merged `origin/v1.2.1` at `cd05e03e` after W2-48) · Story: Code-XR-Project/Code-XR#30
> Authority: ROADMAP.md §B decision 2 (maintainer, 2026-09-18); feature-baseline register R1-R4. Amendments from `docs/cleanup/w2-revalidation.md` applied.

## Commits

| Row | Commit | Subject |
|---|---|---|
| W2-45 | `532270fb` | refactor!(commands): remove 11 superseded analysis-setting setter commands |
| W2-46 | `120557a4` | refactor!(commands): remove two never-wired files-by-language commands |
| W2-47 | `0571309c` | refactor!(commands): remove cleanAnalysis; keep the startup cleanup helpers |
| W2-48 | `8fca6497` | refactor!(commands): remove visualizeData.debugState and handleDebugState |
| — | `7ac81904` | merge origin/v1.2.1 (PR #44: feature-baseline test, Linux test fix) |
| W2-49 | `ae17c649` | refactor!(commands): remove the two debug theme commands and debugThemeProblem.ts |
| W2-50 | `9f20646c` | chore!(commands): remove the Hello World scaffold command |
| W2-51 | `744b2f01` | fix(manifest): hide debugFailInstallation from the Command Palette |
| W2-52 | `c3d032f2` | chore(manifest): drop the redundant "when": "true" on the codexrTree view |

Amendments carried: W2-45 also deletes the orphaned private handlers `setAnalysisFileMode`, `setViewTheme`, `setAutoAnalysisEnabled` (`setAutoAnalysisDelay` stays, the QuickPick calls it). W2-46 also drops the `WorkspaceSnapshotService` import and the now-unused `refreshCallback` parameter (caller updated). W2-47's "comment at :42" sub-item is moot; `executeCleanAnalysis` and `cleanAllAnalysisDirectories` went with the command, and the collector call/import in `analysisCommands.ts` too.

## Measurements (before → after)

| Metric | Before | After |
|---|---|---|
| Contributed commands (`package.json`) | 70 | **69** |
| `commandPalette` menu entries | 11 | 12 (debugFailInstallation hidden) |
| Palette-visible debug/scaffold commands | 2 (helloWorld, debugFailInstallation) | **0** |
| `commands.internalByKind.pending-removal` | 17 | **0** (list empty) |
| Legacy aliases `codexr.servers.refresh` / `refreshServers` | kept | kept |
| `console.total` | 1646 | 1589 |
| `catch.consoleOnly` | 65 | 61 |
| `filesOver500` | 19 | 18 (visualizationLauncher.ts) |
| `reachability.unreachable` | 54 | 55 (waiver, see below) |
| `src.files` / `src.functions` | 369 / 2864 | 368 / 2833 |
| `dist/extension.js` (prod, no sourcemaps) | 1,257,156 B | 1,244,661 B (−12,495) |

Per-commit H2 reviews (token diff of the minified bundle) are in each commit message: every inserted fragment is an existing statement re-emitted with re-minified identifiers or module ids.

## Gates

`npm test` after every commit: 708/709 before the merge (only the known `gitRevisionExporter.test.cjs:579` Windows-path failure), 715/715 after merging PR #44. `npm run guardrails:update` in every commit that moved a metric. Production build per commit. No Python, template or asset change, so `test:python`, `test:analysis`, harnesses and `package:vsix` were not required. W2-51 regenerated `test/baseline/featureBaseline.snapshot.json` (+1 menu entry, nothing dropped).

## Deliberately not touched

- **Waiver in W2-47**: `src/code_analysis/commands/clean_analysis/index.ts` became unreachable (its only live importer was the removed collector call; `extension.ts` imports `cleanAnalysisCommands.ts` directly). It is re-exported only by `code_analysis/commands/index.ts`, an unreachable barrel in W2-05 (parallel story), so deleting it here would have edited that story's file. Delete the barrel together with W2-05 and drop the waiver then.
- `V1.2.1_STATUS.md` backlog item #3 (debugThemeProblem) and `V1.2.0_STATUS.md` documentation-debt entries (helloWorld): status/history docs, left to the status owner. Line-level drift fixed: cleanup `SKILL.md` traps line, `AI_WORKFLOWS.md:43`, `DEVELOPMENT.md` helloWorld bullet.
- The empty "pending removal" section comment in `internalCommandIds.cjs` stays as the slot for future entries; the kind is still documented and accepted by the contract test.
- Public setters on the setting classes (`AnalysisFileSetting.setMode`, `ViewThemeSetting.setTheme`, `AutoAnalysisEnabledSetting.setEnabled`) were not traced further; they may now have fewer callers (W2-23 `noUnusedLocals` does not flag public methods). Record-only.

## Quirks (record-only for 1.3.0)

- `codeXR.pythonEnv.debugFailInstallation` is now contributed but reachable from nowhere (palette hidden, no menu, no tree item). Decide in 1.3.0 whether it should be gated behind `ExtensionMode.Development` or removed.
- The guardrail ratchet drops a `commands.internalByKind` key at 0, so a future first `pending-removal` entry compares against `undefined`; `measureGuardrails.cjs:429` reports it as "moved", not "worse".

## F5 checks for the maintainer

1. Start the Extension Development Host with stale folders in the workspace storage `analysis/` dir (older than activation): they are removed at startup (`executeStartupCleanup`, extension.ts:99), and a fresh analysis started right after activation is not.
2. Command Palette, type "Hello", "Debug", "CodeXR": no "Hello World", no "Debug Python Environment Failure", no theme debug commands.
3. Analysis settings rows still work: toggle file mode (XR/LivePanel), toggle view theme, toggle auto-analysis, pick an auto-analysis delay (incl. custom); watchers pick the new delay up.
4. Files by Language: clicking a file opens and analyzes it; adding a file refreshes the list.
5. Visualize Data: pick chart + JSON, map dimensions, launch.
6. The CodeXR activity-bar view still renders (W2-52).
