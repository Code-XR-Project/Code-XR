# Code-XR cleanup sweep: non-`src` areas and monorepo seams

Date: 2026-11-25. Branch `claude/project-thread-n2s3q6`, at HEAD `399494af` (clean tree). Read-only sweep: no repo file was modified.
Scope: root config, `.github/`, `.vscode/`, `.mcp.json`, `adr/`, `docs/`, `media/`, `pages/`, `.claude/`, and the non-`src` parts of `apps/vscode-extension` (`scripts`, `manual_test`, `examples`, `resources`, `docs`, `test/runners`, `test/tooling`, `test/manual`, `test/fixtures`, build configs). Also `apps/ide`, `packages/`, `backend/`, and the fixtures shared across `backend/tests` and the extension tests.
Method: a byte-identical-duplicate scan (md5 over every tracked-size file, excluding node_modules/.git/dist/out/lockfile), a grep for each candidate's basename across READMEs, CHANGELOG, `src/`, `templates/`, `test/`, `.claude/`, the website repo (Code-XR-Project/code-xr-docs: `src`, `scripts`, `assets-src`, `public`), the `package.json` `files` allowlist and the webpack CopyPlugin config, and a check of each candidate against `ROADMAP.md` §E/§F and `AUDIT.md`.

Verdicts: **dead** (nothing consumes it), **duplicate**, **stale** (content or paths are out of date), **misplaced** (alive, but in the wrong place after the move), **alive-looks-dead**.
Roadmap: a row id when ROADMAP already covers it, **NEW** when it does not, **NEW-ext** when a roadmap row exists but misses a touchpoint that the move created.

---

## 1. Root config, CI, editor

| # | Path | Size | Evidence | Verdict | Roadmap |
|---|---|---|---|---|---|
| R1 | `.mcp.json` | 130 B | `"command": "cmd", "args": ["/c","npx","-y","@iwer/extension-bridge"]`. Only runs on Windows. That contradicts `docs/monorepo.md` "Linux, Windows and macOS are all first-class" and the macOS/ubuntu CI matrix. Nothing in the repo reads it (it is the IWER MCP server for Claude Code). | stale (cross-platform) | **NEW** |
| R2 | `.gitignore` lines `backups/`, `.codex/`, `.codexr/`, `memoriaTFG/` | 4 lines | No code, script or doc creates or mentions `backups/`, `.codex/` or `memoriaTFG/` (grep across the repo: only `.gitignore` itself). Nothing writes `.codexr/`: the only `.codexr` token in `src` is the temp-dir infix `.<name>.codexr-export-<uuid>` (`exportPackageTransaction.ts:53`). These are personal-machine leftovers. | stale | **NEW** (low) |
| R3 | `.gitignore` `certs/`, `**/dist/certs/` + `scripts/package-vsix.mjs:17-27` (the `certs/**/*` allowlist guard and the `dist/certs` sweep) | 2 lines + about 10 lines | Certificates are generated now in global storage (`generatedHttpsCertificateManager.ts:26` `server-certs`). `dist/` is already ignored as a whole, so `**/dist/certs/` is redundant. The allowlist has no `certs` entry. These guards are for a layout that no longer exists. | stale (defensive leftover) | **NEW** (low; keep the `dist/certs` sweep only if old dev trees matter) |
| R4 | root `package.json` script `test:integration` | 1 line | It mirrors the dead extension lane (W2-68). W2-68 lists `.vscode-test.mjs`, the extension `package.json:764`, `DEVELOPMENT.md` and `test/README.md`, but not the root mirror, which the move created. | dead (once W2-68 lands) | **NEW-ext** of W2-68 |
| R5 | root `package.json`: no `engines.node`, no `packageManager` | n/a | Dev needs Node 24 (`--test-isolation=none`, `DEVELOPMENT.md:12`), which only `.nvmrc` records. Neither workspace declares `engines.node`. | inconsistency | **NEW** (low) |
| R6 | `.github/workflows/deploy-pages-redirect.yml` | 738 B | Alive: it publishes `pages/`. It redeploys on every push to `master` and on every release, with no `paths: [pages/**]` filter. | alive (minor inefficiency) | **NEW** (low) |
| R7 | `.github/workflows/ci.yml` | 4.4 KB | Alive and post-move correct. Runners are called by repo-relative path, `dist-fingerprint.mjs` resolves `dist` from its own location, and `--out` resolves against cwd (root), which matches the upload path. The backend suites still run through `apps/vscode-extension/test/runners/run-python-tests.cjs` (see S1). | alive | - |
| R8 | `.vscode/launch.json`, `tasks.json`, `extensions.json` | 1.0 KB / 530 B / 60 B | Retargeted to `apps/vscode-extension`, and pinned by `test/analysis/devLaunchConfig.test.cjs` (reads `../../.vscode`). One subtlety: the "workspace direct" config is the only one in which the `../../backend/src` dev fallback resolves (see S4). | alive | - |
| R9 | `LICENSE` (root) vs `apps/vscode-extension/LICENSE` | 32 KB each, byte-identical | Deliberate: the VSIX needs its own copy (`files` allowlist), and `docs/monorepo.md` documents it. | alive-looks-dup | - |
| R10 | `README.md` (root) | 2.8 KB | It says `media/` is "used by the README and the website". In fact the extension README loads every image from `raw.githubusercontent.com/aMonteSl/CodeXR/v1.2.0/...` (31 URLs, all pinned to the tag), and the website keeps its own byte-identical copies (see M1). No consumer reads `media/` at HEAD. | stale claim | **NEW** (low) |

