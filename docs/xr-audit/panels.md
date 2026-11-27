# Panels audit (in-scene 2D surfaces: info/legend cards, guide, virtual screens, controller panel, overlays)

Scratch harness, scripts and screenshots: `/tmp/claude-0/-home-user/af5ccea8-f538-575c-b7b6-8256e5a53df6/scratchpad/audit/panels/`
(`site/harness.html` = the real `xr-visualization.html` room + screen manager + virtual-screen + guide + common runtimes, assembled from the repo by `assemble.cjs`; `run.cjs <scenario>` renders it in headless Chromium/SwiftShader; `shots/*.png`).
Harness caveat: the A-Frame Roboto MSDF font is on a blocked CDN, so `genfont.cjs` builds a substitute SDF atlas. Text is crisp up close; far away it shows white "box" artifacts from mip-mapping. Those artifacts belong to the harness, not to Code-XR.

## 1. How the area works (summary)

- **Scene template** `apps/vscode-extension/templates/xr/file/xr-visualization.html`:
  - Room `#codexrRoom` (22x26x11, centred at z -10).
  - Table at (0, 1, -18). The rig starts at (0.07, 1.75, -10.75).
  - `#codexrScreenManager` (`codexr-multi-screen-manager`, wall panel "Virtual screens" on the west wall).
  - A JSON config for the default virtual screen: anchored at (0, 4.2, -22), tilted -12°.
  - The scene sets no `renderer=` attribute, so A-Frame 1.7.1 defaults apply.
- **Virtual screen** (`templates/components/codexr/virtual-screen/virtualScreenRuntime/*`):
  - `createUi()` appends its root to the **end of the scene**.
  - Each screen has: a frame plane (opacity 0.86), an invisible interaction plane, header buttons, handles, a status `a-text` (the idle text "Share a screen, window, or browser tab in this XR scene."), and the share button.
  - Placement:
    - anchored (config);
    - drag / resize / look-at, which pass through collision "bumpers" (room shell + other screens only);
    - follow / Bring / placeInFrontOfUser (`followAndTransform.js` `applyFollowTransform`).
- **Guide screen** (`guide-screen/guideScreenRuntime/guideScreen.js`):
  - A fixed-content subtype of the virtual screen. Its content is built by `buildGuideContent`.
  - Anchored directly above the default screen at (0, 7.95, -22), 5.6 x 3.5.
  - Registered with the manager as a well-known screen.
- **Directory/file info card** (the "dependentium … Fan-in/Fan-out/… Open folder" panel):
  - Built by `dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js` (`acquireLegendCard` / `renderLegendCard` / `relayoutLegends`), using the shared `templates/components/common/codexrCommonRuntime.js` `createTooltip` / `updateTooltip`.
  - The data model is `nodeDetailModel` in `scalesAndControls.js:149-190`.
  - Cards sit in a 2-per-row grid on a "legend board" child of the graph entity: graph at (0, 1.02, -18), board at y ≈ graphTop + 1.05 ≈ 3.24 m, z ≈ -17.82. The board is yaw-billboarded every tick. There can be up to 6 pinned cards plus 1 hover card.
- **Other panels:**
  - Controller / mapping panel: `xr-chart-mapping-ui/.../panelUi.js`, placed at the table corner nearest the camera by `placementGeometry.js`.
  - Historical companion card: `historical-comparison/.../selectionPanel.js`.
  - Evolution playback overlay: `project-evolution/.../overlayAndPanel.js`, fixed at (0, 3.35, -18).
  - Debug HUD: `debug/codexrDebugRuntime.js`, camera child, desktop only.
