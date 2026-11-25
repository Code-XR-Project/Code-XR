# Code-XR deep cleanup (epic #26)

> **Status:** in progress since 2026-11-25. **Tracking:** [epic #26](https://github.com/Code-XR-Project/Code-XR/issues/26) on the TFM board.
> **Branch policy:** one pull request per story, always against `v1.2.1`; nothing reaches `master` until the maintainer promotes the release.

## Why

Code-XR is the base of the TFM work (ML-assisted project insight, new immersive interaction) and of the future Code-XR IDE ([epic #11](https://github.com/Code-XR-Project/Code-XR/issues/11)). Before building on it, the extension is cleaned in depth **without losing any functionality**: no zombie code, no duplicated subsystems, low complexity, single-responsibility modules, guardrails against new rot, a smaller package and a monorepo layout that is ready to grow.

This epic executes the v1.2.1 cleanup programme approved on 2026-09-18 (`.claude/docs/v1.2.1/ROADMAP.md`, waves W2–W5) and extends it with a new sweep of every directory, made after the monorepo move.

## Documents in this folder

| Document | What it is |
|---|---|
| [`feature-baseline.md`](feature-baseline.md) | Exhaustive inventory of everything the extension has and does before the cleanup, with automated and manual verification steps (§10). The reference for "nothing was lost". |
| [`w2-revalidation.md`](w2-revalidation.md) | The W2 deletion rows of the roadmap re-checked against the monorepo tree: 57 valid, 16 need amendments, 1 partly invalid (W2-29). |
| [`sweep-outside-src.md`](sweep-outside-src.md) | Sweep of everything the original audit did not cover: root config, `.github/`, `.claude/`, `adr/`, `docs/`, `media/`, `pages/`, scripts, fixtures and the monorepo seams. |
| [`host-boundary.md`](host-boundary.md) | How the code depends on `vscode`, how templates are resolved and which folders form cycles: the layering work that prepares the IDE without starting it. |
| [`src-layout.md`](src-layout.md) | Story #55: the measured `src/` tree, its problems, the feature-first target tree (`app/ → features/ → core/ → platform/ → shared/`), the complete old → new move map (table and JSON), the batch plan and the H3 proof for a move. |
| [`modernization.md`](modernization.md) | Story #56: measured inventory of outdated idioms in TypeScript, the browser runtimes and Python, what to modernize, what to leave and the commit plan. |

Operational rules stay where they were: `.claude/skills/cleanup/SKILL.md` (how), `.claude/docs/v1.2.1/ROADMAP.md` (what and in which order), `.claude/docs/v1.2.1/AUDIT.md` (the 220 original findings). Per-story session logs go to `.claude/docs/v1.2.1/sessions/`.

## Baseline (2026-11-25, `v1.2.1` at `399494af`)

| Measure | Value |
|---|---|
| `npm test` (Linux) | 708 / 709 (one path-portability test failure, fixed in #28) |
| `npm run test:python` | 52 / 52 |
| TypeScript in `apps/vscode-extension/src` | 369 files, 52,988 lines, 2,865 functions |
| Modules unreachable from `extension.ts` | 54 (2,317 lines) |
| `console.*` calls / console-only catch blocks | 1,646 / 65 |
| `any` / suppressions | 219 / 0 |
| Functions with CCN over 10 / 15 / 20 / 30 (worst) | 81 / 31 / 10 / 6 (`buildExportManifest` 61) |
| Files over 500 lines / functions over 80 lines | 19 / 57 |
| Files importing `vscode` / transitively vscode-free | 179 / 101 |
| Two-way dependency cycles between top-level folders | 9 |
| Unused media in the working tree | about 170 MB |
| VSIX | 6.45 MB, 360 entries |

## Story map and execution order

| # | Story | Roadmap rows | Wave |
|---|---|---|---|
| [#27](https://github.com/Code-XR-Project/Code-XR/issues/27) | Feature baseline (verified at the end) | — | 0 / closing |
| [#28](https://github.com/Code-XR-Project/Code-XR/issues/28) | Safety net: portable baseline + feature-level characterization | W1 follow-up | 0 |
| [#29](https://github.com/Code-XR-Project/Code-XR/issues/29) | Delete unreachable modules and dead declarations | W2-01..44 | 1 |
| [#30](https://github.com/Code-XR-Project/Code-XR/issues/30) | Remove scaffold, debug and unreachable commands | W2-45..52 | 1 |
| [#31](https://github.com/Code-XR-Project/Code-XR/issues/31) | Remove dead templates, Python, assets, media, tooling | W2-53..69 + sweep | 1 |
| [#32](https://github.com/Code-XR-Project/Code-XR/issues/32) | Monorepo seams and stale documentation | sweep | 1 |
| [#36](https://github.com/Code-XR-Project/Code-XR/issues/36) | Python backend simplification | W4-P, W5-44..49 | 1 |
| [#37](https://github.com/Code-XR-Project/Code-XR/issues/37) | Browser runtimes simplification | W4-R, W5-50..52 | 1 |
| [#33](https://github.com/Code-XR-Project/Code-XR/issues/33) | Guardrails: ESLint, tsc, ruff | W3 | 2 |
| [#34](https://github.com/Code-XR-Project/Code-XR/issues/34) | Logging through the output channel | W4-L | 2 |
| [#35](https://github.com/Code-XR-Project/Code-XR/issues/35) | TypeScript pipeline, export and settings | W4-T | 3 |
| [#38](https://github.com/Code-XR-Project/Code-XR/issues/38) | Historical, evolution and export services | W5-01..11 | 3 |
| [#39](https://github.com/Code-XR-Project/Code-XR/issues/39) | Split server, collaboration and broadcast modules | W5-20..36 | 3 |
| [#40](https://github.com/Code-XR-Project/Code-XR/issues/40) | Data-driven sidebar tree and scene assets | W5-12..19, 37..43 | 3 |
| [#41](https://github.com/Code-XR-Project/Code-XR/issues/41) | Smaller VSIX, faster packaging and startup | W5-56, T55 + sweep | 3 |
| [#42](https://github.com/Code-XR-Project/Code-XR/issues/42) | Module layering for the IDE (no host abstraction) | host-boundary | 3 |
| [#43](https://github.com/Code-XR-Project/Code-XR/issues/43) | Final verification, measurements and report | §5 exit criteria | closing |

Wave 1 stories touch disjoint areas and run in parallel. Wave 2 (guardrails, logging) touches every file, so it runs after wave 1 merges. Wave 3 is split by area and runs in parallel again.

## How "no functionality lost" is proved

1. **Before:** the feature baseline (#27) and a test that pins the manifest, the command registry, chart types, runtimes, languages and Python CLI (#28).
2. **During:** every commit is bisectable and green; deletions carry a four-check deadness proof and an H1 (identical bundle hash) or H2 (reviewed shrink) characterization; refactors land a behavioural characterization first; the guardrail ratchet records each before/after.
3. **After:** all gates on the three OSes, the packaged VSIX run end to end in a clean profile following `feature-baseline.md` §10, and a written report (#43).