## 2. `apps/vscode-extension` build configs and scripts

| # | Path | Size | Evidence | Verdict | Roadmap |
|---|---|---|---|---|---|
| E1 | `esbuild.config.mjs` | 331 B | No script references it, and `esbuild` is not even a devDependency. `docs/monorepo.md:31` now also names it in the "What moved where" table: W2-03 must touch that file too. | dead | W2-03 (**NEW-ext**: `docs/monorepo.md:31`) |
| E2 | `.vscode-test.mjs` + `test:integration` + `@vscode/test-cli`/`test-electron`/`@types/mocha` | 117 B | The pattern `out/test/**/*.test.js` matches nothing. `docs/monorepo.md:31` names it as well. | dead | W2-68, W2-69 (**NEW-ext**: root mirror R4 + `docs/monorepo.md:31`) |
| E3 | `tsconfig.json` excludes (4 phantom paths), `"types": ["mocha",…]`, `"lib": [...,"DOM"]` | 956 B | As the audit says. | dead config | W2-02, W2-69, W3-06 |
| E4 | `eslint.config.mjs` (unscoped first block; lint only `src`) | 629 B | As the audit says. | weak | W3-01, W3-02, W3-11 |
| E5 | `webpack.config.js` backend copy `globOptions.ignore: ['**/*.ts', …]` | 1 line | `backend/src` holds 24 `.py` files and no other file type (`find backend/src -type f ! -name '*.py'` is empty). The `**/*.ts` ignore is a leftover from when Python sat inside the TS `src/` tree. | stale (harmless) | **NEW** (trivial) |
| E6 | `webpack.config.js` copies `templates/`, `examples/` into `dist/` | - | Shipped twice in the VSIX. | duplicate | W5-56 (PKG-03) |
| E7 | `scripts/dist-fingerprint.mjs`, `scripts/dist-diff.mjs` | 3.6 KB / 6.9 KB | No npm script runs them, but CI (`ci.yml` "Fingerprint dist"), `test/packaging/distCharacterization.test.cjs` and `DEVELOPMENT.md` reference them. | alive-looks-dead | (the W1 fingerprint step) |
| E8 | `scripts/prepare-dev-extension.mjs` | 2.4 KB | Run by `compile:dev-host` and the primary F5 task. | alive | - |
| E9 | `scripts/report-manual-metrics.py` | 2.9 KB | Run by `run-analysis-tests.cjs:108` (`--report-only`). It is a **backend** tool: it imports only `backend/src` modules (`PROJECT_ROOT.parents[1]/'backend'/'src'`) and reads `manual_test/`. | misplaced (see S1) | **NEW** (seam) |
| E10 | `scripts/package-vsix.mjs` | 4.6 KB | Alive and post-move correct (`--no-dependencies`, base URLs). It still carries the stale `certs` guard (R3), and its base URLs use the old `aMonteSl/CodeXR` repo (D3). | alive | R3 / D3 |

