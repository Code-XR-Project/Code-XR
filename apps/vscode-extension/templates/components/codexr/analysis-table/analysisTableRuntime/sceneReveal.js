// == analysisTableRuntime.js | sceneReveal (assembled per manifest.json; see COMPONENTS.md) ==
  // #178: "Reveal in XR scene". The editor (VS Code or the Code-XR IDE) asks
  // the analysis server, which sends `reveal-in-scene` { path } to the room,
  // the path relative to the analysed folder. In the classic analysis the
  // file's element in the chart on the table gets a marker over it and its
  // Babia legend; in the dependency graph its node's card is pinned and
  // marked. Only a page on this machine acts on it: a guest's view never
  // jumps because the host clicked something in the editor.
  var REVEAL_MESSAGE = 'reveal-in-scene';
  var REVEAL_MARKER_ID = 'codexr-reveal-marker';
  var REVEAL_DURATION_MS = 8000;
  var REVEAL_COLOR = '#2fb0ff';
  var revealState = { marker: null, target: null, timer: null, registered: false };

  function revealIsLocalPage() {
    var host = String(root.location?.hostname || '');
    return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  }

  function normalizeRevealPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  }

  function revealMode() {
    return root.CodeXRAnalysisModeRuntime?.getState?.()?.mode || 'single';
  }

  // The chart entity of the file: Babia keeps the data row on boats
  // (babiaRawData) and the x label on bars and cylinders (babia-name). An
  // exact relative path wins; a bare file name is the fallback for charts
  // whose rows only carry it.
  function chartElementForPath(relativePath) {
    var doc = root.document;
    var chart = doc?.getElementById?.('chart');
    if (!chart?.querySelectorAll) { return null; }
    var fileName = relativePath.split('/').pop();
    var fallback = null;
    var elements = chart.querySelectorAll('*');
    for (var index = 0; index < elements.length; index++) {
      var element = elements[index];
      var raw = element.babiaRawData;
      var label = element.getAttribute?.('babia-name');
      if ((raw && normalizeRevealPath(raw.relativePath) === relativePath) || label === relativePath) {
        return element;
      }
      if (!fallback && ((raw && !raw.relativePath && raw.fileName === fileName) || (label && label === fileName))) {
        fallback = element;
      }
    }
    return fallback;
  }

  function dependencyElementForPath(relativePath) {
    var graph = root.document?.querySelector?.('[codexr-dependency-graph]');
    return graph?.components?.['codexr-dependency-graph']?.revealFile?.(relativePath) || null;
  }

  function clearRevealMarker() {
    if (revealState.timer) { root.clearTimeout?.(revealState.timer); }
    revealState.timer = null;
    if (revealState.marker?.parentNode) { revealState.marker.parentNode.removeChild(revealState.marker); }
    revealState.marker = null;
    if (revealState.target?.dispatchEvent && root.CustomEvent) {
      revealState.target.dispatchEvent(new root.CustomEvent('mouseleave'));
    }
    revealState.target = null;
  }

  // A cone pointing down at the element plus a ring around its foot, in world
  // coordinates (the marker hangs from the scene, so the table's scale and
  // the chart's rotation do not distort it), bobbing for a few seconds.
  function showRevealMarker(target) {
    var doc = root.document;
    var scene = doc?.querySelector?.('a-scene');
    var THREE = root.AFRAME?.THREE;
    if (!scene || !THREE || !target.object3D) { return false; }
    var box = new THREE.Box3().setFromObject(target.object3D);
    if (box.isEmpty()) { return false; }
    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var span = Math.min(Math.max(Math.max(size.x, size.z), 0.25), 3);
    var lift = Math.min(Math.max(span * 0.6, 0.35), 1.5);
    clearRevealMarker();
    var marker = doc.createElement('a-entity');
    marker.id = REVEAL_MARKER_ID;
    marker.setAttribute('data-codexr-role', 'reveal-marker');
    marker.setAttribute('position', center.x + ' ' + (box.max.y + lift) + ' ' + center.z);
    var cone = doc.createElement('a-entity');
    cone.setAttribute('geometry', 'primitive: cone; radiusBottom: ' + (lift * 0.35) + '; radiusTop: 0; height: ' + (lift * 0.7));
    cone.setAttribute('material', 'color: ' + REVEAL_COLOR + '; shader: flat');
    cone.setAttribute('rotation', '180 0 0');
    cone.setAttribute('animation', 'property: position; from: 0 0 0; to: 0 ' + (lift * 0.25) + ' 0; dir: alternate; loop: true; dur: 600; easing: easeInOutSine');
    var ring = doc.createElement('a-entity');
    ring.setAttribute('geometry', 'primitive: ring; radiusInner: ' + (span * 0.6) + '; radiusOuter: ' + (span * 0.6 + Math.max(span * 0.08, 0.03)));
    ring.setAttribute('material', 'color: ' + REVEAL_COLOR + '; shader: flat; side: double');
    ring.setAttribute('rotation', '-90 0 0');
    ring.setAttribute('position', '0 ' + (box.min.y - box.max.y - lift + 0.01) + ' 0');
    marker.appendChild(cone);
    marker.appendChild(ring);
    scene.appendChild(marker);
    revealState.marker = marker;
    revealState.target = target;
    // Babia shows an element's legend on mouseenter: the same label a pointer would.
    if (target.dispatchEvent && root.CustomEvent) { target.dispatchEvent(new root.CustomEvent('mouseenter')); }
    revealState.timer = root.setTimeout?.(clearRevealMarker, REVEAL_DURATION_MS) || null;
    return true;
  }

  /** Marks the file in the analysis on show; false when the scene does not show it. */
  function revealInScene(path) {
    var relativePath = normalizeRevealPath(path);
    if (!relativePath) { return false; }
    var mode = revealMode();
    var target = mode === 'dependency-graph' ? dependencyElementForPath(relativePath)
      : mode === 'single' ? chartElementForPath(relativePath)
        : null;
    return !!target && showRevealMarker(target);
  }

  function registerSceneReveal(attempt) {
    if (revealState.registered || !revealIsLocalPage()) { return; }
    var client = root.CodeXRCollaborationRuntime?.getClient?.(root);
    if (typeof client?.onMessage !== 'function') {
      // The collaboration client can load after this runtime; a page with no
      // room (an offline export) simply never gets one.
      if (attempt < 60) { root.setTimeout?.(function () { registerSceneReveal(attempt + 1); }, attempt < 30 ? 100 : 1000)?.unref?.(); }
      return;
    }
    revealState.registered = true;
    client.onMessage(REVEAL_MESSAGE, function (message) {
      revealInScene(message?.payload?.path);
    });
  }

  root.CodeXRSceneReveal = {
    reveal: revealInScene,
    clear: clearRevealMarker,
    __testing: {
      chartElementForPath: chartElementForPath,
      normalizeRevealPath: normalizeRevealPath,
      reset: function () { clearRevealMarker(); revealState.registered = false; }
    }
  };
  if (root.document) { registerSceneReveal(0); }
