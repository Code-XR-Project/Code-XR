// == drillDownRuntime.js | inspectorCard (assembled per manifest.json; see COMPONENTS.md) ==
  // Click a building or a district of the chart on the table and a card
  // opens over it: what it is, where it is, and Analyze / Open in editor.
  // Clicks reach us through the scene (A-Frame's cursor events bubble), so
  // Babia's click highlight keeps working untouched. Babia's hover legend
  // still shows; the one a click pins in place is hidden, because the card
  // shows the same metrics right where that legend would stay.

  function viewContext() {
    var entityState = state.entity || {};
    var mode = currentMode();
    var config = readMappingConfig();
    var kind = mode === MODE
      ? entityState.target?.kind
      : (entityState.homeKind || config.targetType);
    var currentPath = mode === MODE ? entityState.targetPath : entityState.homePath;
    // A drilled folder's tree is built on `drillPath` (`<folder>/<relative path>`):
    // its district uids hang from the folder's parent.
    var treeBase = mode === MODE && entityState.treeField === 'drillPath' ? parentPath(entityState.targetPath) : '';
    return { viewKind: kind === 'file' ? 'file' : 'directory', rootPath: entityState.rootPath || '', currentPath: currentPath || '', treeBase: treeBase || '' };
  }

  function readMappingConfig() {
    var script = doc()?.getElementById?.('codexr-tooling-config-xr-mapping-ui');
    try { return JSON.parse(script?.textContent || '{}') || {}; } catch { return {}; }
  }

  function canOpenInEditor() {
    var hostBridge = root.CodeXRHostBridge;
    if (typeof hostBridge?.openInEditor === 'function') { return true; }
    var host = String(root.location?.hostname || '');
    var local = host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
    return local && typeof client()?.sendMessage === 'function';
  }

  function openInEditor(filePath, line) {
    var request = line ? { path: filePath, line: line } : { path: filePath };
    var hostBridge = root.CodeXRHostBridge;
    if (typeof hostBridge?.openInEditor === 'function') { hostBridge.openInEditor(request); return; }
    client()?.sendMessage?.('open-in-editor', request);
  }

  /** True when the table already shows exactly this target. */
  function isShowing(kind, absolutePath) {
    var context = viewContext();
    var relative = relativeTo(context.rootPath, absolutePath);
    var shown = currentMode() === MODE ? state.entity?.target : (state.entity ? { kind: state.entity.homeKind, relativePath: state.entity.homeRelativePath } : null);
    return !!shown && relative !== null && shown.kind === kind && shown.relativePath === relative;
  }

  function requestOpen(kind, absolutePath) {
    closeCard();
    if (send('drilldown-open', { path: absolutePath, kind: kind })) {
      showPendingLocally(relativeTo(state.entity?.rootPath, absolutePath) || baseName(absolutePath));
    }
  }

  function cardActions(target) {
    var actions = [];
    var outsideReason = 'Outside ' + (state.entity?.rootLabel || 'the analysed folder');
    var insideKnown = !state.entity?.rootPath || target.inside;
    if (target.type === 'folder' || target.type === 'file') {
      if (target.type === 'file') {
        var showingFile = isShowing('file', target.path);
        actions.push({
          label: showingFile ? 'Showing' : 'Analyze file',
          color: COLORS.analyze,
          enabled: insideKnown && !showingFile,
          run: function () { requestOpen('file', target.path); }
        });
      }
      var folderInside = !state.entity?.rootPath || target.folderRelativePath !== null;
      var showingFolder = isShowing('directory', target.folderPath);
      actions.push({
        label: showingFolder ? 'Showing' : 'Analyze folder',
        color: COLORS.analyze,
        enabled: folderInside && !showingFolder,
        run: function () { requestOpen('directory', target.folderPath); }
      });
    }
    if (target.filePath && canOpenInEditor()) {
      actions.push({
        label: 'Open in editor',
        color: COLORS.editor,
        enabled: true,
        run: function () { openInEditor(target.filePath, target.line); }
      });
    }
    return { actions: actions, note: insideKnown ? '' : outsideReason };
  }

  function cardTitle(target) {
    var prefix = target.type === 'folder' ? 'Folder' : target.type === 'function' ? 'Function' : 'File';
    return prefix + ': ' + compact(target.label, 30);
  }

  function cardSubtitle(target) {
    if (target.type === 'function') {
      var lines = target.line ? 'Lines ' + target.line + (target.lineEnd ? '-' + target.lineEnd : '') : '';
      return [lines, compact(baseName(target.filePath), 30)].filter(Boolean).join('  ·  ');
    }
    var relative = target.relativePath;
    return relative === null ? compact(target.path, 44) : (relative ? compact(relative, 44) : (state.entity?.rootLabel || ''));
  }

  function closeCard() {
    refs.card?.parentNode?.removeChild?.(refs.card);
    refs.card = null;
    state.cardKey = '';
  }

  function worldPositionOf(element) {
    var three = root.AFRAME?.THREE || root.THREE;
    if (!three || !element?.object3D) { return null; }
    var vector = new three.Vector3();
    element.object3D.getWorldPosition(vector);
    return vector;
  }

  /** Yaw (degrees) that turns a card at `position` toward the camera. */
  function yawToward(scene, position) {
    var three = root.AFRAME?.THREE || root.THREE;
    var camera = scene?.camera;
    if (!three || !camera?.getWorldPosition || !position) { return 0; }
    var eye = new three.Vector3();
    camera.getWorldPosition(eye);
    return Math.atan2(eye.x - position.x, eye.z - position.z) * 180 / Math.PI;
  }

  /** World y of the chart's highest point, so the card floats clear of every building. */
  function chartTopOf(chart) {
    var three = root.AFRAME?.THREE || root.THREE;
    if (!three?.Box3 || !chart?.object3D) { return null; }
    var box = new three.Box3().setFromObject(chart.object3D);
    return box.isEmpty() ? null : box.max.y;
  }

  function formatMetric(value) {
    return typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value);
  }

  /** "field (height): value" lines of a building, from the chart's own mapping. */
  function chartMetrics(chart, raw) {
    if (!raw || Array.isArray(raw.children)) { return []; }
    var mapping = chart?.getAttribute?.('babia-boats');
    if (!mapping || typeof mapping !== 'object') { return []; }
    return [['height', mapping.height], ['area', mapping.area], ['color', mapping.color]]
      .filter(function (pair) { return pair[1] && raw[pair[1]] !== undefined && raw[pair[1]] !== null; })
      .map(function (pair) { return compact(pair[1], 28) + ' (' + pair[0] + '): ' + formatMetric(raw[pair[1]]); });
  }

  /** Vertical layout of the card: rows from the top, buttons at the bottom. */
  function cardLayout(metricCount, hasNote) {
    var rows = metricCount + (hasNote ? 1 : 0);
    var height = CARD.height + rows * CARD.row;
    var top = height / 2;
    var title = top - 0.18;
    var subtitle = title - 0.18;
    var firstRow = subtitle - 0.17;
    return {
      height: height,
      title: title,
      subtitle: subtitle,
      row: function (index) { return firstRow - index * CARD.row; },
      buttons: -top + 0.21
    };
  }

  function cardFrame(layout, position) {
    var card = entity('a-entity', {
      id: 'codexrDrillDownCard',
      'data-codexr-role': 'drill-down inspector',
      position: position ? position.x.toFixed(3) + ' ' + position.y.toFixed(3) + ' ' + position.z.toFixed(3) : '0 2.2 -17'
    });
    card.appendChild(entity('a-plane', {
      width: CARD.width, height: layout.height,
      material: 'color: ' + COLORS.panel + '; opacity: 0.94; transparent: true; shader: flat'
    }));
    card.appendChild(entity('a-plane', {
      position: '0 ' + (layout.height / 2 - 0.012) + ' 0.004', width: CARD.width, height: 0.024,
      material: 'color: ' + ACCENT + '; shader: flat'
    }));
    var close = button('X', (CARD.width / 2 - 0.13) + ' ' + (layout.height / 2 - 0.13) + ' 0.012', 0.18, closeCard, COLORS.close, { height: 0.18 });
    close.el.setAttribute('data-codexr-role', 'drill-down close');
    card.appendChild(close.el);
    return card;
  }

  function appendCardText(card, target, spec, metrics, layout) {
    var left = -CARD.width / 2 + 0.1;
    card.appendChild(text(cardTitle(target), left + ' ' + layout.title + ' 0.01', 2.2, COLORS.current, 'left', 34));
    card.appendChild(text(cardSubtitle(target), left + ' ' + layout.subtitle + ' 0.01', 1.9, COLORS.muted, 'left', 44));
    metrics.forEach(function (line, index) {
      var row = text(line, left + ' ' + layout.row(index) + ' 0.01', 1.9, COLORS.text, 'left', 44);
      row.setAttribute('data-codexr-role', 'drill-down metric');
      card.appendChild(row);
    });
    if (spec.note) {
      card.appendChild(text(spec.note, left + ' ' + layout.row(metrics.length) + ' 0.01', 1.9, COLORS.error, 'left', 44));
    }
  }

  function appendCardActions(card, actions, y) {
    var count = actions.length;
    var gap = 0.06;
    var widthEach = count ? Math.min(0.98, (CARD.width - 0.16 - gap * (count - 1)) / count) : 0;
    var startX = -((widthEach * count) + gap * (count - 1)) / 2 + widthEach / 2;
    actions.forEach(function (action, index) {
      var handle = button(action.label, (startX + index * (widthEach + gap)).toFixed(3) + ' ' + y.toFixed(3) + ' 0.012', widthEach, action.run, action.color, { height: 0.26 });
      setButtonEnabled(handle, action.enabled);
      handle.el.setAttribute('data-codexr-role', 'drill-down action ' + action.label.toLowerCase().replace(/\s+/g, '-'));
      card.appendChild(handle.el);
    });
  }

  function openCard(target, element, chart, raw) {
    var key = target.type + ':' + target.path + ':' + (target.line || '');
    if (refs.card && state.cardKey === key) { closeCard(); return; }
    closeCard();
    var scene = sceneEl();
    if (!scene) { return; }
    var spec = cardActions(target);
    var metrics = chartMetrics(chart, raw);
    var layout = cardLayout(metrics.length, !!spec.note);
    var position = worldPositionOf(element);
    var top = chartTopOf(chart);
    if (position) {
      position.y = Math.max(position.y + CARD.lift, top == null ? -Infinity : top + layout.height / 2 + 0.12);
    }
    var card = cardFrame(layout, position);
    appendCardText(card, target, spec, metrics, layout);
    appendCardActions(card, spec.actions, layout.buttons);
    // Turned toward the viewer from the position it is given: the entity's
    // own object3D is not placed until A-Frame loads it, a frame later.
    card.setAttribute('rotation', '0 ' + yawToward(scene, position).toFixed(1) + ' 0');
    scene.appendChild(card);
    refs.card = card;
    state.cardKey = key;
    state.cardTarget = target;
  }

  /**
   * Babia-boats pins the hover legend of a clicked building (`element.legend`,
   * an a-plane with babia-lookat appended next to the chart) until the next
   * click. The card replaces it, so that one legend is hidden; hovering any
   * other building still shows Babia's legend.
   */
  function isPinnedLegend(node) {
    return !!node && node.nodeType === 1 && String(node.tagName).toUpperCase() === 'A-PLANE' && !!node.hasAttribute?.('babia-lookat');
  }

  function hidePinnedLegend(element) {
    var legend = element?.legend;
    if (!isPinnedLegend(legend)) { return false; }
    // Shrunk as well as hidden: showing the parked classic analysis again
    // re-shows everything under its root, this legend included.
    legend.setAttribute('visible', false);
    legend.setAttribute('scale', '0.0001 0.0001 0.0001');
    legend.setAttribute('data-codexr-hidden-by', 'drill-down card');
    return true;
  }

  function handleSceneClick(event) {
    if (!isNavigableMode()) { return; }
    var element = event?.target;
    if (!element || element.nodeType !== 1) { return; }
    if (refs.card && refs.card.contains?.(element)) { return; }
    var chart = pickableChartOf(element);
    if (!chart) { return; }
    var picked = findRawData(element, chart);
    if (!picked) { return; }
    var target = targetFromRaw(picked.raw, viewContext());
    if (!target) { return; }
    if (!state.entity && !state.stateRequested) { requestState(); }
    // Babia's own click handler ran first (on the building): its legend is pinned now.
    hidePinnedLegend(picked.element);
    if (picked.element !== element) { hidePinnedLegend(element); }
    openCard(target, picked.element, chart, picked.raw);
  }

  function bindSceneClicks() {
    var scene = sceneEl();
    if (state.sceneClickBound || !scene) { return !!state.sceneClickBound; }
    scene.addEventListener('click', handleSceneClick);
    state.sceneClickBound = true;
    state.disposables.push(function () {
      scene.removeEventListener('click', handleSceneClick);
      state.sceneClickBound = false;
    });
    return true;
  }