## 3. `apps/vscode-extension` resources, examples, docs, manual tests

| # | Path | Size | Evidence | Verdict | Roadmap |
|---|---|---|---|---|---|
| X1 | `resources/languages_icons/no_color/` (25 PNG) | **34 MB** of the 39 MB `resources/` | Not in the allowlist, and nothing consumes it. | dead | W2-67 |
| X2 | `resources/favicon.ico` = `resources/icon.png` (byte-identical, md5) | 1.18 MB each | `saveFiles.ts:143` copies the `.ico` into every output folder. | duplicate | T55 (PKG-02) + register #2 (re-encode the icon) |
| X3 | `resources/languages_icons/color/default.svg` = `no_color/default.png` (byte-identical) | 1.35 MB | `default.svg` is a PNG misnamed `.svg`, and so is `ttcn3.svg` (1.40 MB). | duplicate / mis-encoded | register #2 (and the twin disappears with W2-67) |
| X4 | `resources/icon.svg` | 6 KB | Used by `colorPickerUtils.ts:58-59` and in the allowlist. | alive | - |
| X5 | `examples/charts/pie/population.html` | 1.9 KB | It is a near-copy of `pie/index.html` (only the title, the description and the environment preset differ). `exampleLauncher.ts:209` picks `index.html` first, so this file is never opened. It ships twice (`examples/**` and `dist/examples`). | dead twin | **NEW** |
| X6 | `examples/data/{gdp,simple_sales,temperatures,test_functions}.json` | 3.1 KB total | The examples reference only `population.json` and `sales.json` (`babia-queryjson` grep). The other four have no reader in `examples/`, `src/` or `templates/`. The only mention is the generic UI string "Sample JSON in examples/data" (`babiaExamplesCommands.ts:52`). | dead | **NEW** |
| X7 | `docs/project/ROADMAP_V1.2.0.md` | 15 KB | Shipped in the VSIX (`docs/**/*`). Only `.claude` docs reference it, and the README does not link it. It is an internal planning doc for a closed cycle, and `INDEX.md:45` still labels it "ES" although it is in English now. | misplaced / stale | W5-56 (PKG-04) covers the shipping. The content staleness is register #30. The `INDEX.md:45` "ES" label is **NEW** (trivial) |
| X8 | `docs/features/PROJECT_EVOLUTION_XR.md` | 3.5 KB | No README link, but `historicalComparison.test.cjs` reads it. | alive-looks-dead | - |
| X9 | `test/manual/xr-mode-history-left.json` = `xr-mode-normal-data.json` (byte-identical) | 430 B each | `xr-mode-cycle-harness.html:61` and `:429/:576` reference both. It is a fixture twin, harmless. | duplicate (benign) | **NEW** (cosmetic; one file could serve both URLs) |
| X10 | `test/fixtures/dependency-languages/javascript_sample.js` = `typescript_sample.ts` (byte-identical) | small | Read only by the backend golden/dependency tests. Identical content gives the TS arm no TS-specific syntax to exercise. | duplicate | **NEW** (low; give the TS sample real TS syntax, which regenerates the goldens) |
| X11 | `test/README.md` | 3.5 KB | Its "Structure" section lists 3 of 17 directories and still advertises `test:integration`. | stale | W3-17 (+ W2-68) |
| X12 | `manual_test/README.md` | small | It says "intended for … manual validation inside the extension and automated backend validation". The layout is flat (`<lang>_metrics.<ext>` + `deep/`). | alive | - (see C3 for the skill that describes it wrongly) |

