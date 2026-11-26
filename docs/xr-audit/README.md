# XR environment audit (v1.2.1 baseline)

Date: 2026-11-25. Baseline: `v1.2.1` @ `d89e08d4`, right after the cleanup epic #26.

This is a bug audit of everything in the extended-reality part of Code-XR: the XR scene templates, the
browser runtimes under `apps/vscode-extension/templates/components/`, how the four in-scene analyses
(classic/single, dependency graph, historical comparison, project evolution) are launched and switched,
and the host-side orchestration that serves them. It was run as seven parallel audits, one per area.
Each area report is in this folder and holds the evidence (file:line), the failure scenario, the
confidence level and a proposed fix for every finding.

| Area | Report | Findings | Blocker | Major |
|---|---|---|---|---|
| In-scene panels (cards, guide, virtual screens) | [panels.md](panels.md) | 9 | 1 | 3 |
| Host-side launch, servers, sessions | [launcher.md](launcher.md) | 18 | 0 | 10 |
| Chart build, rebuild and containment | [charts.md](charts.md) | 18 | 2 | 9 |
| Project evolution | [evolution.md](evolution.md) | 20 | 1 | 9 |
| Dependency graph | [depgraph.md](depgraph.md) | 12 | 0 | 5 |
| Historical comparison | [historical.md](historical.md) | 13 | 0 | 7 |
| Mode switching and lifecycle | [lifecycle.md](lifecycle.md) | 12 | 2 | 4 |
| **Total** | | **102** | **6** | **47** |

Some findings appear in two areas under different ids (for example the live-reload reconnect is
CHARTS-10 and LIFECYCLE-10). The epic groups them into one story each.

## How the findings were verified

- **CONFIRMED** means the bug was reproduced: with the real compiled host modules under Node, with real
  Git repositories built for the purpose, or with the real assembled runtimes on real A-Frame 1.7.1 and
  BabiaXR 1.3.4 in headless Chromium (WebGL through SwiftShader). About two thirds of the findings are
  confirmed this way. **LIKELY** means traced in code. **SUSPECTED** means it needs a platform we could
  not run.
- Nothing here was checked in VS Code itself, in a headset, on Windows or on macOS. Windows-only findings
  were reproduced by emulating the Windows behaviour (cp1252 pipes, drive-letter paths) on Linux.
  Each report has a "needs the maintainer's eyes" list.
- Baseline before the audit: `npm run test:unit` 1064/1064, and the four Playwright harnesses pass. None of
  the existing tests catches any of the findings: most are source-text checks or happy paths, and the
  mode-cycle harness loads its page over `file://`, where every data fetch is blocked.

## The six blockers

1. **PANELS-1, the "read-through" panels.** Info and legend cards are drawn with `depthTest: false`
   (`templates/components/common/codexrCommonRuntime.js`), and A-Frame 1.7.1 does not sort transparent
   objects by distance, so screens behind a card are painted over it in DOM order and their text
   interleaves with the card's. Removing `depthTest: false` and making the backings opaque fixes it in
   the headless reproduction.
2. **CHARTS-1, charts settle off the table.** BabiaXR's axis lines never shrink under A-Frame 1.7.1, and
   generated scenes first build from all rows before switching to the row-budgeted slice. Bar, cylinder
   and map charts end 1.25 to 2.6 m off the table while containment reports "ok" (see also CHARTS-2).
3. **CHARTS-10 / LIFECYCLE-10, live reload dies after one network error.** The XR SSE client reconnects
   with a new `EventSource` that has no handlers, so the scene silently stops updating until a reload.
4. **LIFECYCLE-1, one hung mode freezes the analysis switcher.** Mode transitions run in series with no
   timeout or cancel; a dataset fetch that never settles blocks every later switch for the session.
5. **LIFECYCLE-4, project evolution cannot be re-entered after a half-built frame.**
6. **EVO-1, a failed movie generation leaves the client "generating"**, and leaving the mode then deletes
   the previous good movie for the whole room.

## Cross-cutting causes

Most findings come from six missing shared mechanisms. The epic is organised around them.

1. **No job model on the host.** Git and Python work (evolution frames, comparison snapshots, dependency
   scans, the launch itself) has no job id, no timeout, no cancel and no kill of child processes. A hung
   job keeps a "busy" flag forever, Cancel is implemented as Clear, and races pass check-then-act guards.
2. **No lifecycle contract in the scene.** `activate()` can hang or half-fail, errors land in hidden
   status lines, the server is never told, and late messages bounce users back to the selector.
3. **No single chart pipeline.** Six paths build or change a chart (generated scene, live switch, remap,
   live reload, evolution frames, comparison clones), each with its own order of slice, build and fit.
   Containment measures stale geometry and never checks position.
4. **No panel policy.** Every panel picks its own material, opacity, depth settings and position, and
   only drag and look-at go through collision.
5. **No launch registry.** Sessions, servers, the SSE file map and watchers are keyed by raw path strings
   in four places, the port is chosen twice, and stop/close paths leak listeners or stop the wrong server.
6. **Weak automated coverage of real scenes.** See the test story in the epic.

## Design proposals

Each report ends with architecture recommendations. The three that answer the maintainer's explicit asks:

- **Unified, modular launcher**: [launcher.md §4](launcher.md) (a `LaunchKind` per surface and an
  `AnalysisTypeDescriptor` per in-scene analysis, one `LaunchRegistry`, seven behaviour-preserving
  migration steps), paired with the scene-side contract in [lifecycle.md §3](lifecycle.md) and the job
  runner recommendations at the end of [evolution.md](evolution.md).
- **Unified chart (re)build that keeps charts on the table**: [charts.md §3](charts.md)
  (`CodeXRChartPipeline.request()`: slice first, hidden until fitted, Babia animation off, wait for a real
  "built" signal, fit once with fresh bounds plus a position check, then reveal and validate).
- **Panel layering and placement policy**: end of [panels.md](panels.md).

## Reproduction material

The repro scripts and harnesses are not part of the repository (they are audit tools). They live in the
project's shared files under `xr-audit/repro/`. Running them in a sandbox with no CDN access needs the
Playwright preload `xr-audit/repro/cdn-route.cjs`, which serves A-Frame, BabiaXR and aframe-extras from
`npm pack` tarballs.

## Fix verification

The fixes of epic #72 were re-checked independently on `v1.2.1` @ `6f827a19` (2026-11-26): 80 of 102
findings fully fixed, 17 partly fixed, 4 minor still failing, 1 manual-only; all 6 blockers fixed. See
[verification/README.md](verification/README.md).