- **Rendering facts that drive everything below:**
  - A-Frame 1.7.1's renderer system defaults to `sortTransparentObjects: false` (vendored `aframe/src/systems/renderer.js:23,68-71`). With that default, `setTransparentSort(sortRenderOrderOnly)` runs, so **transparent objects are drawn in scene-graph (DOM) order, not by distance**.
  - Every Code-XR panel is "transparent": either opacity < 1, which A-Frame turns into `transparent` (`material.js:134`), or `a-text`, whose `transparent` defaults to true.
  - In WebGL, `depthTest: false` also disables depth **writes**.

## 2. Findings

### PANELS-1: Info/legend cards are painted over by every screen behind them (the maintainer's screenshot)
- **Severity:** blocker (the main reported bug). **Type:** bug.
- **Evidence:**
  - `templates/components/common/codexrCommonRuntime.js:97-121`: the four card surfaces all set `depthTest: false`:
    - `border`: `... opacity: .5; ... transparent: true; depthTest: false`
    - `background`: `'color: #0e1626; opacity: .97; shader: flat; side: double; transparent: true; depthTest: false'`
    - `accent`: `'color: ' + accentColor + '; shader: flat; depthTest: false'`
    - `divider`: `... opacity: .4; shader: flat; depthTest: false`
  - Same pattern on the connector marker (`:186`, `:229`).
  - Same pattern on the dependency-graph scope breadcrumb chip (`dependency-graph/dependencyGraphRuntime/componentCore.js:177-183`).
  - The scene keeps A-Frame's default transparent sort (no `renderer="sortTransparentObjects: true"` in `templates/xr/file/xr-visualization.html:25-30`).
  - The card lives under the graph root (early in the DOM). The virtual screen and guide roots are appended to the end of the scene (`virtualScreenRuntime/visibilityAndLayout.js:213` `scene.appendChild(refs.root)`).
- **Mechanism (confirmed by dumping `renderer.renderLists`, scenario `sc2.cjs`):**
  - Transparent draw order is graph card (items 17-39), then default screen frame / status text / share button (40-44), then guide (45-72). Their z values show they are **not** depth-sorted.
  - The card background has `depthTest: false`, so it writes no depth. Only the card's text glyph quads write depth.
  - The screen frame (0.86 opacity), the "Share a screen…" status text, the share button and the guide content are drawn afterwards and pass the depth test everywhere except under the card's glyphs. They are farther away, yet they paint over the card.
  - The card's own text survives where its glyphs wrote depth. The result is the two panels' text interleaved: exactly "you can read through each other".
- **Failure scenario:**
  1. Run a dependency-graph analysis.
  2. Hover or click a directory node (e.g. "dependentium").
  3. The card appears above the table, in front of the default virtual screen (z -22) and, when several cards are pinned, also in front of the guide.
  4. The idle-screen text and share button, and the guide's text and background, are drawn on top of the card.
- **Confidence:** CONFIRMED.
  - Before: `shots/f-close-card-over-screen-site.png` (default runtimes). "Share a screen, window, or browser tab in this XR scene." and the share button are drawn over the "dependentium" card's title and metrics. The same happens from the default rig position (`shots/a-default-view.png`).
  - After: `shots/f-close-card-over-screen-site-fix1.png` / `-fix3.png`, with `depthTest: false` removed from the common runtime. The card fully occludes the screen behind it.
  - Alternative fix: `shots/a-default-view-site-fix2.png` (keep `depthTest: false`, add `renderer="sortTransparentObjects: true"`) also fixes this view. It is weaker, see section 3.
- **Proposed fix:**
  - (a) `codexrCommonRuntime.js`: drop `depthTest: false` from border/background/accent/divider and the marker, and make the background opaque (`opacity: 1`, `transparent: false`; the 0.97 buys nothing visually). The card then renders in the opaque pass, writes depth and occludes correctly regardless of DOM order. Its texts already sit at +0.018/0.019 in front, so there is no z-fighting.
  - (b) Same treatment for the scope breadcrumb chip in `componentCore.js:182`.
  - (c) If the original reason for `depthTest: false` (cards "never hidden by nodes") still matters, keep the cards out of the graph volume by placement (they already sit above `graphTopY`), not by disabling depth.
  - (d) Optionally add `renderer="sortTransparentObjects: true"` to `xr-visualization.html` so the translucent surfaces that remain blend in distance order.