## 4. Monorepo seams (backend ↔ extension)

| # | Path | Size | Evidence | Verdict | Roadmap |
|---|---|---|---|---|---|
| S1 | The backend's test runners live in the extension: `apps/vscode-extension/test/runners/run-python-tests.cjs` (runs `backend/tests`), `run-analysis-tests.cjs` (builds a venv, runs `test/analysis/manual_metrics_suite.py` + `scripts/report-manual-metrics.py`, which are all backend-only), `run-html-analysis-tests.cjs`. Root `test:backend` = `npm run test:python --workspace=code-xr`. | 2.6 + 3.6 + 3.4 KB | `backend/` has no package.json, runner or dependency manifest. A future `apps/ide` would have to reach into `apps/vscode-extension/test/runners` to test the shared backend. `backend/README.md` already documents a direct `python -m unittest discover -s backend/tests` (verified: 52 tests, OK, from the root). | misplaced | **NEW** (seam; do it with S2/S3) |
| S2 | `apps/vscode-extension/test/fixtures/dependency-languages/` (30 files) | 128 KB | Its **only** consumers are `backend/tests/dependencies/test_dependency_golden.py:127-130` and `test_dependency_analysis.py:21`. No `.cjs` test reads it (`grep -rn dependency-languages test --include=*.cjs` is empty). The goldens in `backend/tests/dependencies/golden/` are built from it. | misplaced (backend fixture in the app) | **NEW** |
| S3 | `apps/vscode-extension/manual_test/` (31 files) and `test/analysis/manual_metrics_suite.py` | 128 KB + py | Consumed by `backend/tests/html_dom/test_html_dom_protocol.py:14-15`, `manual_metrics_suite.py`, `report-manual-metrics.py` and `run-analysis-tests.cjs`: all of them exercise the Python backend. `manual_metrics_suite.py` is the only `.py` among the 52 `.cjs` suites in `test/analysis/`. W1-17 edits it at its old path. | misplaced | **NEW** (W1-17 / W3-01 reference the old location) |
| S4 | Dev fallback `path.join(extensionPath,'..','..','backend','src',…)` in `executePython.ts:399,407` and `gitRevisionExporter.ts:81` | 3 sites | Before the move the fallback was `<extensionPath>/src/code_analysis/python`, inside the extension folder. Now it escapes it. In an installed extension (`~/.vscode/extensions/amontesl.code-xr-x.y.z`), `../..` is the user's **home directory**. If the `dist` copy is ever missing, the extension would spawn `~/backend/src/main.py` (or the export worker) if such a file exists. Under the primary F5 config (staged copy in `.vscode-test/dev-extension`) the fallback resolves to `apps/vscode-extension/backend/src`, which does not exist, so it only works in "workspace direct". Suggest gating it on `context.extensionMode === Development`. | misplaced / hazard introduced by the move | **NEW** (src, but a seam the move created) |
| S5 | Python dependency pin lives in TS: `src/python_env/runtime/pythonPackageManifest.ts` (lizard, tree-sitter-language-pack). `run-analysis-tests.cjs:82-86` regex-scrapes it. | - | `backend/` has no `requirements.txt` or `pyproject.toml`. The IDE cannot reuse the pin without importing extension TS. | misplaced (for the IDE) | **NEW** (record for 1.3.0 / `packages/core`) |
| S6 | Repo-wide text policies (emoji, NUL) in `apps/vscode-extension/test/analysis/uiPolicy.test.cjs:105-135` | - | They scan `../../backend` and `../../.claude`, but not the new root text: `docs/`, `adr/`, `packages/README.md`, `apps/ide/README.md`, root `README.md`, `media/*.md`, `.github/`. These are all clean today (checked), so this is a coverage gap. A repo-level policy also lives in one app's suite. | misplaced / gap | **NEW** (low) |
| S7 | `backend/tests/__init__.py` and 5 sibling `__init__.py` files (1 byte, a newline) vs 3 (0 bytes) | - | Inconsistent. They are required for discovery (`DEVELOPMENT.md:27`). | alive | - (cosmetic) |
| S8 | `backend/src/livePanels/file_reanalysis_coordinator.py` = `backend/src/sumaryFiles/file_reanalysis_coordinator.py` (byte-identical) | 2 x ~3 KB | Known. | duplicate | W2-58, P20 |
| S9 | `backend/src/examples/` | 1 file | Known. | dead | W2-59 |
| S10 | `__pycache__` / `.pyc` under `backend/` or `apps/` | 0 | None found. The webpack `context` fix keeps them out of the VSIX. | clean | - |

