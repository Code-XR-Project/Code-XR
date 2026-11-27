# Session log: #35 part B — de-duplicate the TypeScript bridge, settings and server code; floating promises to zero

Date: 2026-11-25. Branch `claude/project-thread-n2s3q6-ts-dedup`, cut from `origin/v1.2.1`, with `origin/v1.2.1` merged in once after #42 (PR #60) landed (`a8b4597d`). Story: Code-XR-Project/Code-XR#35 (epic #26), part B. Rows: ROADMAP W4-T T29–T33 and T36–T59, with the §E overrides. Part A (T01–T28, T34, T35) is a separate branch.

## Commits

| Commit | Subject | Row |
|---|---|---|
| `61f20cc4` | test(bridge): characterize the dependency-graph settings and start handlers | T29–T30 (test first) |
| `b2a61b64` | refactor(bridge): hoist six Sets and sanitizeDependencyScope, with a hostile-scope table | T29 |
| `2af7de22` | refactor(bridge): dependency start defaults table with a deepEqual snapshot | T30 |
| `44fb2623` | refactor(historical): references field becomes a local | T33 |
| `88d1b95b` | chore(types): de-export the six file-private dependency-graph model types | T36 (partial) |
| `a776f80e` | test(profile): characterize the Load Profile and Delete Profile commands | T37 (test first) |
| `f9f42dd4` | refactor(profile): one listStoredProfiles for the load and delete commands | T37 |
| `54347f59` | test(launchers): characterize the LivePanel and XR pipeline closures | T38 (test first) |
| `9aaa413a` | refactor(launchers): per-file helpers for the four throwing pipeline closures | T38 |
| `801c328e` | refactor(settings): accessors reuse settingsStorage path and key | T39 |
| `1051c6f9` | refactor(settings): one accessor pattern, single read | T40 |
| `775f237f` | refactor(types): rename the colliding VisualizationSettings | T41 |
| `c9358d20` | refactor(types): the orchestrator imports the canonical AnalysisMode and TargetType | T42 |
| `57c74a1b` | refactor(commands): rename the shim class ActiveAnalysesCommands | T43 |
| `4f4358ac` | test(active-servers): characterize the command registrations and handlers | T44 (test first) |
| `cd475f73` | refactor(active-servers): registration table for the server-id commands | T44 |
| `20db83a9` | test(chart-type): characterize the file and directory chart-type commands | T45 (test first) |
| `adbe122b` | refactor(chart-type): command factory, both dialects verbatim | T45 |
| `c7986537` | chore(assets): un-export the six resolve/assert helpers nothing else reads | T46 (narrowed) |
| `645ed03c` | test(assets): characterize the two embedded single-file runtimes | T47 (test first) |
| `946a93bb` | refactor(assets): shared assertSourceExists | T47 |
| `a8b4597d` | merge origin/v1.2.1 (#42 layering) | — |
| `93cda790` | test(network): characterize the three unguarded LAN URL sites | T48 (test first) |
| `8f20167c` | refactor(network): LAN URL at the three unguarded sites | T48 |
| `aedf491a` | refactor(active-servers): one remote-manager guard | T49 |
| `15643abb` | test(servers): characterize the extension-context guard | T51 (test first) |
| `146fbe53` | refactor(servers): requireExtensionContext helper | T51 |
| `a707a8ca` | test(servers): characterize the two server-config readers | T52 (test first) |
| `24b36283` | refactor(servers): one getServerConfig | T52 |
| `bc9e493e` | refactor(collaboration): derive the room's avatar ids from the model | T53 |
| `84b67ea4` | refactor(promises): explicit void in code_analysis | T56 |
| `8eb2d2d5` | refactor(promises): explicit void in the server modules | T57 |
| `eafa91d5` | refactor(promises): explicit void in the view and data modules | T58 |
| `37da8bfe` | refactor(promises): explicit void in the remaining modules; no-floating-promises is an error | T59 |

Each characterization test landed in its own commit before the reshaping, and was green against unchanged source. T53 relies on the net that already existed, `test/collaboration/avatarIdSync.test.cjs`, which probes the room's accepted ids by their behaviour. The `void` sweeps are S-class: an expression-statement `void`, with no text pin on those lines.

## Rows not done here, and why

- **T31, T32**: #38 already did these (`analysisBridgeReplies.ts`).
- **T50**: #39 already did this.
- **T54**: deferred to 1.3.0, as the brief asks.
- **T36**: partial. Six file-private types lost `export`, and H1 showed the dist was identical.
  - Three dependency types are not used anywhere: `DependencyGraphLayout`, `DependencyGraphScope` and `DependencyEdgeEncoding`. Removing them is a dead-code row, not a de-export.
  - The five `gitRevisionExportCore` interfaces belong to part A.
- **T46**: narrowed to six helpers. Fourteen of the twenty now have test consumers, so they stay exported.
- **T42**: only the orchestrator half. #40 had already done the chart-type half.

## Measurements

| Measure | Before (`origin/v1.2.1`) | After |
|---|---|---|
| ESLint `--max-warnings` | 553 | 261 |
| `no-floating-promises` | 284 warnings | 0, and the rule is now an `error` |
| `suppressions.total` | 0 | 0 |
| Unit tests | — | 975, all passing (nine new characterization files, plus one lint-contract test) |

- The guardrail baseline was lowered in the same commit as each drop.
- `complexity.over10` and `functions.over80Lines` never rose: T29, T30 and T57 were each reshaped until the ratchet passed.
- `npm run test:analysis` was green at the end.

## Floating promises (T56–T59)

284 statements were marked with an explicit `void`, one commit per module group:

| Row | Modules | Statements |
|---|---|---|
| T56 | `code_analysis` | 106 |
| T57 | `servers`, `active_servers`, `remote_access` | 85 |
| T58 | `views`, `visualization_settings`, `visualize_data`, `babia_examples` | 78 |
| T59 | `python_env`, `learn_more`, `extension.ts` | 15 |

What was voided:

- **243** notification toasts.
- **22** command dispatches.
- **6** `openExternal` calls.
- **5** constructor `loadSaved*()` calls. Their bodies catch the error and fall back.
- **1** `refresh()`, whose async body only logs.
- **7** sites that should not really be fire-and-forget (listed under 1.3.0 below).

T59 makes the rule an `error`. `lintContract.test.cjs` now pins it in `PROMOTED_RULES` instead of the warning-budget list, and `DEVELOPMENT.md` says so.

**A departure from the brief.** The brief asked for an `eslint-disable` comment wherever a promise should really be awaited. But `suppressions.total` is ratcheted at 0 (`DESIGN_GUARDRAILS.md`: "It stays at 0"), and `guardrails:update` refuses any increase. So those sites keep their behaviour, get a `void`, and carry a plain `// 1.3.0:` comment instead.

## Carried to 1.3.0

1. **Awaits that are missing today.** All are behaviour-neutral as left; each has a `// 1.3.0:` comment.
   - `servers/views/interactions/launchNotifications.ts`: the "Open Now" and "Open Manually" toast callbacks start `openLaunchedServerInBrowser` / `InPanel`. Those log and rethrow, so a failed open becomes an unhandled rejection.
   - Same file: "Copy Network URL" shows its confirmation without awaiting `clipboard.writeText`.
   - `visualize_data/model/visualizeDataModel.ts` (`resetVisualizeDataState`) and `visualize_data/state/visualizeDataState.ts` (`saveState`): the `workspaceState.update` call sits in a try/catch that never sees it fail.
2. **T40**: `getAllSelectedSettings` now reads the settings file once, so its per-field debug log lines are gone. These are logger-only lines, not user-visible.
3. **T48**: the two protocol rules are pinned as they are. Two sites take the protocol from `certMode` and `copyLanUrl` takes it from the URL scheme; unifying them is a behaviour change. The LAN sites that already had a guard were not touched.
4. **T49**: `copyLanUrl` keeps its own registry guard on purpose. It is a different guard, not the remote-manager guard.
5. **`dynamicColorIconGenerator.ts`** still spells out its own copy of the visualization config directory name (T39 only covered the accessors and the storage).
6. **T36**: delete the three dependency types that nothing uses.
7. **T54**: as the roadmap says.
