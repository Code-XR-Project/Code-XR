/**
 * Screens never hide each other or leave the room (#103, PANELS-3/9).
 *
 * Drives the real virtual screen, guide and multi-screen manager runtimes in
 * the real codexr-room, plus the common runtime's shared panel placement:
 *  - Bring default, then Bring guide: both stay visible (their silhouettes
 *    seen from the user do not overlap; before the fix the guide landed
 *    0.2 m in front of the default screen and covered it).
 *  - Bring while standing next to a wall: the screen stays inside the room
 *    (before: its root ended 1.25 m beyond the west wall).
 *  - resolvePanelPlacement (evolution overlay and controller panel): off the
 *    chart volume, out of a screen's line of sight, clamped into the room.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startStaticServer } = require('../helpers/staticHttpServer.cjs');
const { buildAssembledRuntimes } = require('../manual/buildAssembledRuntimes.cjs');
const { launchHarnessChromium } = require('../helpers/harnessBrowser.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const harnessPath = path.join(projectRoot, 'test', 'manual', 'xr-panel-placement-harness.html');
let staticServer = null;
async function harnessUrl() {
  staticServer ||= await startStaticServer(projectRoot);
  return staticServer.url(path.relative(projectRoot, harnessPath));
}
async function closeStaticServer() {
  if (staticServer) { await staticServer.close(); staticServer = null; }
}
buildAssembledRuntimes();
const html = fs.readFileSync(harnessPath, 'utf8');
assert.match(html, /assembled\/virtualScreenRuntime\.js/);
assert.match(html, /assembled\/guideScreenRuntime\.js/);
assert.match(html, /codexrCommonRuntime\.js/);
assert.match(html, /id="codexr-analysis-table-geometry"/);

// Installed into the page: screen frames as world-space corners, the room's
// inner box, and the angular extent of a set of points seen from the camera.
function installProbes() {
  const T = window.THREE;
  window.__probe = {
    manager() {
      return document.querySelector('[codexr-multi-screen-manager]').components['codexr-multi-screen-manager'];
    },
    camera() {
      return document.querySelector('a-scene').camera.getWorldPosition(new T.Vector3());
    },
    frames() {
      const out = {};
      document.querySelectorAll('[id^="codexrVirtualScreenRoot"]').forEach((rootEl) => {
        const frame = rootEl.querySelector('[id^="codexrVirtualScreenFrame"]');
        if (!frame?.object3D) { return; }
        const w = Number(frame.getAttribute('width')) || 0;
        const h = Number(frame.getAttribute('height')) || 0;
        frame.object3D.updateMatrixWorld(true);
        out[rootEl.id] = [[-1, -1], [1, -1], [-1, 1], [1, 1]]
          .map(([sx, sy]) => frame.object3D.localToWorld(new T.Vector3(sx * w / 2, sy * h / 2, 0)));
      });
      return out;
    },
    roomInner() {
      const roomEl = document.querySelector('[codexr-room]');
      const room = roomEl.components['codexr-room'].data;
      const c = roomEl.object3D.position;
      const wall = room.wallThickness;
      return {
        minX: c.x - room.width / 2 + wall, maxX: c.x + room.width / 2 - wall,
        minZ: c.z - room.depth / 2 + wall, maxZ: c.z + room.depth / 2 - wall,
        minY: c.y + room.floorThickness, maxY: c.y + room.height - room.ceilingThickness,
      };
    },
    inside(points) {
      const b = this.roomInner();
      return points.every((p) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
        && p.z >= b.minZ && p.z <= b.maxZ);
    },
    silhouette(points, viewer) {
      const forward = new T.Vector3(0, 0, -1).applyQuaternion(
        document.querySelector('a-scene').camera.getWorldQuaternion(new T.Quaternion()));
      forward.y = 0; forward.normalize();
      const up = new T.Vector3(0, 1, 0);
      const right = new T.Vector3().crossVectors(forward, up).normalize();
      const s = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      points.forEach((p) => {
        const v = p.clone().sub(viewer);
        // A corner beside or behind the viewer sits on a near plane (it is
        // seen at the edge of the view, never mirrored).
        const d = Math.max(0.05, v.dot(forward));
        s.minX = Math.min(s.minX, v.dot(right) / d); s.maxX = Math.max(s.maxX, v.dot(right) / d);
        s.minY = Math.min(s.minY, v.dot(up) / d); s.maxY = Math.max(s.maxY, v.dot(up) / d);
      });
      return s;
    },
    overlap(a, b) {
      return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
    },
  };
}

async function openHarness(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(await harnessUrl(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('a-scene')?.hasLoaded
    && window.CodeXRGuideRuntime?.getState?.().mounted
    && document.querySelector('[codexr-multi-screen-manager]')?.components?.['codexr-multi-screen-manager']?.activeScreens?.has('guide'),
  null, { timeout: 60000 });
  await page.evaluate(installProbes);
  await page.waitForTimeout(500);
  return { page, errors };
}

async function bringDefaultThenGuide(browser) {
  const { page, errors } = await openHarness(browser);
  const result = await page.evaluate(async () => {
    const probe = window.__probe;
    document.getElementById('rig').setAttribute('position', '0.07 1.75 -12.5');
    await new Promise((resolve) => setTimeout(resolve, 300));
    probe.manager().bringScreenInFrontOfUser('default');
    await new Promise((resolve) => setTimeout(resolve, 300));
    probe.manager().bringScreenInFrontOfUser('guide');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const frames = probe.frames();
    const viewer = probe.camera();
    const ids = Object.keys(frames);
    const defaultId = ids.find((id) => id === 'codexrVirtualScreenRoot');
    const guideId = ids.find((id) => /guide/i.test(id));
    return {
      ids,
      overlap: probe.overlap(probe.silhouette(frames[defaultId], viewer), probe.silhouette(frames[guideId], viewer)),
      inside: ids.every((id) => probe.inside(frames[id])),
    };
  });
  await page.close();
  assert.deepEqual(errors, [], 'no page errors');
  assert.ok(result.ids.some((id) => /guide/i.test(id)), `the guide screen exists (${result.ids.join(', ')})`);
  assert.equal(result.overlap, false, 'Bring default then Bring guide: the guide must not cover the default screen');
  assert.equal(result.inside, true, 'both screens inside the room');
  console.log('[xr-panel-placement-harness] Bring default + Bring guide: both visible.');
}

async function bringNextToWall(browser) {
  const { page, errors } = await openHarness(browser);
  const result = await page.evaluate(async () => {
    const probe = window.__probe;
    const rig = document.getElementById('rig');
    rig.setAttribute('position', '-9.6 1.75 -12');
    rig.setAttribute('rotation', '0 90 0');
    await new Promise((resolve) => setTimeout(resolve, 300));
    probe.manager().bringScreenInFrontOfUser('default');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const corners = probe.frames().codexrVirtualScreenRoot;
    return { inside: probe.inside(corners), minX: Math.min(...corners.map((p) => p.x)), wall: probe.roomInner().minX };
  });
  await page.close();
  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(result.inside, true, `Bring next to the west wall keeps the screen in the room (x ${result.minX.toFixed(2)} vs wall ${result.wall.toFixed(2)})`);
  console.log('[xr-panel-placement-harness] Bring next to a wall: screen stays inside.');
}

async function sharedPanelPlacement(browser) {
  const { page, errors } = await openHarness(browser);
  const result = await page.evaluate(async () => {
    const T = window.THREE;
    const probe = window.__probe;
    const resolve = window.CodeXRCommonRuntime.resolvePanelPlacement;
    const scene = document.querySelector('a-scene');
    const viewer = probe.camera();
    const boxAt = (p, size) => new T.Box3(
      new T.Vector3(p.x - size.x / 2, p.y - size.y / 2, p.z - size.z / 2),
      new T.Vector3(p.x + size.x / 2, p.y + size.y / 2, p.z + size.z / 2));
    const tableBox = new T.Box3().setFromObject(document.getElementById('codexr-analysis-table-geometry').object3D);
    tableBox.max.y += 2.2;

    // Evolution overlay at its preferred spot, which is inside the charts'
    // volume above the table: it must move off it and stay in the room.
    const overlaySize = { x: 6.2, y: 0.72, z: 0.05 };
    const overlay = document.createElement('a-entity');
    scene.appendChild(overlay);
    const placedOverlay = resolve(overlay, { x: 0, y: 3.35, z: -18 }, { size: overlaySize, viewer, preferUp: true });

    // A panel asked for a spot straight in front of a screen (0.2 m closer to
    // the viewer, not intersecting): it must not hide the screen.
    const frames = probe.frames();
    const screenCorners = frames.codexrVirtualScreenRoot;
    const screenCenter = screenCorners.reduce((a, p) => a.add(p), new T.Vector3()).multiplyScalar(0.25);
    const toViewer = viewer.clone().sub(screenCenter).normalize();
    const front = screenCenter.clone().addScaledVector(toViewer, 0.2);
    const panelSize = { x: 1, y: 0.6, z: 0.02 };
    const panel = document.createElement('a-entity');
    scene.appendChild(panel);
    const placedPanel = resolve(panel, front, { size: panelSize, viewer });
    const panelCorners = [];
    const pb = boxAt(placedPanel, panelSize);
    [pb.min.x, pb.max.x].forEach((x) => [pb.min.y, pb.max.y].forEach((y) => [pb.min.z, pb.max.z].forEach((z) => panelCorners.push(new T.Vector3(x, y, z)))));

    // Nothing to avoid but the room: a target beyond the west wall is clamped.
    const outside = resolve(panel, { x: -12, y: 2.5, z: -12 }, { size: panelSize, avoidTable: false });

    // Controller at its table corner: the table is not an obstacle for it,
    // so a free corner is kept as is.
    const controller = document.createElement('a-entity');
    scene.appendChild(controller);
    const corner = { x: 3.43, y: 1.24, z: -15.7 };
    const placedController = resolve(controller, corner, { size: { x: 1.03, y: 0.37, z: 0.3 }, avoidTable: false });

    return {
      overlayMoved: placedOverlay.y !== 3.35 || placedOverlay.x !== 0,
      overlayClearOfCharts: !boxAt(placedOverlay, overlaySize).intersectsBox(tableBox),
      overlayInside: probe.inside([boxAt(placedOverlay, overlaySize).min, boxAt(placedOverlay, overlaySize).max]),
      overlayFree: placedOverlay.free,
      panelHidesScreen: probe.overlap(probe.silhouette(panelCorners, viewer), probe.silhouette(screenCorners, viewer)),
      outsideClamped: probe.inside([boxAt(outside, panelSize).min, boxAt(outside, panelSize).max]),
      controllerKept: ['x', 'y', 'z'].every((axis) => Math.abs(placedController[axis] - corner[axis]) < 1e-6),
    };
  });
  await page.close();
  assert.deepEqual(errors, [], 'no page errors');
  assert.equal(result.overlayMoved, true, 'the evolution overlay leaves the chart volume');
  assert.equal(result.overlayClearOfCharts, true, 'the placed overlay does not intersect table + chart headroom');
  assert.equal(result.overlayInside, true, 'the placed overlay is inside the room');
  assert.equal(result.overlayFree, true, 'a free spot exists for the overlay');
  assert.equal(result.panelHidesScreen, false, 'a panel asked to stand 0.2 m in front of a screen is moved out of its line of sight');
  assert.equal(result.outsideClamped, true, 'a target beyond the wall is clamped into the room');
  assert.equal(result.controllerKept, true, 'the controller keeps a free table corner');
  console.log('[xr-panel-placement-harness] shared panel placement: overlay, occlusion, clamp, controller.');
}

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.log('[xr-panel-placement-harness] Playwright is not installed; static harness validation passed.');
    return;
  }
  const browser = await launchHarnessChromium(chromium);
  try {
    await bringDefaultThenGuide(browser);
    await bringNextToWall(browser);
    await sharedPanelPlacement(browser);
  } finally {
    await browser.close();
    await closeStaticServer();
  }
  console.log('[xr-panel-placement-harness] panel placement validation passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