## 5. `media/` (248 MB tracked, 72 files)

| # | Path | Size | Evidence | Verdict | Roadmap |
|---|---|---|---|---|---|
| M1 | `media/v1.1.0/gifts/analysis_{babiaXR,file,jetuml,express}.gif` | **158 MB** (45.6 + 42.6 + 39.4 + 30.7) | Zero references in the README, CHANGELOG, `.claude`, `docs` or the website (`code-xr-docs/src` + `assets-src` + `public`: 0 hits). | dead (working-tree weight) | **NEW** for the working tree. STATUS #8 / register #29 only covers the **history** rewrite, which removing them at HEAD does not fix |
| M2 | `media/v1.1.0/{analysis-table/analysisTableAndMappingUI.png, collaborative/collaborativeWorkspace.png, screen/virtualScreenAndControler-v.1.1.0.png}` | 3.5 MB | Zero references anywhere (repo or website). | dead | **NEW** |
| M3 | `media/v1.1.0/comparison/*` (2 GIF, 2 PNG) | 23.5 MB (`performance-v1.0.0.gif` alone 19 MB) | Used only by the website's archive chip, which holds byte-identical copies in `code-xr-docs/assets-src` + `public`. Not used by this repo. | duplicate of website masters | **NEW** |
| M4 | `media/v1.2.0/**` (60 files) | 71 MB | All 62 media files that the website uses are **byte-identical** to the copies in `code-xr-docs/assets-src`/`public` (cmp: 62 same, 0 differ). The extension README loads them from the `v1.2.0` **tag** through absolute raw URLs, not from HEAD. Nothing reads `media/` at HEAD; it is an archive of masters plus `SHOTLIST.md`/`VIDEOS.md`. The six 2x analysis PNGs are 2.9-3.1 MB each. | alive as archive (duplicate across repos) | **NEW** (policy decision: keep the masters in one repo) |
| M5 | `media/SHOTLIST.md`, `media/v1.2.0/videos/VIDEOS.md`, `project_evolution_voiceover.md` | 17.5 KB + small | Used by the `capture-media` skill and linked from the README (VIDEOS.md). No "pending" rows remain, and the referenced `.mp4` files are deliberately gitignored. | alive | - |
| M6 | `apps/vscode-extension/README.md:75` link `../../media/v1.2.0/videos/VIDEOS.md` | 1 link | The move made the link climb out of the package (it was `media/...`). It is broken in VS Code's local extension-details view (media is not in the VSIX) and depends on vsce's `--baseContentUrl` + `..` normalisation on the Marketplace. All the other media links are absolute raw URLs. | stale (move-introduced) | **NEW** (low; make it absolute like the others) |

## 6. `adr/`, `docs/`, `pages/`, `apps/ide`, `packages/`

