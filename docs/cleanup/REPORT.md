# Code-XR deep cleanup (epic #26): final report

> **Story:** [#43](https://github.com/Code-XR-Project/Code-XR/issues/43), final verification, measurements and report. It also closes [#27](https://github.com/Code-XR-Project/Code-XR/issues/27), the feature baseline verified at the end.
> **Measured on:** 2026-11-25, `v1.2.1` at `913cb362` (merge of PR #65).
> **Compared with:** `399494af`, the `v1.2.1` head before PR #44 and the epic's baseline in [`README.md`](README.md).
> **Scope of this story:** documentation and tests only. No source file changed behaviour here.

## 1. Executive summary

The cleanup landed as 20 pull requests (#44 to #65) against `v1.2.1`. As far as every check that can run here shows, the extension does everything it did before:
- **The gates.** All automated gates are green on the final tree:
  - `npm test`: 1,064 of 1,064;
  - the backend suites: 73;
  - the per-language analysis fixtures, the HTML analysis suites and `ruff`;
  - the four browser harnesses.
- **CI.** CI was green on PR #65 for Linux, Windows and macOS.
- **The packaged VSIX.** It was driven end to end with a real Python environment, real servers and a real Chromium. Section 8 says, row by row, what that run verified and what still needs the maintainer's F5 or VSIX check.
- **No regression found.** The end-to-end run found three oddities. Running the same checks on the pre-cleanup package gives the same result for each, so they are older behaviour, recorded for 1.3.0 in section 9.

Headline numbers, before → after:

| | Before (`399494af`) | After (`913cb362`) |
|---|---|---|
| TypeScript in `src/` | 369 files, 52,988 lines | 291 files, 49,064 lines |
| Modules unreachable from `extension.ts` | 54 | 0 |
| `console.*` calls in `src/` | 1,646 | 2 |
| `any` | 219 | 84 |
| Functions over CCN 20 (worst) | 10 (61) | 0 (20) |
| Files over 600 lines (largest) | 11 (1,174) | 6 (850) |
| Folders in `src/` / `index.ts` barrels | 179 / 82 | 98 / 0 |
| Extension tests / backend tests | 708 of 709 / 52 | 1,064 of 1,064 / 73 |
| VSIX | 6.45 MB, 360 files | 4.20 MB, 199 files |
| Tracked working tree | 313.5 MB, 919 files | 117.1 MB, 902 files |

ROADMAP §5 has 27 exit criteria:
- **20 are met.**
- **2 are partial:**
  - `complexity` is still an ESLint warning, not an error;
  - CI is not yet "required": that needs branch protection, which only the maintainer can turn on.
- **5 are missed.** Each is missed by a recorded margin, with its reason in section 6. None of them hides a lost feature.

**What is left before the release is cut:** the maintainer's F5 and installed-VSIX checklist in section 10, and branch protection.

## 2. Method

**Gates.** Each was run from the repository root after a clean `npm ci`, with Node 24 and Python 3.11. The results are in section 5.

**Browser harnesses.** Two things in this environment stop them from running as they are:
- the proxy refuses the CDNs (A-Frame, BabiaXR, aframe-extras, environment, geometry-merger) with HTTP 403;
- the installed Chromium is build 1243, while the pinned Playwright expects 1228.

So the four harnesses ran with a Node preload. It points Playwright at the installed headless shell and answers each CDN request from a local copy of the exact pinned version, taken from npm. The harness code and the harness pages are unchanged.

**Before measurements.** They come from a separate worktree of `399494af`, built and packaged the same way. Every before/after pair below counts the same way on both trees.

**E2E.**
- `@vscode/test-electron` cannot run here: the proxy refuses the VS Code download (HTTP 403).
- The fallback that the story allowed was used instead:
  - The **packaged VSIX** was unzipped, and its `dist/extension.js` was loaded under the repository's fake `vscode` host (`test/helpers/fakeVscode.cjs`).
  - It ran in production mode, with a fresh profile and a Git sample workspace.
  - The extension created its own Python venv.
  - Every page it served was opened in headless Chromium.
- **Old against new.** The rows that showed problems were re-run on the pre-cleanup VSIX, so that older behaviour can be told apart from a regression.
- **One sandbox workaround.** tree-sitter-language-pack's own downloader rejects the proxy's CA. The same parser bundle was fetched separately, checked against its published sha256 and placed in the package's cache before the venv was verified.

**What this report does not claim.** Nobody has tested anything here by hand in VS Code. A row marked "maintainer" in section 8 has not been checked by anyone yet.

## 3. Findings by area

| Area | What was found | What was done | Stories |
|---|---|---|---|
| Unreachable code | 54 modules (2,317 lines) unreachable from `extension.ts`; dead declarations in live files; `configurationManagerExample.ts` | Deleted after the four-check deadness proof; 0 unreachable modules remain | #29 |
| Commands | The template's "Hello World"; two theme-debug commands; unreachable command layers | Removed. `Debug Python Environment Failure` hidden from the palette. 69 contributed and 105 registered ids pinned by a test | #30 |
| Assets and media | 34 MB of unused `no_color/` icons; about 170 MB of unused media; an empty integration-test lane and its dependencies; four sample datasets no example loaded | Deleted; the shipped icons re-encoded pixel-identically | #31, #41 |
| Monorepo seams | The backend located through paths from before the move; stale agent docs | Fixed, with a Development-mode fallback to `backend/src` | #32 |
| Python backend | 16.1% duplicated windows; a misspelled `sumaryFiles/` package; per-file stderr noise; the backend failed to load on Python 3.8 and 3.9 | Duplication down to 4.0%; renamed `summaryFiles/`; loads on 3.8+; goldens for class counting and dependencies | #31, #36, #56 |
| Browser runtimes | Duplicated LivePanel and SSE client code; a dead `htmlLiveReload.js`; an unused visual-style runtime; console chatter in user-facing scenes | De-duplicated against characterization transcripts; routine logs behind a debug flag | #31, #37, #56 |
| Guardrails | ESLint checked almost nothing; no ratchet on size or complexity; no Python linter | Strict ESLint (errors plus budgeted warnings), strict `tsc`, `ruff`, the guardrail ratchet, CI on three OSes | #33 |
| Logging | 1,646 `console.*` calls and 65 console-only catch blocks; a logger nobody used | Everything goes through `src/platform/logging/` and the CodeXR output channel; `codeXR.debug.verboseLogs` changes the verbosity live | #34 |
| TS pipeline, export, settings | Long branching functions (worst CCN 61); duplicated bridges and settings code; floating promises | Split under characterization tests; 0 floating promises, now a lint error | #35 |
| Git services | Historical comparison, project evolution and export each re-implemented revision handling (147 duplicated lines) | One shared core; 23 duplicated lines left | #38 |
| Servers | `collaborationRoomServer.ts` at 1,174 lines; duplicated HTTPS servers; the launcher reaching into the view layer | Split; the HTTPS pair is down to 28 identical lines; the launcher no longer imports the view layer | #39 |
| Sidebar and scene assets | Hand-built tree sections; asset lists repeated per scene mode | A data-driven tree from section definitions; one scene-asset descriptor table | #40 |
| Package | A 6.45 MB VSIX with copies of `templates/` and `examples/` under `dist/`, shipped `docs/` and a duplicate favicon | 4.20 MB and 199 files; packaging and startup measured | #41 |
| Layering | 9 two-way folder cycles (15 counting `commands/shared` back-edges) | 4 left, each recorded; a registry emitter with no `vscode` import | #42 |
| `src/` layout | 179 folders, 82 barrels, mixed naming | Feature-first `app/ → features/ → core/ → platform/ → shared/`; 98 kebab-case folders; 0 barrels; the move map in [`src-move-map.json`](src-move-map.json) | #55 |
| Idioms | Old TypeScript, Python and runtime patterns | Modernized and locked in by lint rules | #56 |

## 4. Stories and pull requests

Every pull request targeted `v1.2.1` and merged green. Each story has a session log under `.claude/docs/v1.2.1/sessions/`, which is not shipped. A log holds the story's commits, its before/after numbers, its gates, what was deliberately left and its F5 list.

| PR | Story | What it did | Session log |
|---|---|---|---|
| #44 | #27, #28 | Safety net: feature baseline test, portable tests, the epic analysis | this folder's analysis documents |
| #45 | #31 | Dead assets and media, the empty integration lane | `31-assets-media-tooling.md` |
| #46 | #32 | Monorepo seams and stale agent docs | `32-monorepo-seams.md` |
| #47 | #30 | Scaffold, debug and unreachable commands | `30-authorized-command-removals.md` |
| #48 | #41 | Smaller VSIX | `41-vsix-size.md` |
| #49 | #31, #37 | Dead template code, runtime de-duplication | `31-templates-runtime.md`, `37-runtime-dedup.md` |
| #50 | #31, #36 | Python dead code, backend simplification | `31-python-dead-code.md`, `36-python-backend.md` |
| #51 | #38 | Historical, evolution and export services | `38-git-services.md` |
| #52 | #29 | Unreachable modules and dead declarations | `29-dead-code.md` |
| #53 | #33 | Guardrails: ESLint, `tsc`, `ruff`, CI | `33-guardrails.md` |
| #54 | #39 | Server, collaboration and broadcast splits | `39-server-splits.md` |
| #57 | #40 | Data-driven tree, scene asset table | `40-tree-assets.md` |
| #58 | #34 | Logging through the output channel | `34-logging.md` |
| #59 | #55, #56 | `src/` target tree and modernization inventory (documents only) | [`src-layout.md`](src-layout.md), [`modernization.md`](modernization.md) |
| #60 | #42 | Module layering | `42-layering.md` |
| #61 | #35 (part B) | TypeScript de-duplication; floating promises to 0 | `35b-ts-dedup.md` |
| #62 | #56 (part A) | Python and runtime idioms | `56a-modernize-py-js.md` |
| #63 | #35 (part A) | TypeScript pipeline, export and Git code | `35a-ts-pipeline.md` |
| #64 | #56 (part B) | TypeScript idioms | `56b-modernize-ts.md` |
| #65 | #55 | Feature-first `src/` layout | `55-src-layout.md` |
| this branch | #43, #27 | Final verification and this report | this document |

## 5. Evidence that behaviour did not change

### 5.1 Gates on the final tree (`913cb362`)

| Gate | Result |
|---|---|
| `npm test` (typecheck, lint, compile-tests, unit) | 1,064 tests: 1,064 pass, 0 fail. `tsc --noEmit` clean. ESLint: 0 errors and 158 warnings, within `--max-warnings 158` |
| `npm run test:python` | 73 tests, OK |
| `npm run test:analysis` | 5 tests OK over 24 root and 3 deep fixtures; XR and LivePanel `data.json` identical |
| `npm run test:htmlanalysis` | 12 Node tests and 5 Python tests, OK |
| `npm run lint:python` | `ruff` 0.17.6: "All checks passed!" |
| `npm run test:xr-harness` | pass (CDN served locally, see section 2) |
| `npm run test:xr-immersive-harness` | pass (same) |
| `npm run test:xr-mode-harness` | pass (same) |
| `npm run test:project-evolution-harness` | exit 0 (same) |
| `npm run package:vsix` | `code-xr-1.2.1.vsix`: 4,204,772 bytes, 199 files; `dist/extension.js` 1,173,899 bytes |
| CI on PR #65 (head `d3463262`) | success: `npm test` on ubuntu, windows and macos; the Python suites on all three; VSIX packaging |

**Story #27.** The feature baseline test, `test/baseline/featureBaseline.test.cjs`, runs inside `npm test` and is green without `--write`. It pins:
- the manifest: commands, menus, `when` clauses, settings;
- the command registry;
- chart types, runtimes and languages;
- the Python CLI surface.

### 5.2 Feature baseline §10.A: the automated rows

| Row | Result |
|---|---|
| 1-5 | Green; see 5.1 |
| 6-9: manifest, contributed ids, internal ids, menus | Pinned by `featureBaseline.test.cjs` and `test/commands/*`, all green. 69 contributed commands, 36 internal ids, and `CodeXR.helloWorld` is gone |
| 10: language contract | `23 48`. `languageMetadata.ts`, now in `src/core/analysis/languages/`, has 24 `{ name:` entries |
| 11: field schema | file: 13 fields; directory: 25; `schemaVersion` 1 |
| 12: Python CLI | See the notes below the table |
| 13-17: runtimes, server surface, sidebar, capabilities, persisted keys | Pinned by the baseline and characterization suites, all green. The paths moved in #55; [`src-move-map.json`](src-move-map.json) maps old to new |
| 18: pinned versions | Unchanged: lizard 1.17.31, tree-sitter-language-pack 1.8.1, cloudflared 2026.5.2, A-Frame 1.7.1, aframe-extras 7.5.4, babia 1.3.4, environment 1.5.0, geometry-merger 2.0.1 |
| 19: VSIX listing | See 5.3 |
| 20: guardrails | `npm run guardrails:measure` shows only improvements over the recorded baseline |
| 21: harnesses | Pass; see 5.1 |

Row 12, the Python CLI:
- `--help` lists:
  - `--mode {livePanel,xr,schema,dependencies}` and `--type {file,directory}`;
  - `--target`, `--files`, `--deep`, `--cache`, `--dependency-refresh` and `--project-root`.
- The `project` type and `--output` are gone, as authorized.
- The three spawned scripts exist; `summaryFiles/` is now spelled correctly.

### 5.3 The VSIX listing against the pre-cleanup package

The 1.2.1 package has 161 fewer entries than the one built from `399494af`. Each removed entry falls into one of these groups. Every group was removed by name in a story, and the CHANGELOG lists it wherever a user could notice:
- **The copies under `dist/`:** `dist/templates/` (130 files) and `dist/examples/` (14). The extension reads `templates/` and `examples/` from the package root, as before.
- **Documentation:** 8 files under `docs/`. The README links to them on GitHub.
- **Sample data:** the 4 unused `examples/data/*.json` datasets.
- **A duplicate icon:** `resources/favicon.ico`.
- **Dead runtimes:** `codexrVisualStyleRuntime.js` and `htmlLiveReload.js`.
- **Dead Python:** the Python `examples/` folder and the dead `file_reanalysis_coordinator.py` under `livePanels/`.

`sumaryFiles/` appears renamed as `summaryFiles/`. Nothing was added that the old package lacked, apart from the files the stories above renamed or moved.

## 6. Exit criteria (ROADMAP §5)

The "after" values come from `npm run guardrails:measure`. The "before" values come from the same scripts run on the before tree. "Before" means `399494af` unless the table says otherwise.

| Criterion | Target | Before → after | Status |
|---|---|---|---|
| Modules unreachable from `extension.ts` | 0 | 54 → 0 | met |
| Dead exports (declarations nothing reads) | 0 | 26 → 9 | **not met.** 6 of the 9 are recorded in the session logs. 3 are new findings for 1.3.0: `DEFAULT_CONFIGURATION_FILE`, `getLanguageStats` and `ExampleLaunchConfig` |
| Commands contributed / registered / pending removal | 69 / 106 / 0 | 69 / 105 / 0, plus 2 fenced legacy aliases | met. The 106 target assumed `helloWorld` would stay registered; it was removed together with its contribution |
| Debug or scaffold commands in the palette | 0 | 0 | met |
| TypeScript lines in `src/` | ≤ 49,000 | 52,988 → 49,064 | **not met, by 64 lines** (48,773 by `wc -l`; the ratchet counts one extra line per file). The #56 lint rules and the #55 layer headers added lines on purpose |
| TS functions over CCN 30 / 20 / 15 | 0 / ≤ 3 / ≤ 12 | 6 / 10 / 31 → 0 / 0 / 8 | met |
| Worst TS CCN | ≤ 25 | 61 → 20 (`sampleTimeline`) | met |
| Python functions over CCN 15 | ≤ 4 | 1 | met |
| Worst Python CCN | ≤ 15 | 18 (`summarize_function_metrics`) | **not met.** This function builds the XR field-schema contract, which the roadmap marks do-not-touch for 1.2.1 |
| `analyze_classes` length | ≤ 160 lines | 31 lines (CCN 5) | met |
| Files over 600 lines | ≤ 4 | 11 → 6 | **not met.** The six and the reason each stays are listed after this table |
| Largest file | ≤ 700 lines | 1,174 → 850 (`venvManager.ts`) | **not met.** The venv split was cut from 1.2.1: it was too risky without a test against a real install |
| HTTPS server pair: identical lines | ≤ 30 | 212 → 28 | met. #39 reported 156 → 26 with a narrower filter; this is the corrected measure, taken the same way on both trees |
| Historical ↔ evolution: duplicated lines (window of 4) | ≤ 25 | 147 → 23 | met |
| `toPortableRelativePath` copies | 1 | 4 → 1 | met |
| Python duplicated windows (window of 6) | ≤ 6% | 16.1% → 4.0% | met |
| `console.*` in `src/` | ≤ 5 | 1,646 → 2 (the log sink's own fallback) | met |
| Console-only catch blocks | 0 | 65 → 0 | met |
| `any` | ≤ 125 | 219 → 84 | met |
| `@ts-ignore` and other suppressions | 0 | 0 → 0 | met |
| Floating promises | 0 | → 0, enforced as a lint error | met |
| ESLint rules as error | the 5 original rules, `no-unused-vars`, `no-console`, complexity | All are errors except `complexity`, which warns at 15 inside the counted budget (`--max-warnings 158`, down from 608 when W3 introduced it) | **partial.** Making `complexity` an error first needs the 8 functions over 15 split |
| `tsc` strictness flags | 4 | all 4 on | met |
| Lint scope | `src`, `test`, `scripts`, configs, runtimes | all covered | met |
| `ruff` | clean | clean | met |
| CI | green and required | green on 3 OSes, blocking in the workflow | **partial.** "Required" is a branch-protection setting that only the maintainer can turn on |
| Working tree | 34 MB smaller | 313.5 MB → 117.1 MB tracked (−196 MB) | met |

Six files are still over 600 lines. Each stays for a stated reason:

| File | Lines | Why it stays |
|---|---|---|
| `src/core/python-env/venvManager.ts` | 850 | Its behaviour depends on a real install, and there is no test host for that; the split is planned for 1.3.0 |
| `src/features/analysis/sections/active-analyses/activeAnalysesCommands.ts` | 802 | The export wizard could move out, but its test reads this file by path |
| `src/core/export/exportManifest.ts` | 745 | Already brought down from CCN 61; what remains is the manifest schema |
| `src/core/remote-access/remoteSessionAuthority.ts` | 631 | A security-sensitive auth flow; it is not reshaped without a tunnel test |
| `src/features/active-servers/views/handleServerActions.ts` | 623 | Down from 815 (#39); what remains is one action per server menu entry |
| `src/core/history/gitRepositoryService.ts` | 616 | The single Git access layer that #38 consolidated into |

## 7. Epic before/after in full

| Measure | Before (`399494af`) | After (`913cb362`) |
|---|---|---|
| TypeScript files / lines (ratchet count) / functions | 369 / 52,988 / 2,865 | 291 / 49,064 / 3,338 |
| Unreachable modules | 54 | 0 |
| `console.*` / console-only catch blocks | 1,646 / 65 | 2 / 0 |
| `any` / suppressions | 219 / 0 | 84 / 0 |
| Functions over CCN 10 / 15 / 20 / 30 | 81 / 31 / 10 / 6 | 53 / 8 / 0 / 0 |
| Functions over 80 lines | 57 | 36 |
| Files over 500 / 600 lines | 19 / 11 | 13 / 6 |
| ESLint warning budget | none | 158 |
| Two-way folder pairs | 9 | 4 |
| Folders / `index.ts` barrels | 179 / 82 | 98 / 0 |
| Folder naming: snake_case / camelCase / kebab-case | 55 / 2 / 0 | 0 / 0 / 23 |
| Test files / tests | 74 / 708 of 709 | 126 / 1,064 of 1,064 |
| Backend tests | 52 | 73 |
| VSIX bytes / entries | 6,446,832 / 360 | 4,204,772 / 199 |
| `dist/extension.js` | 1,257,156 B | 1,173,899 B |
| Tracked tree | 313.5 MB, 919 files | 117.1 MB, 902 files |
| TODO markers | 28 | 17 |

The function count went up because long functions were split into named helpers.

## 8. Automated E2E of the packaged VSIX

How the run was set up:
- **The package.** `code-xr-1.2.1.vsix` was built by `npm run package:vsix` from `913cb362` and unzipped.
- **Activation.** Its `dist/extension.js` was activated under `test/helpers/fakeVscode.cjs`, in production mode, with an empty global storage.
- **The workspace.** A Git sample project with 3 commits, a tag, and a Python, a JavaScript and an HTML file.
- **What was real.** The extension created and verified its own Python venv. Its own HTTP and HTTPS servers served every page, and headless Chromium opened them.
- **Two scenario runs.** The full scenario ran once. A focused re-run then repeated the scene rows with one session per target. The focused run was also repeated on the pre-cleanup VSIX (`399494af`), to tell regressions from older behaviour.

What the fake host cannot show stays with the maintainer:
- the rendered VS Code chrome: icons, the palette, menus and the Settings UI;
- webview panels and the native colour picker;
- the children of the ANALYSIS section, because the fake host has no `vscode.RelativePattern`, which the Files by Language watcher needs (a limitation of the test harness, not of the product);
- anything that needs two browsers, a headset or a real tunnel.

| §10 row | Result | How |
|---|---|---|
| 22 Activation | **verified automatically** | `activate()` of the packaged bundle: 69 contributed, 105 registered, no missing id, no error toast, the CodeXR channel created. The activity-bar icon itself: maintainer |
| 22/15 Sidebar roots | **verified automatically** | The tree provider registered for `codexrTree` returns the eight roots in the 1.2.0 order. Rendering, icons, and the ANALYSIS children: maintainer |
| 23 Python environment | **partly verified** | In a clean storage the deferred startup created the venv and verified lizard and tree-sitter-language-pack. `Status` and `Verify installation` answer correctly. The UI lock while installing, Reinitialize and Delete → Create: maintainer |
| 24 Settings | **verified automatically** | Only `codeXR.debug.verboseLogs` is contributed. Toggling it through `onDidChangeConfiguration` takes `[DEBUG]` lines from 0 to 8 live. The Settings UI: maintainer |
| 25 Command Palette, 26 context menus | static only | Palette and menu `when` clauses are pinned by `featureBaseline.test.cjs`. What VS Code shows: maintainer |
| 27 All 11 analysis kinds | **verified automatically** | Each kind launched its server and opened its page, with no error toast and no `[ERROR]` line. The sidebar grew to 148 nodes. Run Last dispatched the last kind (`visualizeDOM`) and got the "already in progress" guard |
| 28 XR scene | **partly verified** | File and directory scenes load: `a-scene` loaded and rendering. `babia-queryjson`, `babia-treebuilder` and `babia-boats` are present, `CodeXR.help()` returns 26 entries, there are no page errors, and `/events` (SSE) answers 200. Field Mapping, VR/AR, the virtual screen and the guide: maintainer |
| 29 In-scene modes | **verified automatically** | `CodeXRAnalysisModeRuntime.changeAnalysis()` entered dependency-graph, historical-compare and project-evolution in the XR directory scene and returned to single, with no page error. `test:project-evolution-harness` also passes. Visual detail (layouts, movie playback): maintainer |
| 30 LivePanel | **partly verified** | The file page renders 7 table rows and the directory page 6. Status "Live Updates", `/events` 200, no page errors. The page asks for `dependency-graph.json` before any dependency analysis exists, gets a 404, and handles it (same on the pre-cleanup build). Lateral-panel mode (webview): maintainer |
| 31 DOM visualization | **served, render not verifiable here** | The page loads every runtime, attaches `babia-html` and connects SSE (200). Inside `babia-html`, html2canvas throws "Unable to find element in cloned iframe" in headless Chromium, so whether `a-scene` finishes loading is a race. It loaded in 1 of 3 runs of the new package and in the one run of the old package, with the same page errors on both. The generated scene differs from the pre-cleanup one only by the nonce, the gated live-reload logs, the runtimes changed by #37/#56 and the re-encoded favicon. The visual result and edit → update: maintainer |
| 32 Auto re-analysis | **verified automatically** (XR file) | After a function was appended to the analysed file, the open XR scene re-fetched `data.json` (200), with no error. Debounce, Auto-Analysis off, and add/delete under a directory: maintainer |
| 33 ANALYSIS settings, 34 Export Analysis Folder | maintainer | The export manifest, layout and wizard messages are pinned by characterization tests, not run end to end here |
| 35 SERVERS | **partly verified** | Start Local Server with an HTML file, launched twice, got two ports and served "Manual DOM Fixture". The configuration rows: maintainer |
| 36 ACTIVE SERVERS | **partly verified** | Stop All Servers closed 13 of 13 listening ports. Its confirmation read "Stop all 20 server(s)?" while 13 ports were open; this was not compared with 1.2.0 (see section 10, row 35). The per-server actions: maintainer |
| 37 Collaboration, 38 Screen broadcast | maintainer | They need two browsers. The room and broadcast servers are pinned by characterization tests |
| 39 Remote access | **partly verified** | Cross-network is on by default, so launches asked for the one-time cloudflared consent. Left unanswered (declined), nothing was downloaded and cross-network was switched off with its message. A real tunnel and pairing: maintainer |
| 40 BABIA EXAMPLES | **partly verified** | All 7 rows launched from their tree items, each page's `a-scene` loaded, and each has its BabiaXR components. About BabiaXR shows its info. **Barsmap and Pie get 404 for their data** (`../../data/sales.json`, `../../data/population.json`): the server's static root is the example's own folder, so the path leaves it. **The pre-cleanup VSIX behaves identically**, so this is older behaviour, not a regression; it is recorded for 1.3.0 in section 9. Confirm in VS Code: maintainer |
| 41 VISUALIZE DATA, 42 VISUALIZATION SETTINGS | maintainer | Webview and colour picker |
| 43 LEARN MORE | **verified automatically** | `openExternal` targets: the docs site, the author site and Buy Me a Coffee |
| 44 Deactivate | **verified automatically** | `deactivate()` ran with no error; every port was released. No tunnel had been started (consent declined), so the `cloudflared` part: maintainer |
| 45 Installed VSIX in VS Code | maintainer | VS Code could not be downloaded in this environment |

The first full run surfaced one more pattern. Analysing the same file (or folder) in two modes at once gives each mode its own server. The file-to-server map keeps one port per file, so the first server answers `/events` with 404 and its page loses live reload. The focused re-run (one session per target) answers 200. The map's logic is unchanged since 1.2.0 (only its logging moved), so this is older behaviour, recorded in section 9.

## 9. Deferred to 1.3.0

These items are recorded, not done. Each one names the session log that holds its detail.

**Structure and size**
- The six files over 600 lines (section 6), starting with the `venvManager.ts` split.
- The four two-way folder pairs left after #42 and #55 (`src-layout.md`, `42-layering.md`).
- The remaining 84 `any`, and the 2,014 `var` declarations in the multi-part browser runtimes (`56a-modernize-py-js.md`).
- The 8 functions over CCN 15; once they are split, `complexity` can become an ESLint error.
- The 9 dead exports, 3 of them new (section 6).
- Roadmap rows cut from 1.2.1: W5-19, W5-41, W5-53 to W5-55, and T54 (`35b-ts-dedup.md`).
- The unused parameters that #33 marked with a `_` prefix (`33-guardrails.md`).
- The three TODO stubs in `src/features/analysis/views/handleAnalysisClicks.ts`.

**Older behaviour found by the E2E.** All three are identical on the pre-cleanup VSIX:
- **BabiaXR examples Barsmap and Pie.** They ask for `../../data/*.json`. The server's static root is the example's own folder, so both requests get 404 and those two charts get no data. The #31 F5 check expected the data to load; it does not, before or after.
- **The same target analysed in two modes at once.** Each mode gets its own server, but the file-to-server map keeps one port per file, so the first server answers `/events` with 404 and its page loses live reload.
- **DOM visualization in headless Chromium.** `babia-html`'s html2canvas throws "Unable to find element in cloned iframe". Whether this also happens in a desktop browser is in the maintainer's checklist.

**Behaviour quirks.** Tests pin each of these. They stay as they are because 1.2.1 changes no behaviour.

*Servers* (`39-server-splits.md`):
- `forceStop()` on the HTTPS servers leaves the listener open.
- `stopAllServers` reads a count as a success flag.
- A registrar failure still reports `success: true`.
- "Copy Network URL" copies nothing on localhost.

*Python backend* (`36-python-backend.md`):
- Owner inference for brace languages counts braces from the class line, so a top-level function can become a method of the class above it.
- On a `.vue` file, only the first `<script>` element is read.
- The dependency engine picks an edge target from a set, so the result depends on `PYTHONHASHSEED`.

*Export classifier* (`35a-ts-pipeline.md`):
- Its code and stage regexes disagree on some messages.
- A partial export can report "0 revision source(s)".
- The export step's progress increment is fixed.

*Other:*
- The stderr reader can split a JSON progress line across two pipe chunks (`34-logging.md`).
- Missing awaits are marked `// 1.3.0:` (`35b-ts-dedup.md`).
- The dependency panel's shared-state fetch does not check snapshot identity (`37-runtime-dedup.md`).
- The chart-type row says "for XR mode" in LivePanel mode (`40-tree-assets.md`).

**Product decisions for the maintainer**
- `codeXR.pythonEnv.debugFailInstallation` is contributed but reachable from nowhere. Gate it behind Development mode, or remove it.
- The "pie" BabiaXR example opens a doughnut chart, and `examples/charts/pie/population.html` cannot be reached.
- `package.json` `repository.url` points at `aMonteSl/CodeXR`, so the Marketplace `docs/` links only work while that repository redirects.

**Tooling and docs**
- Branch protection, to make CI required.
- The backend tests need Python 3.10+, while the backend itself targets 3.7+.
- The project-evolution harness needs CDN access, or vendored scripts, before it can be a CI gate.
- Two dependency fixtures are byte-identical (`32-monorepo-seams.md`).
- `templates/components/COMPONENTS.md` still names the `runtimeAssembly` path from before #55.
- `CLAUDE.md` and the skills still carry the lines that #41 found stale.
- The two PNG-in-SVG icons still need a visual re-export.

## 10. Consolidated maintainer checklist (F5 and installed VSIX)

This list merges the F5 lists of every session log, without duplicates, ordered by feature. It assumes:
- "Run CodeXR Extension" with a fresh user-data directory;
- a Git sample project as the workspace, plus `backend/manual_test/` for the per-language and HTML fixtures;
- for part K, the packaged VSIX installed in a clean profile.

*(E2E)* marks what section 8 already verified automatically. For those, a visual confirmation is enough.

**A. Activation, output and sidebar**
1. **Before starting:** delete `.vscode-test/dev-extension`. It holds a staged copy with the old `sumaryFiles/` folder.
2. **Startup:** activation shows no error toast.
   - Stale folders in the workspace storage `analysis/`, older than the activation, are removed at startup.
   - A fresh analysis started right after activation is kept.
3. **Quiet output:** with `codeXR.debug.verboseLogs` off, *Output → CodeXR* shows only the startup line. *(E2E)*
4. **Verbose output:** turn verbose logs on. *(E2E)*
   - "Verbose logging enabled." appears.
   - Later actions log `[DEBUG]` lines with their scopes.
5. **Errors:** trigger a failure, for example an analysis with the Python environment deleted. It appears as `[ERROR]`.
6. **Developer Tools:** open Help → Toggle Developer Tools. There are no CodeXR lines during normal use.
7. **Sidebar:** the activity-bar icon opens the CodeXR view. *(E2E: order)*
   - The eight roots render in order: SERVERS, ACTIVE SERVERS (with the nested Collaboration group), BABIA EXAMPLES, VISUALIZE DATA, ANALYSIS, PYTHON ENV, VISUALIZATION SETTINGS, LEARN MORE & SUPPORT.
   - Check with a server running and without one.
   - Children and icons match 1.2.0, including "Chart Type (File): …" and "Chart Type (Directory): …".
   - The TTCN-3 icon and the default language icon look as before.
   - The ANALYSIS children could not be listed under the fake host, so check them here.
8. **Context menus:** they are the 1.2.0 ones on:
   - an active server, a collaboration participant, an active analysis, a Babia example and a visualization-setting row;
   - in the Explorer and in the editor: the `Code-XR: Analysis` submenu and Run Last.
9. **Command Palette:** type "Hello", "Debug" and "CodeXR".
   - None of "Hello World", "Debug Python Environment Failure" or the theme-debug commands appears.
   - Every other contributed command is listed, except the 11 Run-Last ones.

**B. Python environment**
10. **Install and commands:** PYTHON ENV goes from installing to ready. *(E2E)*
    - The analysis menus are disabled while it installs and enabled afterwards.
    - Status and Verify work. *(E2E)*
    - Reinitialize works, and so does Delete followed by Create.
11. **Older Python:** on Python 3.8 or 3.9, any analysis runs. The backend now loads there.

**C. Analyses**
12. **The 11 kinds:** run each analysis kind once. *(E2E: launch and page)*
    - Each opens its scene or panel and adds a row to Active Analyses and to ACTIVE SERVERS.
    - Run Last re-runs the last kind.
13. **Duplicates:** analyse the same file twice while it runs, then again once it is complete.
    - First you get "already in progress", then "Analysis already complete…".
    - "Open Active Analyses" opens the view.
14. **Comment lines:** run an XR file analysis on a `.hh` file. Comment lines are still counted.
15. **Progress:** in directory analyses (LivePanel, deep, XR), the progress notification counts "n/total (pct%) - file" up to the total.
16. **Incremental re-analysis:** edit a file under an analysed directory. *(E2E: XR file re-analysis)*
    - The scene or panel updates, in XR and in LivePanel.
    - Adding a file makes it appear; deleting it makes it disappear.
    - A 5 s debounce delays the update, and turning Auto-Analysis off stops it.

**D. XR scene**
17. **The chart:** the boats chart appears. *(E2E: `CodeXR.help`, BabiaXR components, no page errors)*
    - Hovering a bar shows the tooltip metric grid.
    - Field Mapping switches through all 8 chart types and remaps the dimensions.
    - The logo shows over an empty table.
    - The guide screen and guide.html load.
    - `CodeXR.help()` works in the console.
18. **Assets:** the network tab shows these runtimes, all with status 200:
    - `codexrCommonRuntime.js`, `codexrGitRefPickerRuntime.js` and `codexrAvatarRuntime.js`;
    - `codexrRoomRuntime.js`, together with `assets/codexr/xr-room/textures/*.svg`;
    - `codexrImmersiveRigRuntime.js` and `codexrPointerPolicyRuntime.js`;
    - `renderBudgetRuntime.js`, `dependencyVisualBudgetRuntime.js` and `codexrDebugRuntime.js`.

    The output channel has no "not found at" error, and the browser tab shows the Code-XR favicon.
19. **VR and AR,** with the WebXR emulator, following `docs/xr-testing/XR_MANUAL_CHECKLIST.md`:
    - one laser, flying, and recentring in AR; the room is gone in AR;
    - the fill light is on in AR and off on exit, and the rig pose is restored on exit;
    - the desktop-only debug controls hide in VR/AR and come back on exit;
    - in VR, render quality steps down under load.
20. **Virtual screen:**
    - create it, drag it with the mouse and with a controller, resize it, minimize and expand it;
    - toggle look-at and follow;
    - the DevTools console stays quiet while dragging and while follow is on.
21. **Live reload:** the browser console stays quiet during live reload. Setting `LIVE_RELOAD_DEBUG_MODE = true` in the session's `main.js` brings the trace back.

**E. In-scene modes, in a Git workspace** *(E2E: entering each mode)*
22. **Dependency graph:**
    - the three layouts, node selection, and back to normal;
    - switching between file and project scope;
    - on a dense project, edge widths and opacity adapt, and the detail override cycles;
    - open a file's scope twice, edit the file, then open it again;
    - nodes, `contains` edges and external nodes look as before.
23. **Historical comparison:**
    - The picker lists branches, tags, commits and the working copy, with "Live" first. The category tabs, the Oldest/Newest toggle and paging all work.
    - Compare two commits, two branches and a tag, in a repository with a merge commit and a remote branch. Then compare a nested folder. In each case boats appear and the mapping view opens.
    - Re-entering the mode opens the mapping view with the cached result.
    - Starting a second compare while one runs gets the "busy" reply.
    - The comparison refreshes live on save.
24. **Project evolution:**
    - Generating over 3 or more commits shows "Analyzing N project revisions with C workers".
    - The frames play, with play, pause and speed controls.
    - `evolution/revision-N/` holds the data files.
    - Clearing the movie empties the room; generating again increments N.
25. **Outside a Git repository:** the two Git modes are disabled, with a reason shown.

**F. LivePanel and DOM** *(E2E: LivePanel tables and SSE; the DOM page is served)*
26. **LivePanel file and directory,** deep and not:
    - The tables render and sort (File Details, Most Complex Files); the charts and the theme toggle work.
    - Editing a file makes "New data received" flash and the update notification appear, and the tables refresh.
    - The dependency summary and the historical panel refresh over SSE.
    - Stopping the server shows "Disconnected".
    - With Open Mode set to lateral panel, the panel opens inside VS Code over HTTP.
27. **DOM visualization** of `backend/manual_test/html_dom_fixture.html`:
    - the page renders in a desktop browser, which headless Chromium could not confirm;
    - editing the file updates the scene.

**G. Active Analyses**
28. **Sessions:** icons, colours and tooltips are right for file and directory sessions.
    - Left-click shows the actions quick pick: View Details, Open in Browser, Export, Close.
    - Stopping the analysis server from ACTIVE SERVERS cleans up the analysis, and the notification names the port.

**H. Export Analysis Folder**
29. **Export:** export an XR directory analysis with all modes, twice:
    - once with the entire history, and once with "latest N" commits (N = 5);
    - at both Balanced and Maximum speed;
    - the confirmation names the commits and the workers.
30. **Serve the copy statically:**
    - It boots in Normal analysis.
    - The dependency graph, historical comparison and project evolution all work offline.
    - Export again with only Normal selected: that copy opens in Single.
31. **Layout and edge cases:** the layout matches a 1.2.0 export: `git-revisions/`, `dependencies/`, `codexr-export-manifest.json` and `README-EXPORT.md`.
    - Cancelling midway shows "Analysis export cancelled. No partial folder was published."
    - Exporting to an existing folder shows the "already exists" warning.

**I. Servers**
32. **Configuration rows:** the three HTTP modes (including the default certificate and a custom one), port, auto-open, open mode, cross-network and reset all work.
    - Start Local Server with an HTML file.
    - Two servers running at once get different ports. *(E2E)*
33. **HTTPS in lateral-panel mode:** you get the "Launching in HTTP mode…" warning, and "Change to Browser Mode" opens the setting.
34. **Launch toasts,** with auto-open off:
    - "Open Now" works in both modes, and so does "Copy Network URL";
    - with a busy port, the "Port X was busy" notice appears.
35. **ACTIVE SERVERS,** for each server: *(E2E: Stop All closed every port)*
    - Copy the local network address.
    - The actions work: open in browser on HTTP and HTTPS, open in panel (HTTP only), copy address, server information, stop server.
    - The tooltip shows `File: <name>` for a served HTML file.
    - The tree refreshes on start and on stop.
    - Stop All, and the view-title Refresh and Stop All buttons, work.
    - Compare the number in "Stop all N server(s)?" with 1.2.0: in the E2E it said 20 while 13 ports were listening.

**J. Collaboration, broadcast, remote**
36. **Collaboration,** with two browsers:
    - Names and avatar colours are assigned, and the avatars move.
    - An entity lock is held, then released.
    - The host is transferred, and the presenter is handed over and then stopped.
    - A guest is kicked from the participant modal, and from the tree (Remove from Session).
    - Stopping the server shows "session ended".
    - The COLLABORATION rows work: Join Remote Session, Name, Avatar Color, 3D Model.
37. **Screen broadcast:**
    - Share a tab, both peer-to-peer and through the relay.
    - A second participant joins; the one-broadcaster rule holds.
    - A congested viewer drops frames for itself only.
    - Stopping the share ends it for every viewer.
    - The chrome looks as before.
38. **Remote access:**
    - Start the remote connection: the first time, the cloudflared consent modal appears; then the server is shared.
    - Copy the invitation, and join from another network with the pairing code.
    - Regenerate the code, view the status, then stop.
    - Declining consent shares nothing. *(E2E)*
    - Stopping a server that has remote access on also stops its tunnel.

**K. Other sidebar sections and the installed VSIX**
39. **BABIA EXAMPLES:** open About BabiaXR, then launch each of the 7 examples. *(E2E: all 7 render their BabiaXR components)*
    - Check whether Barsmap and Pie show data. Here they got 404 for `sales.json` and `population.json`, on both the old and the new package (section 9).
40. **VISUALIZE DATA:** pick a chart type and `examples/data/sales.json`.
    - Map a field already used by another dimension: the warning names that dimension.
    - The field list shows "N values • Samples: …".
    - The validation messages match 1.2.0.
    - Launch, Browse Visualizations, relaunch and reset all work.
    - The state survives a reload.
41. **VISUALIZATION SETTINGS:** these all work, and each is visible in a new XR scene:
    - background and ground colour through the colour picker;
    - the 12 environment presets and the 9 palettes;
    - reset.
42. **ANALYSIS settings:**
    - All 11 rows change and persist across a reload, including the custom auto-analysis delay.
    - Picking in a Chart Type row updates the row and resets the dimension mappings.
    - Profiles: Save, Load, Delete and Reset.
    - Files by Language: grouping, sorting and click-to-analyse work, and adding a file refreshes the list.
43. **LEARN MORE:** the three rows open the docs site, the author site and Buy Me a Coffee. *(E2E: the URLs)*
44. **Shutdown:** close the window while servers and a tunnel are running. *(E2E: deactivate and ports)*
    - No `cloudflared` process is left behind.
    - The ports are released.
45. **Installed VSIX:** install `code-xr-1.2.1.vsix` in a clean profile, then repeat rows 7, 12 and 17.
    - The Extensions view shows the icon.
    - One Babia example opens.
    - The colour picker opens.
46. **Optional fallbacks:**
    - With `dist/code_analysis/python` renamed, the "workspace direct" launch config still analyses, using `backend/src`.
    - On an installed VSIX with `dist/code_analysis/python/main.py` removed, an analysis fails with "Python script does not exist" and runs nothing outside the extension.
