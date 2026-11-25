# Session log — #29 Delete unreachable modules and dead declarations (W2-01..W2-44)

> Date: 2026-11-25 · Branch: `claude/project-thread-n2s3q6-dead-code` (cut from `origin/v1.2.1`; merged `origin/v1.2.1` three times: after W2-05, after W2-18, and at the end) · Story: Code-XR-Project/Code-XR#29
> Authority: ROADMAP.md wave 2 (W2a whole files, hinge W2-22/W2-23, W2b dead declarations). Amendments from `docs/cleanup/w2-revalidation.md` applied.

## Commits

| Row | Commit | Subject |
|---|---|---|
| W2-01 | `bdde1437` | chore(src): delete five zero-byte modules |
| W2-02 | `19910c94` | chore(tsconfig): drop four phantom excludes |
| W2-03 | `7c009767` | chore(build): delete orphan esbuild.config.mjs |
| W2-04 | `2c2bb552` | chore(engine): delete the unimported engine barrel chain (8) |
| W2-05 | `d56d00e1` | chore(src): delete the remaining 22 unimported barrels |
| — | `ee18ac78` | merge origin/v1.2.1 (PR #44, feature baseline) |
| W2-06 | `2f40def9` | chore(engine): delete duplicate interfaces file |
| W2-07 | `c31a6956` | chore(engine): delete four pass-through requirement rules |
| W2-08 | `ecace551` | chore(engine): delete the last requirement rule and the 4 lines pinning dead code |
| W2-09 | `a957dfdb` | chore(engine): delete directoryFilter.ts |
| W2-10 | `bd37f265` | chore(utils): delete fileDisplayUtils.ts |
| W2-11 | `9b3a2dd1` | chore(config): delete ConfigurationManager and its example |
| W2-12 | `c2b0f76d` | chore(servers): delete src/servers/config/ |
| W2-13 | `a0bae04e` | chore(active-servers): delete the duplicate tree-item file |
| W2-14 | `fabfb272` | chore(servers): delete the stale unregistered SERVERS provider |
| W2-15 | `7e4c76b8` | chore(analysis): delete the active_analyses provider, items, model |
| W2-16 | `650d8c72` | chore(python-env): delete handlePythonEnvActions.ts |
| W2-17 | `3d00983f` | chore(learn-more): delete views.ts bridge |
| W2-18 | `dabaa8e1` | chore(visualize-data): delete browse tree view and its orphaned factory method |
| — | `8130925b` | merge origin/v1.2.1 (#45/#46/#47) |
| (W2-47 follow-up) | `c6e89f26` | chore(analysis): delete the clean_analysis barrel orphaned by W2-47 |
| W2-19 | `f64b2065` | chore(views): delete the stale language-table fork |
| (§E prerequisite) | `a3b9f68e` | chore(views): delete the dead tree-click dispatch root |
| W2-20 | `4904a209` | chore(views): delete the unreachable servers click layer |
| W2-21 | `bde57f8c` | chore(views): delete the unreachable active-servers click layer |
| W2-22 | `c3b6765d` | build(lint): no-unused-vars as error; drop the 14 unused imports |
| W2-37 | `847b2b51` | chore(analysis): delete uncalled getStatusIcon (pulled ahead of the W2-23 hinge) |
| extra | `6cdf1cfd` | chore(templates): delete the legacy CreateStructure.getSSEScript |
| extra | `33c87cf0` | chore(settings): delete the uncalled ProfileConfiguration.detectVSCodeTheme |
| W2-23 | `1bf4f653` | build(tsc): enable noUnusedLocals in a typecheck-only tsconfig.check.json |
| W2-24 | `be196860` | chore(settings): delete dimensionMappingCleaner.ts and 3 uncalled methods |
| W2-25 | `e9c1fdb2` | chore(utils): delete 8 dead helpers |
| W2-26 | `817543ee` | chore(engine): delete the uncalled hashing cluster; keep FileHash |
| W2-27 | `312c8bb7` | chore(commands): delete dead aggregator accessors |
| W2-28 | `67332160` | chore(views): delete TreeViewUtils and two *Icons classes |
| W2-29 | `f05da57c` | chore(types): delete two dead exported types |
| W2-30 | `2ffa7b08` | chore(engine): delete AnalysisSessionFactory and two dead predicates |
| W2-31 | `28311840` | chore(servers): delete 4 uncalled wrappers; keep the pinned re-exports |
| W2-32 | `3cc7ea25` | chore(servers): delete PortManager statics orphaned by W2-31 |
| W2-33 (+ extra getFullConfig) | `3874c220` | chore(https): delete the certificate-inspection API |
| W2-34 | `d0282e5a` | chore(https): drop the discarded generateServerUrls call |
| W2-35 | `48e5a009` | chore(servers): delete MultiServerLauncher's unreachable lifecycle half |
| W2-36 | `85e84efb` | chore(active-servers): delete ServerControl's unreachable status helpers |
| W2-38 | `5fa6cd8d` | chore(babia): delete DimensionValidator's three unused statics |
| W2-39 | `1c7246dc` | chore(historical): delete HistoricalComparisonService.clearActiveComparison |
| W2-40 | `47c44414` | chore(watchers): delete FileHashTracker.isAnalyzableExtension |
| W2-41 | `7229617e` | chore(analysis): drop the empty getMainCommandRegistrations hook |
| W2-42 | `51e7eb92` | chore(analysis-views): delete the TODO-stub CodeAnalysisItemFactory |
| W2-43 | `b92dd2d1` | chore(utils): delete the deprecated CommonCommands.refreshServers |
| W2-44 | `60a6969e` | chore(analysis-views): delete the duplicate CommandRegistration interface |
| extra | `0e839f07` | chore(babia): delete two unused chart model interfaces |
| extra | `51bde299` | chore(engine): delete the unused FileRequirement interface |
| — | `00714d9c` | merge origin/v1.2.1 (#48 VSIX, #49 runtime, #50 Python) |

The extra `statusIcon` local in `fileXRParser.ts` went with W2-22 (the lint flag caught it); `HttpsCustomServer.getFullConfig` went with W2-33.

Every commit message carries its deadness proof (callers, string references, command registration, text pins classified G/S/L), the H1 sha12 trailer for whole-file and type-only changes, or the reviewed H2 line diff (unminified bundle, module ids normalized) for the rest.

## Measurements

Branch start (`origin/v1.2.1` at the cut) → last own commit `51bde299` (includes the work merged from `origin/v1.2.1` up to the second merge) → branch tip after the final merge.

| Metric | Start | `51bde299` | Tip |
|---|---|---|---|
| `reachability.unreachable` | 54 | 1 | **0** |
| `console.total` | 1646 | 1416 | 1416 |
| `any.total` | 219 | 201 | 201 |
| `src.files` | 369 | 309 | 308 |
| `src.lines` | 52,974 | 48,005 | 47,968 |
| `src.functions` | 2864 | 2619 | 2615 |
| `dist/extension.js` (prod, no sourcemaps) | 1,257,156 B | 1,214,352 B | — |

The one module still unreachable at `51bde299` was `visualStyleComponentAsset.ts` (W2-55, not this story); #49 deleted it, so the tip reaches the story's target of 0. The waiver for W2-47's clean_analysis barrel was dropped and `waivers` is empty.

New gates: `@typescript-eslint/no-unused-vars` is an error (W2-22; args and caught errors still allowed, `^_` ignored); `npm run typecheck` runs `tsc -p tsconfig.check.json` with `noUnusedLocals` (W2-23), while compile, compile-tests and webpack keep `tsconfig.json`.

## Gates

`npm test` (Node 24) green on every commit: 715 tests after the first merge, 720 after the second, 727 at the tip after a fresh `npm ci`. H1 (`CODEXR_NO_SOURCEMAPS=1 npm run package` + `dist-diff --expect-identical-bundle`) for every whole-file deletion and type-only change; H2 reviewed shrink otherwise.

## Deliberately not touched

- W2-45..W2-52 (#30, commands) and W2-53..W2-74 (other stories).
- `ServerAction` (`active_servers/model/activeServerModel.ts:69`) is unreferenced since W2-29 removed `ServerActionContext`; it was not on any row and is left for a later pass.
- W2-29 keeps `AnalysisTableMode` (revalidation amendment).
- The legacy command aliases `codexr.servers.refresh` / `codexr.servers.refreshServers` stay registered (W2-43 removes only the uncalled static method).
- No CHANGELOG line: nothing here is user-noticeable (see the quirk below).

## Behaviour quirks found

- W2-34: `httpsCustomServer.ts` called `NetworkUtils.generateServerUrls(port, 'https')` and discarded the result, so the "Found local IP address" DevTools log appeared twice per HTTPS custom start. It now appears once. That is the only runtime-visible change, and only in the Extension Host log.
- Pending conflict: PR #51 (#38 Git services) rewrites `clearActiveComparison` to call `this.jobs.forgetLastRequest()`. Whichever of #29/#51 merges second must keep W2-39's deletion (drop the method; `forgetLastRequest` stays, `projectEvolutionService` calls it). A trial `merge-tree` shows that conflict plus the guardrail baseline, resolved by regenerating.

## F5 checks for the maintainer

1. CodeXR tree: click and right-click entries in Servers and Active Servers (W2-14, W2-20, W2-21 removed the unreachable click layers; the registered commands are untouched).
2. Start an HTTPS custom server; open, copy URL and stop it from Active Servers; stop all.
3. Analysis settings (chart type, dimension mapping, directory mode, profile) open and save.
4. Visualize Data section still lists and opens visualizations (W2-18).
5. Historical comparison: run one, then re-run with the working copy.