| # | Path | Size | Evidence | Verdict | Roadmap |
|---|---|---|---|---|---|
| A1 | `adr/assets/0001-ide-preview/` (8 PNG + README) | **7.2 MB** (2880x1800 2x captures, 0.7-1.4 MB each) | Neither `adr/0001-code-xr-ide-platform.md` (it mentions "a working preview" at :37 without a link) nor `adr/README.md` links the folder. A grep for `ide-preview` across the repo's markdown finds nothing. The folder README also embeds a private `claude.ai/artifact/...` link. | orphan (unlinked) + oversized | **NEW** (link it from ADR 0001; downscale to 1x or WebP, about 10x smaller) |
| A2 | `docs/monorepo.md` | 5.6 KB | Accurate today. Its "What moved where" row names `esbuild.config.mjs` and `.vscode-test.mjs`, which W2-03 and W2-68 delete. | will go stale | **NEW-ext** of W2-03 / W2-68 |
| A3 | `pages/index.html` + deploy workflow | 704 B | Alive: a redirect to the website. | alive | - |
| A4 | `apps/ide/README.md`, `packages/README.md` | 1 KB / 2 KB | Deliberate placeholders, and accurate. | alive | - |
| A5 | `backend/README.md` | 1.6 KB | Accurate. Its direct `unittest discover` command was verified (52 OK). | alive | - |

## 7. `.claude/` (docs, skills, plans)

| # | Path | Size | Evidence | Verdict | Roadmap |
|---|---|---|---|---|---|
| C1 | `.claude/skills/session-close/SKILL.md` | 2.3 KB | It still runs the **1.2.0** cycle. Its description says "update V1.2.0_STATUS.md"; §2 says to edit `V1.2.0_STATUS.md` and CHANGELOG `[1.2.0] – Unreleased`; §4 says "Branch: `v1.2.0`". All of these contradict CLAUDE.md (V1.2.0_STATUS is historical, branch `v1.2.1`, CHANGELOG `[1.2.1]` dated). The STATUS log says these docs were corrected, but this skill was missed. | stale | **NEW** |
| C2 | `.claude/docs/AI_WORKFLOWS.md:22,28,60,63,67-69` | 10 KB | The feature, docs and release playbooks still read and update `V1.2.0_STATUS.md` and `ROADMAP_V1.2.0.md` and reconcile `[1.2.0] – Unreleased`. | stale | **NEW** |
| C3 | `.claude/skills/add-language/SKILL.md:19` | 2.5 KB | It says "`manual_test/<language>/` per-language fixture". The real layout is flat files `manual_test/<lang>_metrics.<ext>` + `deep/`. Line 34 says to record mismatches in `V1.2.0_STATUS.md`. | stale | **NEW** |
| C4 | `.claude/skills/verify/SKILL.md:16-22` | 2.8 KB | Its single-suite commands (`node --test test/analysis/<suite>.test.cjs`) only work with cwd `apps/vscode-extension`, but CLAUDE.md tells agents to run commands from the root. It has no note about cwd or the path convention. | stale (move seam) | **NEW** (low) |
| C5 | `CLAUDE.md` "Safety rules" | - | "record inconsistencies in `V1.2.0_STATUS.md` → Documentation debt". The same file calls V1.2.0_STATUS historical, and INDEX.md:71 routes doc debt to `V1.2.1_STATUS.md` first. | inconsistency | **NEW** (trivial) |
| C6 | `.claude/plans/livepanel-v1-2-0-enhancements.md` | 12 KB | It is the technical plan for 1.2.0 LivePanel work (shipped 2026-07-30). Nothing references it: not INDEX.md, CLAUDE.md, any skill or any doc (grep `plans/`). | stale / orphan | **NEW** (move into a history folder or fold into V1.2.0_STATUS) |
| C7 | `.claude/docs/DEVELOPMENT.md:78` | - | "Also `manual_test/` (**repo root**)". The general banner at :7 does not override this explicit claim. | stale (move) | **NEW** (trivial) |
| C8 | `.claude/docs/DEVELOPMENT.md:89-90`, `:93` | - | They still say esbuild "Needs verification" and mention the helloWorld leftover. | stale | W2-03, W2-50, W2-68 already list these lines |
| C9 | `.claude/docs/XR_COMPONENTS.md:19,32` | - | `codexrVisualStyleRuntime.js` "v1.2.0 work in progress"; project-evolution "in progress for v1.2.0" (shipped). | stale | :19 is W2-55. **:32 is NEW** (trivial) |
| C10 | `.claude/docs/INDEX.md:45` | - | Labels `docs/project/ROADMAP_V1.2.0.md` as `ES`; the file is in English. | stale | **NEW** (trivial) |
| C11 | `.claude/docs/V1.2.0_STATUS.md` (309 KB), `v1.2.1/AUDIT.md` (276 KB) | 585 KB | Large, but both are intentional records (historical, and "grep, never read whole"). | alive | - |
| C12 | Pre-move paths across `.claude/docs` + skills (`src/code_analysis/python` 10x, `test/python` 8x) | - | Covered by the documented path convention in CLAUDE.md, INDEX.md:6 and DEVELOPMENT.md:7. No action unless docs are rewritten. | stale-by-convention | - |