- **Test:**
  - Unit (`test/analysis/codexrCommonRuntime.test.cjs`): assert that no tooltip surface material contains `depthTest: false`, and that the background has `opacity` 1. Add the same assertion for the scope chip in `test/analysis/dependencyGraph.test.cjs`.
  - Visual: port `sc5.cjs` (rig at 0.6 2.9 -13.8) into a Playwright harness. Sample the pixel colour at the card centre and assert it is the card background (#0e1626), not the screen frame or the status text.

### PANELS-2: Virtual screen frame is 14% see-through, so anything behind a screen reads through it
- **Severity:** major. **Type:** bug/ux.
- **Evidence:** `virtual-screen/virtualScreenRuntime/visibilityAndLayout.js:66-70`: `material: 'color: #0F172A; opacity: 0.86; transparent: true; shader: flat;'`.
  - The guide's backing is 0.97 (`guideScreen.js:224-227`).
  - The mapping panel is 0.94 plus a 0.5 border box (`panelUi.js:400-416`).
  - The historical companion card is 0.66 with a 0.55 border (`selectionPanel.js:233-238`).
  - The evolution overlay is 0.78 (`overlayAndPanel.js:15`).
- **Failure scenario:**
  1. Pin a card.
  2. Walk toward the table and press **Bring** on the default screen (wall panel).
  3. The screen lands about 2.4 m in front of you, between you and the card. The card's text is readable through the screen.
  4. With the guide behind a screen, the guide text reads through the screen.
- **Confidence:** CONFIRMED.
  - `shots/c-bring-default-in-front-of-card-site.png`: the card and the wall panel are visible through the screen.
  - `shots/c-bring-default-in-front-of-card-site-fix3.png`: with frame opacity 1, nothing reads through.
- **Proposed fix:** make every panel **backing** opaque (`opacity: 1; transparent: false`): the virtual-screen frame, the guide background, the mapping-panel background, the companion card and the evolution overlay. Keep translucency only for decorative borders that have nothing meaningful behind them.
- **Test:** unit tests asserting the backing materials of each runtime, plus the `sc3.cjs` pixel probe.

### PANELS-3: Bring / Add screen / follow bypass all collision, so screens stack exactly on top of each other, the guide or the cards, and sink into the table
- **Severity:** major. **Type:** bug.
- **Evidence:**
  - `virtualScreenRuntime/followAndTransform.js` `applyFollowTransform()` (≈ lines 563-592) calls `applyWorldTransform(refs.root, targetWorldPosition, targetWorldQuaternion)` directly. `constrainPosition` is used only by drag (`pointerAndDrag.js:159`), and `constrainOrientation` only by look-at (`followAndTransform.js:503`).
  - `placeInFrontOfUser` (used by `bringScreenInFrontOfUser`, manager `:812`) and `addScreen` (`schedulePlaceScreenInFrontOfUser`, manager `:763`) therefore ignore the room shell, other screens, the table and the cards.
  - The obstacle list (`getScreenObstacles`, `followAndTransform.js:64-93`) only contains virtual-screen roots. Legend cards, the mapping panel, the table, the charts and the evolution overlay are invisible to the bumpers.
- **Failure scenario:**
  - (a) Press "+ Add screen" twice without moving. Both new screens are placed at the identical pose and z-fight, mixing their text ("screen:anon:1" and "screen:anon:2" superimposed).
  - (b) Press Bring on the default screen, then on the Guide. The two overlap 0.2 m apart and the guide's lower edge sinks into the table.
  - (c) Bring while standing near a wall: the screen goes into the wall.
- **Confidence:**
  - CONFIRMED for (a): `sc6.cjs` gives both screens world position (0.07, 2.45, -12.95); see `shots/g-add-two-screens.png`.
  - CONFIRMED for (b): `sc3.cjs` gives default (0.07, 2.55, -14.9) and guide (0.07, 2.45, -14.7). The guide is 3.5 m tall, so its bottom is at about 0.7 m, below the table top at 1.0 m (`shots/d-bring-guide-too-site.png`).
  - (c) is LIKELY (same code path).
- **Proposed fix:**
  - Route `applyFollowTransform` through a placement resolver: first `constrainPosition`, and if the target is inside an obstacle, search outward (offset along the camera's right vector or upward in steps of screen width + gap) until free.
  - Register a common obstacle set: the table box (from `codexr-analysis-table` data), the active legend board bounds, the mapping panel, and screens.
  - `addScreen` should cascade, e.g. offset the k-th new screen by k·(width + 0.3) to the right.
- **Test:** a unit test with mocked THREE (the pattern exists in `test/analysis/virtualScreen*.test.cjs`): two `placeInFrontOfUser` calls must not give overlapping OBBs. Also a Playwright `sc6`-style assertion that the screen positions differ by at least the width.

### PANELS-4: Clicks on an info card go through it and hit whatever is behind (including the screen's Share button)
- **Severity:** major. **Type:** bug.
- **Evidence:** the card surfaces created in `codexrCommonRuntime.js:97-121` have no raycaster class. Only the "Open folder" button carries `RAYCAST_CLASS` (`dependency-graph/.../configAndStatus.js:140-149`). The raycasters use `objects: .babiaxraycasterclass` (`xr-visualization.html`).
- **Failure scenario:**
  1. Pin a directory card.
  2. Click anywhere on it except the purple button, for example to "dismiss" it or by accident.
  3. The ray continues to the default screen behind. At the card centre it hits `codexrShareSource`, which triggers screen sharing and the native picker. Elsewhere it hits the screen surface (chrome flashes) or graph nodes, which toggles other pins and reflows the cards under the cursor.
- **Confidence:** CONFIRMED. `sc4.cjs` casts from the camera through card points:
  - centre: `codexrShareSource@11.47`, then `codexrVirtualScreenSurface`, then a wall;
  - upper / lower-left: `codexrVirtualScreenSurface`.
- **Proposed fix:**
  - Give the card background `class: babiaxraycasterclass` plus `data-codexr-interactive`, so it absorbs the ray (and in `createTooltip`, an option `{ blocking: true }`).
  - Add a close "×" button on the card that calls `togglePinnedSelection`.
  - Hover on the card should keep it alive (no flicker).
- **Test:** a unit test that `createTooltip(...).background` has the raycast class. Re-run `sc4.cjs`: the first hit must be the card.

### PANELS-5: Info cards cannot be closed from the card, and the stack grows upward into the screens and the ceiling
- **Severity:** minor. **Type:** ux.
- **Evidence:**
  - `tooltipsAndSelection.js:213-232`: a card is only removed by clicking the same node again, by pruning, or by `resetView` / `hideAllLegends`.
  - `configAndStatus.js:25-30`: `MAX_PINNED_LEGENDS = 6`, `perRow: 2`, `cardHeight: 1.85`, `gapY: 0.3`.
  - `legendSlotPosition` stacks rows **upward** (`codexrCommonRuntime.js:330`).
- **Failure scenario:**
  1. Pin 6 cards and hover a 7th: 4 rows.
  2. The top row centre is at about 3.24 + 3·2.15 ≈ 9.7 m, so the cards reach about 10.6 m, against an inner ceiling around 10.8 m.
  3. The stack covers both the default screen and the guide in projection.
  4. Unpinning requires finding each node again in a dense graph.
- **Confidence:** LIKELY (arithmetic from the constants; the shape is visible in the harness with one card).
- **Proposed fix:** a close button per card (see PANELS-4). Cap at 2 rows; beyond that, collapse older cards into compact chips. Or grow sideways and clamp to the room's height (see the policy in section 3).
- **Test:** unit test on `legendSlotPosition` / `relayoutLegends` that the max board-local y + card height stays ≤ the configured ceiling.

### PANELS-6: Virtual-screen status text is wider than the screen, so the idle message spills outside the frame
- **Severity:** minor. **Type:** ux/bug.
- **Evidence:**
  - `visibilityAndLayout.js:319`: `refs.status.setAttribute('width', String(Math.max(6, width + 1.4)));`
  - With the default width 4.8 the text box is 6.2 m wide against a 4.92 m frame. At the smallest size (3.2) it is 6 m wide against a 3.32 m frame.
- **Failure scenario:** the idle "Share a screen, window, or browser tab in this XR scene." line overhangs the frame on both sides and covers whatever is beside it, including cards and the guide in the maintainer's screenshot.
- **Confidence:** CONFIRMED (`shots/a-default-view.png`, `shots/c-...-site-fix3.png`: the text extends past the frame edges).
- **Proposed fix:** `width = Math.max(1, width - 0.3)` plus `wrap-count` scaled to the width, so it wraps inside the frame.
- **Test:** unit test on `layout()` that status width ≤ frame width.

### PANELS-7: Added screens show their internal id in the idle label and ignore the scene's virtual-screen config
- **Severity:** minor. **Type:** bug/architecture.
- **Evidence:**
  - `codexrMultiScreenManagerRuntime.js:526`: `const sharedConfig = root.__CODEXR_VIRTUAL_SCREEN_CONFIG__ || {};`. The XR template only provides the JSON script `codexr-tooling-config-virtual-screen` (`xr-visualization.html:155`); only the DOM template sets the global.
  - So managed screens in XR fall back to `DEFAULT_CONFIG`: followOffset (0, 0.7, -2.2) instead of the template's (0, 0.8, -2.4), and the fallback position/rotation `{0,8,6}` / `{0,90,0}`.
  - `:572` sets `idle: options?.idleLabel || \`${instanceId}: choose source independently.\``, which shows "screen:anon:1: choose source independently." rather than the display name "vscreen 1".
- **Confidence:** CONFIRMED (`shots/g-add-two-screens.png`).
- **Proposed fix:** read the config through the virtual-screen runtime's own `readConfigFromJsonScript` / `mergeConfig` (as the guide already does, `guideScreen.js:250-254`). Use `displayName` in the label.
- **Test:** unit test of `buildRuntimeInitConfig` with only the JSON script present.

### PANELS-8: Text is too small to read in VR at default distances
- **Severity:** minor. **Type:** ux.
- **Evidence:** angular sizes of one character width (from a-text `width / wrap-count` and the default rig position):

  | Text | Character width | Distance | Angle |
  |---|---|---|---|
  | Card metric labels/values (`codexrCommonRuntime.js:73-78`, `updateTooltip` grid) | 0.69/16 ≈ 0.043 m | ≈ 7.2 m | ≈ 0.34° |
  | Card title (wrap 26) | — | — | ≈ 0.64° |
  | Guide body (`guideScreen.js:146`, width 4.9, wrap 64) | 0.077 m | ≈ 11.3 m | ≈ 0.39° |

  - Quest-class headsets give about 20-25 px/deg, so 0.34° is roughly 7-9 px per glyph: illegible.
  - In the harness at 1280x800, the card rows are unreadable from the spawn point.
- **Confidence:** LIKELY (computed). Needs the maintainer's eyes in a headset.
- **Proposed fix:** a minimum of about 1° per character for body text at the expected viewing distance. Either scale cards with distance (board scale = clamp(d/4, 1, 2)), or place cards and the guide closer (see policy). Bigger wrap widths for metric cells.

### PANELS-9: Translucent overlays and panels from other modes sit at fixed coordinates in the card / chart volume
- **Severity:** minor. **Type:** architecture.
- **Evidence:**
  - The evolution playback overlay is hard-coded at `'0 3.35 -18'`, does not face the user and has opacity 0.78 (`project-evolution/.../overlayAndPanel.js:6-16`). That is the same spot as the dependency-graph legend board (y ≈ 3.24, z ≈ -17.82) and inside the height band of tall BabiaXR charts.
  - The mapping panel follows table corners (`placementGeometry.js:160-183`) without considering cards or screens.
  - The guide's anchor is derived from the default screen only (`guideScreen.js:247-276`).
- **Confidence:** LIKELY (traced). Cross-mode leftovers are covered by the lifecycle / evolution audits.
- **Proposed fix:** the placement registry in section 3.

### Notes / checked and not a bug
- Leaving the dependency graph removes its cards: they are children of the graph entity and are swept by `clear()` (`componentCore.js:106-140`). Whether the graph root itself is removed or hidden on mode exit is the lifecycle audit's area.
- The guide's "×" only stops/minimizes (`wiringAndApi.js:66-69`). A guide cannot be closed, only minimized. Acceptable, but the button glyph promises "close".
- The debug HUD is a camera child at 1.25 m with depthTest on. A screen dragged closer than 1.25 m occludes it. Desktop-only, cosmetic.
- No item from `docs/cleanup/REPORT.md` section 9 concerns panels.

## 3. Unified panel layering and placement policy (recommendation)

1. **One panel primitive** in `templates/components/common/codexrCommonRuntime.js`: `createPanel({ width, height, accent, blocking: true, layer })`. Every runtime (tooltip/legend cards, guide content, screen frame, mapping panel, companion card, evolution overlay, mode selector) builds its backing through it. Rules it enforces:
   - backing `opacity: 1; transparent: false` (opaque pass, writes depth);
   - **never** `depthTest: false`;
   - children (text, buttons) at fixed offsets +0.01/+0.02, or `polygonOffset` on the backing;
   - the backing carries the raycast class when `blocking`, so rays stop at the panel.

   This removes the dependence on DOM order (PANELS-1, 2, 4) without needing global transparent sorting.
2. **Turn on `renderer="sortTransparentObjects: true"`** in both XR templates as a safety net for whatever must stay translucent (glass railing, halos, edges). It is not the fix by itself: centre-based sorting still mis-orders large tilted planes, and a `depthTest: false` card would then wrongly paint over a screen that is *in front* of it.
3. **One placement registry** (e.g. `CodeXRPanelLayout` in the common runtime):
   - Every panel registers an oriented bounding box plus a priority (screen, guide, legend board, controller, overlay).
   - Callers ask for a pose via `resolvePlacement(preferredPose, {size})`. The registry runs the existing bumper logic (room shell + every registered OBB + the table/chart volume from `codexr-analysis-table`) and, if the preferred pose is blocked, searches outward along a deterministic ladder (right, left, up) instead of stopping.
   - Bring / Add screen / follow / guide anchor / legend board / evolution overlay all go through it. This removes PANELS-3, 5 and 9, and gives the "contained within the table" goal a matching "panels never inside the table" rule.
4. **Zones:**
   - The table volume is reserved for charts.
   - The board above the table (a capped height band) is for transient info cards; they billboard as a rigid group.
   - Screens and the guide go on the back wall band.
   - The controller goes at the nearest table corner.
   - Bring/follow targets are resolved against all of the above.
5. **Readability floor:** a ≥ 1° glyph rule checked by a unit test that computes `width / wrapCount / distance` for the default anchors, plus distance-scaled cards.
6. **Interaction:** every info panel gets a close button, and a raycast-blocking backing (rays never pass through a visible panel).

This fits the unified-launcher goal: an analysis type declares its panels (cards, overlays, controls) to the registry when the mode starts and releases them when it stops. That makes "panel stays after leaving the mode" structurally impossible.
