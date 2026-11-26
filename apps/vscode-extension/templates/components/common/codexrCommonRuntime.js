(function registerCodeXRCommonRuntime(root) {
  'use strict';

  function doc() {
    return root.document || null;
  }

  function createEntity(tag, attributes) {
    const document = doc();
    if (!document || !document.createElement) {
      return null;
    }
    const el = document.createElement(tag);
    Object.keys(attributes || {}).forEach(function (key) {
      el.setAttribute(key, attributes[key]);
    });
    return el;
  }

  function truncateText(value, maxLength) {
    const text = String(value == null ? '' : value);
    const limit = Math.max(1, Number(maxLength) || 80);
    return text.length > limit ? text.slice(0, Math.max(0, limit - 3)) + '...' : text;
  }

  function tooltipText(value, position, width, color, align) {
    const el = createEntity('a-text', {
      value: value || '',
      position: position || '0 0 0.02',
      width: width || 3,
      color: color || '#ffffff',
      align: align || 'left',
      baseline: 'center',
      'wrap-count': 56
    });
    return el;
  }

  function formatPosition(value) {
    return value.x + ' ' + value.y + ' ' + value.z;
  }

  function normalizeTooltipRows(model) {
    if (Array.isArray(model.rows) && model.rows.length) {
      return model.rows.map(function (row) {
        if (typeof row === 'string') {
          return { label: '', value: row };
        }
        return {
          label: String(row && row.label != null ? row.label : ''),
          value: String(row && row.value != null ? row.value : '')
        };
      });
    }
    return [
      model.primary ? { label: '', value: String(model.primary) } : null,
      model.secondary ? { label: '', value: String(model.secondary) } : null
    ].filter(Boolean);
  }

  function setVisible(entity, visible) {
    if (entity && entity.setAttribute) {
      entity.setAttribute('visible', !!visible);
    }
  }

  function ensureTooltipRows(tooltip, count) {
    tooltip.rows = tooltip.rows || [];
    while (tooltip.rows.length < count) {
      // A metric cell = a muted mini-label + a bright value, laid out in a
      // compact grid by updateTooltip (positions/widths set there).
      const label = tooltipText('', '0 0 .019', .7, '#7c8aa5', 'left');
      const value = tooltipText('', '0 0 .019', .7, '#f1f5f9', 'left');
      label.setAttribute('wrap-count', 16);
      value.setAttribute('wrap-count', 14);
      tooltip.root.appendChild(label);
      tooltip.root.appendChild(value);
      tooltip.rows.push({ label: label, value: value });
    }
    tooltip.rows.forEach(function (row, index) {
      setVisible(row.label, index < count);
      setVisible(row.value, index < count);
    });
    return tooltip.rows;
  }

  function createTooltip(options) {
    const opts = options || {};
    const rootEl = createEntity('a-entity', { visible: false });
    if (!rootEl) {
      return null;
    }
    const width = Number(opts.width) || 2.8;
    const height = Number(opts.height) || .9;
    const accentColor = opts.accentColor || '#38bdf8';
    // Accent-tinted frame just behind the panel for a crisp, non-bland edge.
    const border = createEntity('a-plane', {
      position: '0 0 -0.012',
      width: width + .06,
      height: height + .06,
      material: 'color: ' + accentColor + '; opacity: .5; shader: flat; side: double; transparent: true'
    });
    // The backing is opaque and depth-tested, and it absorbs the pointer ray.
    // depthTest:false here once let every screen behind the card paint over it
    // (A-Frame 1.7.1 draws transparent objects in DOM order, not by distance),
    // and a card without the raycaster class let clicks fall through to
    // whatever was behind it.
    const background = createEntity('a-plane', {
      width: width,
      height: height,
      class: opts.raycastClass === undefined ? 'babiaxraycasterclass' : opts.raycastClass,
      'data-codexr-role': 'tooltip background',
      material: 'color: #0e1626; shader: flat; side: double'
    });
    // Left vertical accent bar carries the selected element's type colour.
    const accent = createEntity('a-plane', {
      position: (-(width / 2) + .035) + ' 0 .008',
      width: .07,
      height: height,
      material: 'color: ' + accentColor + '; shader: flat'
    });
    // Thin accent divider under the header.
    const divider = createEntity('a-plane', {
      position: '0 0 .01',
      width: width - .3,
      height: .006,
      material: 'color: ' + accentColor + '; opacity: .4; shader: flat'
    });
    const textX = -(width / 2) + .2;
    const title = tooltipText('', (textX + .02) + ' .26 .018', width - .4, '#f8fafc', 'left');
    const subtitle = tooltipText('', textX + ' .06 .018', width - .4, '#93a7c4', 'left');
    const primary = tooltipText('', textX + ' -.14 .018', width - .4, '#e2e8f0', 'left');
    const secondary = tooltipText('', textX + ' -.33 .018', width - .4, '#93a7c4', 'left');
    title.setAttribute('wrap-count', 26);
    subtitle.setAttribute('wrap-count', 40);
    primary.setAttribute('wrap-count', 40);
    secondary.setAttribute('wrap-count', 40);
    rootEl.appendChild(border);
    rootEl.appendChild(background);
    rootEl.appendChild(accent);
    rootEl.appendChild(divider);
    rootEl.appendChild(title);
    rootEl.appendChild(subtitle);
    rootEl.appendChild(primary);
    rootEl.appendChild(secondary);
    return {
      root: rootEl,
      border: border,
      background: background,
      accent: accent,
      divider: divider,
      title: title,
      subtitle: subtitle,
      primary: primary,
      secondary: secondary,
      action: null,
      rows: [],
      width: width,
      height: height,
      accentColor: accentColor
    };
  }

  function ensureTooltipConnector(tooltip) {
    if (!tooltip || !tooltip.root || !tooltip.root.parentNode) {
      return null;
    }
    if (tooltip.connectorRoot && tooltip.connectorRoot.parentNode === tooltip.root.parentNode) {
      return tooltip.connectorRoot;
    }
    const connectorRoot = tooltip.connectorRoot || createEntity('a-entity', {
      visible: false,
      class: 'codexr-tooltip-connector codexr-tooltip-auxiliary',
      'data-codexr-role': 'tooltip connector'
    });
    if (!connectorRoot) {
      return null;
    }
    if (!tooltip.connectorLine) {
      tooltip.connectorLine = createEntity('a-entity', {
        class: 'codexr-tooltip-connector-line codexr-tooltip-auxiliary',
        'data-codexr-role': 'tooltip connector line'
      });
      connectorRoot.appendChild(tooltip.connectorLine);
    }
    if (!tooltip.connectorMarker) {
      tooltip.connectorMarker = createEntity('a-sphere', {
        radius: .035,
        segmentsWidth: 10,
        segmentsHeight: 6,
        class: 'codexr-tooltip-connector-marker codexr-tooltip-auxiliary',
        'data-codexr-role': 'tooltip connector marker',
        material: 'color: #f59e0b; shader: flat; opacity: .92; transparent: true'
      });
      connectorRoot.appendChild(tooltip.connectorMarker);
    }
    tooltip.connectorRoot = connectorRoot;
    tooltip.root.parentNode.appendChild(connectorRoot);
    return connectorRoot;
  }

  function updateTooltipConnector(tooltip, tooltipPosition, targetPosition, options) {
    if (!tooltip || !targetPosition || !Number.isFinite(targetPosition.x) || !Number.isFinite(targetPosition.y) || !Number.isFinite(targetPosition.z)) {
      if (tooltip && tooltip.connectorRoot) {
        tooltip.connectorRoot.setAttribute('visible', false);
      }
      return false;
    }
    const connectorRoot = ensureTooltipConnector(tooltip);
    if (!connectorRoot) {
      return false;
    }
    const opts = options || {};
    const position = tooltipPosition && Number.isFinite(tooltipPosition.x)
      ? tooltipPosition
      : { x: 0, y: 0, z: 0 };
    const height = Number(tooltip.height) || .92;
    const color = opts.connectorColor || opts.color || '#f59e0b';
    const start = opts.connectorStart || {
      x: position.x,
      y: position.y - (height * .5),
      z: position.z
    };
    const end = {
      x: targetPosition.x,
      y: targetPosition.y + (Number(opts.targetLift) || .045),
      z: targetPosition.z
    };
    tooltip.connectorLine.setAttribute('line', {
      start: formatPosition(start),
      end: formatPosition(end),
      color: color,
      opacity: Number(opts.opacity) || .88
    });
    tooltip.connectorMarker.setAttribute('position', formatPosition(end));
    tooltip.connectorMarker.setAttribute('material', 'color: ' + color + '; shader: flat; opacity: .92; transparent: true');
    connectorRoot.setAttribute('visible', true);
    return true;
  }

  function updateTooltip(tooltip, detail, position, options) {
    if (!tooltip || !tooltip.root) {
      return false;
    }
    const opts = options || {};
    const model = detail || {};
    const rows = normalizeTooltipRows(model);
    // A structured metric grid (model.rows) is the compact/rich path; otherwise
    // fall back to the legacy stacked primary/secondary lines.
    const useGrid = Array.isArray(model.rows) && model.rows.length > 0;
    const columns = Math.max(1, Math.round(Number(opts.columns) || 2));
    const width = Number(opts.width) || tooltip.width || 2.8;
    const accentColor = model.accentColor || opts.accentColor || tooltip.accentColor || '#38bdf8';
    const hasSubtitle = !!model.subtitle;
    const headerH = hasSubtitle ? .5 : .34;
    const rowStep = Number(opts.rowStep) || .19;
    const footerReserve = Math.max(0, Number(opts.footerReserve) || 0);
    const gridRows = useGrid ? Math.ceil(rows.length / columns) : 0;
    const height = useGrid
      ? Math.max(Number(opts.minHeight) || .68, headerH + gridRows * rowStep + .16 + footerReserve)
      : (Number(opts.height) || tooltip.height || .9);
    const half = height / 2;
    const textX = -(width / 2) + .2;
    const textWidth = Math.max(.9, width - .4);
    const contentW = Math.max(.9, width - .42);

    let resolvedPosition = null;
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)) {
      tooltip.root.setAttribute('position', position.x + ' ' + position.y + ' ' + position.z);
      resolvedPosition = position;
    } else if (typeof position === 'string') {
      tooltip.root.setAttribute('position', position);
    }
    tooltip.width = width;
    tooltip.height = height;
    tooltip.accentColor = accentColor;

    // Chrome (panel, accent-tinted frame, left accent bar, header swatch/divider).
    tooltip.background.setAttribute('width', width);
    tooltip.background.setAttribute('height', height);
    if (tooltip.border) {
      tooltip.border.setAttribute('width', width + .06);
      tooltip.border.setAttribute('height', height + .06);
      tooltip.border.setAttribute('material', 'color', accentColor);
    }
    tooltip.accent.setAttribute('width', .07);
    tooltip.accent.setAttribute('height', height);
    tooltip.accent.setAttribute('position', (-(width / 2) + .035) + ' 0 .008');
    tooltip.accent.setAttribute('material', 'color', accentColor);
    if (tooltip.divider) {
      tooltip.divider.setAttribute('width', width - .3);
      tooltip.divider.setAttribute('material', 'color', accentColor);
      tooltip.divider.setAttribute('position', '0 ' + (half - headerH + .05) + ' .01');
      setVisible(tooltip.divider, useGrid);
    }

    // Header.
    tooltip.title.setAttribute('position', (textX + .02) + ' ' + (half - .2) + ' .018');
    tooltip.subtitle.setAttribute('position', textX + ' ' + (half - .4) + ' .018');
    tooltip.title.setAttribute('width', textWidth);
    tooltip.subtitle.setAttribute('width', textWidth);
    tooltip.title.setAttribute('value', truncateText(model.title, opts.titleLength || 30));
    tooltip.subtitle.setAttribute('value', truncateText(model.subtitle, opts.subtitleLength || 46));
    setVisible(tooltip.subtitle, hasSubtitle);

    if (useGrid) {
      setVisible(tooltip.primary, false);
      setVisible(tooltip.secondary, false);
      const gridTop = half - headerH - .02;
      const cellW = contentW / columns;
      ensureTooltipRows(tooltip, rows.length).forEach(function (row, index) {
        const rowModel = rows[index] || {};
        const r = Math.floor(index / columns);
        const c = index % columns;
        const cellX = textX + c * cellW;
        const cellY = gridTop - r * rowStep;
        row.label.setAttribute('position', cellX + ' ' + cellY + ' .019');
        row.value.setAttribute('position', (cellX + cellW * .52) + ' ' + cellY + ' .019');
        row.label.setAttribute('width', cellW * .66);
        row.value.setAttribute('width', cellW * .52);
        row.label.setAttribute('value', truncateText(rowModel.label, opts.rowLabelLength || 12));
        row.value.setAttribute('value', truncateText(rowModel.value, opts.rowValueLength || 12));
      });
    } else {
      ensureTooltipRows(tooltip, 0);
      const secondaryY = -half + .18 + footerReserve;
      const primaryY = footerReserve > 0 ? secondaryY + .21 : -0.04;
      tooltip.primary.setAttribute('position', textX + ' ' + primaryY + ' .018');
      tooltip.secondary.setAttribute('position', textX + ' ' + secondaryY + ' .018');
      tooltip.primary.setAttribute('width', textWidth);
      tooltip.secondary.setAttribute('width', textWidth);
      tooltip.primary.setAttribute('value', truncateText(model.primary, opts.primaryLength || 62));
      tooltip.secondary.setAttribute('value', truncateText(model.secondary, opts.secondaryLength || 62));
      setVisible(tooltip.primary, !!model.primary);
      setVisible(tooltip.secondary, !!model.secondary);
    }

    tooltip.root.setAttribute('scale', '.96 .96 .96');
    tooltip.root.setAttribute('animation__codexr_tooltip_in', {
      property: 'scale',
      from: '.96 .96 .96',
      to: '1 1 1',
      dur: Number(opts.animationDuration) || 200,
      easing: 'easeOutCubic'
    });
    tooltip.root.setAttribute('visible', true);
    updateTooltipConnector(tooltip, resolvedPosition, opts.connectorTarget || model.connectorTarget || null, opts);
    return true;
  }

  function hideTooltip(tooltip) {
    if (tooltip && tooltip.root) {
      tooltip.root.setAttribute('visible', false);
    }
    if (tooltip && tooltip.connectorRoot) {
      tooltip.connectorRoot.setAttribute('visible', false);
    }
  }

  // Non-overlapping grid slot for the Nth of `count` legend cards — a shared
  // primitive so any Code-XR legend surface can lay multiple cards out without
  // them overlapping (centered rows, wrapping upward into a grid). With
  // `maxRows` the grid grows sideways instead of past that many rows, so a
  // full stack never climbs through the ceiling (PANELS-7).
  function legendSlotPosition(index, count, options) {
    const opts = options || {};
    const total = Math.max(1, Number(count) || 1);
    const basePerRow = Math.max(1, Math.round(Number(opts.perRow) || 3));
    const maxRows = Math.round(Number(opts.maxRows) || 0);
    const perRow = maxRows > 0 ? Math.max(basePerRow, Math.ceil(total / maxRows)) : basePerRow;
    const cardWidth = Number(opts.cardWidth) || 2.8;
    const cardHeight = Number(opts.cardHeight) || 1.1;
    const gapX = opts.gapX != null ? Number(opts.gapX) : .3;
    const gapY = opts.gapY != null ? Number(opts.gapY) : .3;
    const originX = Number(opts.originX) || 0;
    const originY = Number(opts.originY) || 0;
    const z = opts.z != null ? Number(opts.z) : 0;
    const i = Math.max(0, Number(index) || 0);
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const itemsInRow = Math.min(perRow, total - row * perRow);
    return {
      x: originX + (col - (itemsInRow - 1) / 2) * (cardWidth + gapX),
      y: originY + row * (cardHeight + gapY),
      z: z
    };
  }

  function faceCamera(entity, scene) {
    if (!entity || !entity.object3D || !root.THREE) {
      return false;
    }
    const camera = scene?.camera || entity.sceneEl?.camera;
    if (!camera || !camera.getWorldPosition) {
      return false;
    }
    const cameraPosition = new root.THREE.Vector3();
    camera.getWorldPosition(cameraPosition);
    entity.object3D.lookAt(cameraPosition);
    return true;
  }

  // Yaw-only billboard: rotates the entity around Y (in its parent's space) so
  // it faces the camera while staying upright. Rotating a GROUP of legend cards
  // this way keeps their relative layout rigid — they follow the user without
  // ever rotating into each other.
  function faceCameraYaw(entity, scene) {
    if (!entity || !entity.object3D || !root.THREE) {
      return false;
    }
    const camera = scene?.camera || entity.sceneEl?.camera;
    if (!camera || !camera.getWorldPosition) {
      return false;
    }
    const cameraPosition = new root.THREE.Vector3();
    camera.getWorldPosition(cameraPosition);
    const parent = entity.object3D.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      parent.worldToLocal(cameraPosition);
    }
    const dx = cameraPosition.x - entity.object3D.position.x;
    const dz = cameraPosition.z - entity.object3D.position.z;
    entity.object3D.rotation.set(0, Math.atan2(dx, dz), 0);
    return true;
  }

  function attachPickHitbox(entity, options) {
    if (!entity || !root.THREE || typeof entity.setObject3D !== 'function') {
      return null;
    }
    const opts = options || {};
    const radius = Math.max(.001, Number(opts.radius) || .12);
    const height = Math.max(.001, Number(opts.height) || radius * 2);
    const geometry = opts.shape === 'box'
      ? new root.THREE.BoxGeometry(radius * 2, height, radius * 2)
      : new root.THREE.SphereGeometry(radius, 10, 8);
    const material = new root.THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
      visible: false
    });
    const mesh = new root.THREE.Mesh(geometry, material);
    if (opts.position && mesh.position) {
      mesh.position.set(Number(opts.position.x) || 0, Number(opts.position.y) || 0, Number(opts.position.z) || 0);
    }
    entity.setObject3D(opts.name || 'codexr-hitbox', mesh);
    if (entity.classList && opts.raycastClass) {
      entity.classList.add(opts.raycastClass);
    }
    entity.setAttribute?.('data-codexr-interactive', 'true');
    return mesh;
  }

  // ── Shared panel placement (PANELS-3/9) ────────────────────────────────────
  // The same placement registry the virtual screens use (placementRegistry.js
  // in the screen runtime), for the panels that are not screens: the project
  // evolution playback overlay and the controller (field mapping) panel. The
  // obstacles are the same set, found the same way: every shown screen root,
  // every shown entity tagged data-codexr-panel-obstacle, and the analysis
  // table extended upward by the chart headroom. A panel asks for a world
  // position; it gets the nearest free one (right, left, up, then further
  // out), always kept inside the room shell, or the target clamped into the
  // room when nothing is free. With a viewer position it also refuses a spot
  // whose silhouette, seen from the viewer, covers a screen or a tagged panel:
  // two panels 0.2 m apart in depth never intersect, yet the front one hides
  // the other completely. Positions are world coordinates, so the panel must
  // be a child of the scene (both callers are).
  const PANEL_PLACEMENT_GAP = 0.25;
  const PANEL_PLACEMENT_RINGS = 3;
  const PANEL_TABLE_CHART_HEADROOM = 2.2;
  const PANEL_ROOM_MARGIN = 0.05;
  const PANEL_OBSTACLE_CACHE_MS = 250;
  // Silhouettes closer than this (tangent units, ~1 degree) count as touching.
  const PANEL_OCCLUSION_MARGIN = 0.02;
  const PANEL_SILHOUETTE_NEAR = 0.05;
  let panelObstacleCache = null;

  function isShownInScene(object3D) {
    for (let node = object3D; node; node = node.parent) {
      if (node.visible === false) {
        return false;
      }
    }
    return true;
  }

  function panelRoomBounds() {
    const document = doc();
    // In AR the room is hidden: nothing to stay inside (same rule as screens).
    if (document?.querySelector?.('a-scene')?.is?.('ar-mode')) {
      return null;
    }
    const roomEl = document?.querySelector?.('[codexr-room]');
    const room = roomEl?.components?.['codexr-room']?.data;
    if (!roomEl?.object3D || !room) {
      return null;
    }
    const center = roomEl.object3D.position;
    const wall = Math.max(0.05, Number(room.wallThickness) || 0.25);
    return {
      min: { x: center.x - (room.width / 2) + wall + PANEL_ROOM_MARGIN, y: center.y + (Number(room.floorThickness) || 0.22) + PANEL_ROOM_MARGIN, z: center.z - (room.depth / 2) + wall + PANEL_ROOM_MARGIN },
      max: { x: center.x + (room.width / 2) - wall - PANEL_ROOM_MARGIN, y: center.y + room.height - (Number(room.ceilingThickness) || 0.18) - PANEL_ROOM_MARGIN, z: center.z + (room.depth / 2) - wall - PANEL_ROOM_MARGIN },
    };
  }

  // World box of what is actually drawn: Box3.setFromObject also counts
  // hidden children (a screen's closed menus, idle video plane), which made
  // a screen look several times its size.
  function visibleWorldBox(object3D) {
    const box = new root.THREE.Box3();
    const part = new root.THREE.Box3();
    object3D.updateMatrixWorld?.(true);
    object3D.traverseVisible?.(function (node) {
      const geometry = node.geometry;
      if (!geometry) {
        return;
      }
      if (!geometry.boundingBox) {
        geometry.computeBoundingBox?.();
      }
      if (geometry.boundingBox && !geometry.boundingBox.isEmpty()) {
        box.union(part.copy(geometry.boundingBox).applyMatrix4(node.matrixWorld));
      }
    });
    return box;
  }

  function collectPlacementObstacles(panelEl, avoidTable) {
    const now = Date.now();
    if (panelObstacleCache && panelObstacleCache.panelEl === panelEl
      && panelObstacleCache.avoidTable === avoidTable
      && (now - panelObstacleCache.time) < PANEL_OBSTACLE_CACHE_MS) {
      return panelObstacleCache.list;
    }
    const document = doc();
    const list = [];
    function add(node, extraHeight, occluder) {
      if (!node?.object3D || node === panelEl || panelEl?.contains?.(node) || node.contains?.(panelEl)
        || !isShownInScene(node.object3D)) {
        return;
      }
      const box = visibleWorldBox(node.object3D);
      if (box.isEmpty()) {
        return;
      }
      box.max.y += extraHeight;
      list.push({ box: box, occluder: occluder });
    }
    document?.querySelectorAll?.('[id^="codexrVirtualScreenRoot"]').forEach(function (node) { add(node, 0, true); });
    document?.querySelectorAll?.('[data-codexr-panel-obstacle]').forEach(function (node) { add(node, 0, true); });
    if (avoidTable) {
      add(document?.querySelector?.('#codexr-analysis-table-geometry'), PANEL_TABLE_CHART_HEADROOM, false);
    }
    panelObstacleCache = { panelEl: panelEl, avoidTable: avoidTable, time: now, list: list };
    return list;
  }

  function boxCorners(box) {
    const corners = [];
    [box.min.x, box.max.x].forEach(function (x) {
      [box.min.y, box.max.y].forEach(function (y) {
        [box.min.z, box.max.z].forEach(function (z) {
          corners.push(new root.THREE.Vector3(x, y, z));
        });
      });
    });
    return corners;
  }

  // Angular extent of a set of points seen from `viewer` along `frame`; null
  // when none is in front of the viewer. Points beside or behind the viewer
  // are pulled onto a near plane, which only widens the extent.
  function silhouette(corners, viewer, frame) {
    const out = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    let inFront = false;
    for (const corner of corners) {
      const v = corner.clone().sub(viewer);
      let depth = v.dot(frame.forward);
      if (depth > PANEL_SILHOUETTE_NEAR) {
        inFront = true;
      } else {
        depth = PANEL_SILHOUETTE_NEAR;
      }
      const sx = v.dot(frame.right) / depth;
      const sy = v.dot(frame.up) / depth;
      out.minX = Math.min(out.minX, sx); out.maxX = Math.max(out.maxX, sx);
      out.minY = Math.min(out.minY, sy); out.maxY = Math.max(out.maxY, sy);
    }
    return inFront ? out : null;
  }

  function viewFrame(viewer, target) {
    const forward = target.clone().sub(viewer);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) {
      return null;
    }
    forward.normalize();
    const up = new root.THREE.Vector3(0, 1, 0);
    const right = new root.THREE.Vector3().crossVectors(forward, up).normalize();
    return { forward: forward, right: right, up: up };
  }

  function silhouettesOverlap(a, b) {
    return a.minX < b.maxX + PANEL_OCCLUSION_MARGIN && b.minX < a.maxX + PANEL_OCCLUSION_MARGIN
      && a.minY < b.maxY + PANEL_OCCLUSION_MARGIN && b.minY < a.maxY + PANEL_OCCLUSION_MARGIN;
  }

  function clampBoxIntoRoom(position, half, bounds) {
    if (!bounds) {
      return position.clone();
    }
    const clamped = position.clone();
    ['x', 'y', 'z'].forEach(function (axis) {
      const low = bounds.min[axis] + half[axis];
      const high = bounds.max[axis] - half[axis];
      clamped[axis] = low > high ? (bounds.min[axis] + bounds.max[axis]) / 2 : Math.min(high, Math.max(low, clamped[axis]));
    });
    return clamped;
  }

  /**
   * resolvePanelPlacement(panelEl, target, options) -> { x, y, z, free }
   * options.size: full extents {x, y, z} (defaults to the panel's current
   *   world box), options.viewer: viewer world position (enables the
   *   "does not hide another panel" rule), options.avoidTable (default
   *   true), options.preferUp: try above before the sides.
   */
  function resolvePanelPlacement(panelEl, target, options) {
    const opts = options || {};
    if (!root.THREE?.Box3 || !root.THREE?.Vector3 || !target) {
      return target ? { x: target.x, y: target.y, z: target.z, free: false } : null;
    }
    const T = root.THREE;
    let half;
    if (opts.size) {
      half = new T.Vector3(Number(opts.size.x) / 2 || 0, Number(opts.size.y) / 2 || 0, Number(opts.size.z) / 2 || 0);
    } else if (panelEl?.object3D) {
      const own = visibleWorldBox(panelEl.object3D);
      half = own.isEmpty() ? new T.Vector3() : own.getSize(new T.Vector3()).multiplyScalar(0.5);
    } else {
      half = new T.Vector3();
    }
    const viewer = opts.viewer ? new T.Vector3(opts.viewer.x, opts.viewer.y, opts.viewer.z) : null;
    const bounds = panelRoomBounds();
    const obstacles = collectPlacementObstacles(panelEl || null, opts.avoidTable !== false);
    const start = clampBoxIntoRoom(new T.Vector3(Number(target.x) || 0, Number(target.y) || 0, Number(target.z) || 0), half, bounds);
    const frame = viewer ? viewFrame(viewer, start) : null;

    function isFree(center) {
      const box = new T.Box3(center.clone().sub(half), center.clone().add(half));
      for (const obstacle of obstacles) {
        if (box.intersectsBox(obstacle.box)) {
          return false;
        }
      }
      if (!frame) {
        return true;
      }
      const own = silhouette(boxCorners(box), viewer, frame);
      if (!own) {
        return true;
      }
      for (const obstacle of obstacles) {
        if (!obstacle.occluder) {
          continue;
        }
        const other = silhouette(boxCorners(obstacle.box), viewer, frame);
        if (other && silhouettesOverlap(own, other)) {
          return false;
        }
      }
      return true;
    }

    function result(position, free) {
      return { x: position.x, y: position.y, z: position.z, free: free };
    }

    if (isFree(start)) {
      return result(start, true);
    }
    const right = frame ? frame.right.clone() : new T.Vector3(1, 0, 0);
    const up = new T.Vector3(0, 1, 0);
    const stepX = (half.x * 2) + PANEL_PLACEMENT_GAP;
    const stepY = (half.y * 2) + PANEL_PLACEMENT_GAP;
    for (let ring = 1; ring <= PANEL_PLACEMENT_RINGS; ring += 1) {
      const offsets = opts.preferUp
        ? [[0, ring], [ring, 0], [-ring, 0], [ring, ring], [-ring, ring]]
        : [[ring, 0], [-ring, 0], [0, ring], [ring, ring], [-ring, ring], [0, -ring]];
      for (const offset of offsets) {
        const candidate = clampBoxIntoRoom(
          start.clone().addScaledVector(right, offset[0] * stepX).addScaledVector(up, offset[1] * stepY),
          half,
          bounds,
        );
        if (isFree(candidate)) {
          return result(candidate, true);
        }
      }
    }
    // Nothing free: the target, but never outside the room.
    return result(start, false);
  }

  const api = {
    resolvePanelPlacement: resolvePanelPlacement,
    createTooltip: createTooltip,
    updateTooltip: updateTooltip,
    updateTooltipConnector: updateTooltipConnector,
    hideTooltip: hideTooltip,
    legendSlotPosition: legendSlotPosition,
    faceCamera: faceCamera,
    faceCameraYaw: faceCameraYaw,
    attachPickHitbox: attachPickHitbox,
    truncateText: truncateText,
    createEntity: createEntity
  };

  root.CodeXRCommonRuntime = root.CodeXRCommonRuntime || api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