## 8. Cross-repo / identity

| # | Path | Evidence | Verdict | Roadmap |
|---|---|---|---|---|
| D1 | Website `code-xr-docs/README.md` | The website's CLAUDE.md says it is a byte-identical copy of "the CodeXR extension repo's README". After the move the repo has two READMEs (root = monorepo, `apps/vscode-extension/README.md` = extension), and the website copy matches neither at HEAD (md5). The sync rule should name `apps/vscode-extension/README.md` on the release tag. | stale (cross-repo) | **NEW** (website repo, not this one) |
| D2 | Website CLAUDE.md "v1.2.0 mirrors `CodeXR/media/v1.2.0`" | It is the same masters as M4; it is the reason this repo's `media/` is a duplicate. | duplicate | **NEW** (with M4) |
| D3 | `apps/vscode-extension/package.json` `repository.url` = `https://github.com/aMonteSl/CodeXR.git`; 31 README raw URLs and 9 links to `github.com/aMonteSl/CodeXR` | `git remote -v` is `https://github.com/Code-XR-Project/Code-XR`. No file in the repo mentions `Code-XR-Project`. `package-vsix.mjs` derives `--baseContentUrl`/`--baseImagesUrl` from `repository.url`, so every Marketplace link depends on GitHub's transfer redirect, which breaks if a new `aMonteSl/CodeXR` repo is ever created. | stale | **NEW** (needs maintainer confirmation of the canonical URL) |

---

## Notes

- **Biggest NEW wins by size:** the four `media/v1.1.0/gifts/*.gif` (158 MB) and three PNGs (3.5 MB) are referenced by nothing in either repo, and the `v1.1.0/comparison` set (23.5 MB) is duplicated in the website. Deleting them at HEAD shrinks every checkout by about 160-185 MB. It does **not** shrink `.git` (that is STATUS #8 / register #29, propose-only). The ADR preview PNGs (7.2 MB) are orphaned and could be about 10x smaller.
- **Biggest NEW seam:** the backend owns its sources and tests, but its fixtures (`test/fixtures/dependency-languages`, `manual_test`), its end-to-end suite (`manual_metrics_suite.py`), its report tool (`report-manual-metrics.py`), its runners and its dependency pin all live in the extension. To move them, retarget `backend/tests/**` (`parents[3]/'apps'/'vscode-extension'/…` at 4 sites), `run-*-tests.cjs`, `ci.yml` (3 steps) and `uiPolicy`'s scan roots in the same commit. W1-17 and W3-01 name the current locations.
- **S4 is the one item with a runtime consequence.** The dev fallback can now point outside the extension folder of an installed copy. It needs a corrupted install to trigger, but the fix is one condition.
- **No new zombie found in** `pages/`, `.vscode/`, `apps/ide`, `packages/`, `scripts/dist-*.mjs`, `scripts/prepare-dev-extension.mjs`, `test/tooling/*`, `test/manual/*.html` (all have consumers), or `backend/` (no `__pycache__`, no stray non-`.py` files).
- The existing roadmap rows W2-03, W2-67, W2-68, W2-69, T55, W5-56 and register #2/#29/#30 are confirmed still accurate after the move. W2-03 and W2-68 need two extra touchpoints (root `package.json` `test:integration` and `docs/monorepo.md:31`).
