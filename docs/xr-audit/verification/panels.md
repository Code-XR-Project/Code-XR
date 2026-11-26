# Verification: panels (PANELS-1..9), branch v1.2.1 @ 6f827a19

Harness rebuilt from the CURRENT runtimes: `verify/panels/assemble.cjs site` (repo templates, assembled via `test/helpers/runtimeAssembly.cjs`) into `verify/panels/site/`; the audit's old copied runtimes kept as `verify/panels/site-old/` for before/after. `harness.html` updated to the current markup: table wrapped in `#codexr-analysis-table-geometry` (what the placement registry looks for) and the legend board tagged `data-codexr-panel-obstacle` (as `tooltipsAndSelection.js:46` does). Offline libs via `test/helpers/harnessBrowser.cjs`; substitute font from `genfont.cjs`. Screenshots in `verify/panels/shots/`.

| ID | Sev | Verdict | Evidence (short) |
|---|---|---|---|
| PANELS-1 | B | FIXED (verified by run) | sc5 close view: `shots/f-site.png` card fully occludes the screen behind; `shots/f-site-old.png` (old runtimes, same scene) still shows "Share a screen..." painted over the card. No `depthTest:false` left in templates (only comments, `codexrCommonRuntime.js:104`, `componentCore.js:193`); unit test "no scene runtime disables the depth test" passes. |
| PANELS-2 | G | FIXED (verified by run) | `shots/c-bring-default-in-front-of-card.png`: screen brought between camera and card, nothing reads through. Frame material `color: #0F172A; shader: flat` (`visibilityAndLayout.js:69`); guide, mapping panel, companion card, evolution overlay backings opaque; test "every panel backing is opaque" passes. |
| PANELS-3 | G | PARTIAL | (a) FIXED: sc6 two "+ Add screen" -> (0.07,2.55,-13.15) and (5.12,2.55,-13.15) (before: identical). (b) STILL: Bring default then Bring guide -> default (0.07,2.55,-14.9), guide (0.07,2.45,-14.7): guide 0.2 m in front, fully covering the default screen (`shots/d3.png`). (c) STILL: Bring near the west wall (rig -9.6,1.75,-12 facing -x) -> screen at x=-12.0, outside the room (inner wall ~-10.75), `shots/h-bring-near-wall.png` shows only wall. |
| PANELS-4 | G | FIXED (verified by run) | sc4 ray through card centre/upper/lower-left: first hit is now the card backing `A-PLANE.babiaxraycasterclass@7.2x` (before: `codexrShareSource@11.47`). Backing carries the raycast class (`codexrCommonRuntime.js:111`). |
| PANELS-5 | m | FIXED (verified by run + code) | `legendSlotPosition` with the dep-graph options (maxRows 2) for 7 cards: max row y 2.15 -> top ~6.3 m (before ~10.6 m); close "X" per pinned card (`tooltipsAndSelection.js:137-156`, toggles the pin). |
| PANELS-6 | m | FIXED (verified by run) | status width `Math.max(1, width - 0.3)` (`visibilityAndLayout.js:321`); idle text wraps inside the frame in `shots/c-bring-default-in-front-of-card.png`; unit test passes. |
| PANELS-7 | m | FIXED (verified by run) | sc6: added screens use the scene's followOffset (y 1.75+0.8=2.55, z -10.75-2.4) and label "vscreen 2: choose source independently." (`shots/g-add-two-screens.png`). |
| PANELS-8 | m | NOT VERIFIABLE AUTOMATICALLY | Needs a headset. Text sizes unchanged (card metric cells still width .7 / wrap 16). STATUS doc (V1.2.1_STATUS.md:304) explicitly defers it to the manual guide; manual-test-guide row 1.1 ("Text is readable") covers it. |
| PANELS-9 | m | PARTIAL | Evolution overlay and legend board now register as obstacles for screens (`overlayAndPanel.js:12`, `tooltipsAndSelection.js:46`), but the overlay stays at fixed `0 3.35 -18` and the mapping panel / guide anchor still ignore cards (no shared registry for non-screen panels). Documented as not done in V1.2.1_STATUS.md:304. |

Counts: FIXED 6, PARTIAL 2, NOT VERIFIABLE 1, STILL FAILING 0.

## Still failing / partial

### PANELS-3 (G) PARTIAL
- Bring/Add go through `findFreePlacement` (`placementRegistry.js:108-138`) but:
  1. Overlap is tested as volumetric box intersection (screen half-depth 0.02 vs other screens 0.15). Two screens facing the user 0.2 m apart in depth do not intersect, so Bring of the guide lands directly in front of the default screen and hides it completely. Repro: `verify/panels/sc3b.cjs` (positions above, `shots/d3.png`).
  2. When the target violates the room shell and no ring candidate is free (all candidates share the same depth, i.e. all in the wall), it returns the original target ("Nothing free keeps the target", `placementRegistry.js:105`) instead of clamping with `constrainPosition`. Repro `verify/panels/sc7.cjs`: screen root at (-12, 2.55, -12), beyond the west wall.
- Proposed issues: "Bring/Add screen: treat a screen stacked in front of another (view-direction overlap) as blocked" and "Bring near a wall places the screen outside the room: clamp to room bounds when no free spot is found".

### PANELS-9 (m) PARTIAL
- Proposed issue: "Evolution overlay and controller panel still use fixed / table-corner placement, not the placement registry".

## Commands run
```
export PATH=/opt/node24/bin:$PATH; unset NODE_OPTIONS; cd verify/panels
node genfont.cjs; node assemble.cjs site            # current runtimes; site-old = audit copy
SITE=site node run.cjs sc1.cjs|sc3.cjs|sc4.cjs|sc6.cjs|sc3b.cjs|sc7.cjs
SITE=site node run.cjs sc5p.cjs ; SITE=site-old node run.cjs sc5p.cjs   # before/after PANELS-1
cd /home/user/Code-XR/apps/vscode-extension
node --test test/analysis/codexrCommonRuntime.test.cjs test/analysis/xrPanelLayering.test.cjs test/analysis/virtualScreenRuntime.test.cjs test/analysis/dependencyGraph.test.cjs   # 90/90 pass
node -e '<legendSlotPosition 7 cards, maxRows 2>'   # max row y 2.15
```
(run.cjs/genfont.cjs patched to launch /opt/pw-browsers/chromium-1243 through harnessBrowser.cjs; the default playwright headless shell 1228 is not installed.)
