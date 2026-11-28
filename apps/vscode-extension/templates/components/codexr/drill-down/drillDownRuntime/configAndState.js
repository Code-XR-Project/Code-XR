// == drillDownRuntime.js | configAndState (assembled per manifest.json; see COMPONENTS.md) ==
// Drill-down (#333): select a building (file) or a district (folder) of the
// chart on the table, choose Analyze, and the table switches in place to the
// analysis of that target; a breadcrumb bar with Back, Forward and Home climbs
// back up. The server does the analysis (src/core/drilldown/, bridge
// drillDownBridge.ts) and publishes the `drill-down` entity; this runtime
// draws the drilled chart, the inspector card, the bar and the loading state.
// Entity contract: src/core/drilldown/drillDownModels.ts (DrillDownEntity).
(function registerCodeXRDrillDownRuntime(root) {
  'use strict';

  var MODE = 'drill-down';
  // The controller shows the analysis mapping view while drilled.
  var CONTROLLER_VIEW = 'single.mapping';
  var ENTITY_KIND = 'drill-down';
  var ENTITY_ID = 'main';
  var RAYCAST_CLASS = 'babiaxraycasterclass';
  var ACCENT = '#0ea5e9';
  // Every id the drilled view owns: removing the root removes them all,
  // producer included, so a chart left behind can never repaint itself.
  var ROOT_ID = 'codexrDrillDownRoot';
  var DATA_ID = 'codexrDrillDownData';
  var TREE_ID = 'codexrDrillDownTree';
  var CHART_ID = 'codexrDrillDownChart';
  // Boats ids its buildings and districts after the tree uids; the hidden
  // classic chart has the same paths, so the drilled tree is namespaced.
  var UID_NAMESPACE = 'drill-down';
  // The two charts a building can be picked from.
  var PICKABLE_CHART_IDS = ['chart', CHART_ID];
  // Modes the bar and the inspector live in.
  var NAVIGABLE_MODES = ['single', MODE];
  // The bar hangs just in front of the table's front edge (table depth 4.118
  // around z = -18), its top under the tabletop (y = 1) so it never hides the
  // chart from the rig (eye at y = 1.75, z = -10.75); it leans back a little
  // toward the viewer.
  var BAR = { x: 0, y: 0.62, z: -15.6, tilt: -20, width: 5.4, height: 0.72, maxCrumbsWidth: 3.4 };
  // `row`: height added per metric or note line.
  var CARD = { width: 2.2, height: 0.85, row: 0.17, lift: 0.55 };
  // Glyph advance of a button label (metres).
  var LABEL_GLYPH = 0.068;
  // The loading card floats over the middle of the table.
  var LOADING = { x: 0, y: 2.05, z: -17.6, width: 3.4, height: 0.62 };
  var COLORS = {
    panel: '#0f172a',
    button: '#1e3a5f',
    buttonActive: '#0369a1',
    disabled: '#334155',
    home: '#0e7490',
    analyze: '#0369a1',
    editor: '#0f766e',
    close: '#475569',
    text: '#e2e8f0',
    muted: '#94a3b8',
    current: '#f8fafc',
    error: '#fca5a5',
    loading: '#7dd3fc'
  };

  var state = {
    initialized: false,
    active: false,
    entity: null,
    viewKey: '',
    viewRevision: 0,
    buildGeneration: 0,
    lastError: '',
    errorAt: 0,
    loadingTimer: null,
    stateRequested: false,
    collaborationRegistered: false,
    unregisterLifecycle: null,
    disposables: [],
    sceneClickBound: false,
    mappingBound: false,
    // The mapping context of the schema the controller was switched to ('' = its own).
    schemaKey: '',
    // What the controller's scope plate shows, to skip unchanged updates.
    scopeKey: ''
  };
  var refs = {};

  function doc() { return root.document || null; }
  function client() { return root.CodeXRCollaborationRuntime?.getClient?.(root) || null; }
  function sceneEl() { return doc()?.querySelector?.('a-scene') || null; }
  function now() { return Date.now(); }

  function entity(tag, attributes) {
    var el = doc().createElement(tag);
    Object.keys(attributes || {}).forEach(function (key) { el.setAttribute(key, attributes[key]); });
    return el;
  }

  function text(value, position, width, color, align, wrapCount) {
    return entity('a-text', {
      value: value || '', position: position || '0 0 0.02', width: width || 3,
      color: color || COLORS.text, align: align || 'center', baseline: 'center',
      'wrap-count': wrapCount || 40
    });
  }

  function setNodeVisible(node, visible) {
    if (!node) { return; }
    if (node.object3D) { node.object3D.visible = !!visible; }
    node.setAttribute?.('visible', visible ? 'true' : 'false');
  }

  function setText(node, value, color) {
    if (!node) { return; }
    if (value != null) { node.setAttribute('value', String(value)); }
    if (color) { node.setAttribute('color', color); }
  }

  function compact(value, max) {
    var textValue = String(value == null ? '' : value);
    return textValue.length > max ? textValue.slice(0, Math.max(1, max - 3)) + '...' : textValue;
  }

  /**
   * A flat button: a plane carrying the raycaster class and a label. Disabled
   * buttons keep their place (the bar never reflows under the pointer) but
   * lose the class, so the laser and the mouse pass through them.
   */
  function button(label, position, width, onClick, color, options) {
    var settings = options || {};
    var height = settings.height || 0.3;
    var el = entity('a-plane', {
      position: position, width: width, height: height,
      material: 'color: ' + (color || COLORS.button) + '; opacity: 0.97; shader: flat',
      class: RAYCAST_CLASS + ' codexr-drill-down-button', 'data-codexr-interactive': 'true'
    });
    // A-Frame text advances width / wrap-count per glyph: a fixed glyph size
    // (LABEL_GLYPH) keeps every label the same size whatever the plate width.
    var labelWidth = width * 0.92;
    var labelEl = text(label, '0 0 0.012', labelWidth, '#ffffff', 'center',
      Math.max(2, Math.round(labelWidth / (settings.glyph || LABEL_GLYPH))));
    el.appendChild(labelEl);
    var handle = { el: el, label: labelEl, enabled: true, color: color || COLORS.button };
    el.addEventListener('click', function (event) {
      event?.stopPropagation?.();
      if (handle.enabled) { onClick(event); }
    });
    return handle;
  }

  function setButtonEnabled(handle, enabled) {
    if (!handle) { return; }
    handle.enabled = !!enabled;
    handle.el.setAttribute('material', 'color', enabled ? handle.color : COLORS.disabled);
    if (enabled) {
      handle.el.classList?.add?.(RAYCAST_CLASS);
      handle.el.setAttribute('data-codexr-interactive', 'true');
    } else {
      handle.el.classList?.remove?.(RAYCAST_CLASS);
      handle.el.setAttribute('data-codexr-interactive', 'false');
    }
    setText(handle.label, null, enabled ? '#ffffff' : COLORS.muted);
  }

  function currentMode() {
    var modeState = root.CodeXRAnalysisModeRuntime?.getState?.();
    if (modeState?.transitioning && modeState.pendingTransitionMode) { return modeState.pendingTransitionMode; }
    return modeState?.mode || 'single';
  }

  function isNavigableMode(mode) {
    return NAVIGABLE_MODES.indexOf(mode || currentMode()) !== -1;
  }

  function send(type, payload) {
    var connection = client();
    if (!connection?.sendMessage || connection.isOfflineExport?.()) {
      showError('Drill-down needs the live Code-XR session (this page is an exported copy).');
      return false;
    }
    var sent = connection.sendMessage(type, payload || {});
    if (sent === false) {
      showError('Not connected to the Code-XR server yet. Try again in a moment.');
      return false;
    }
    return true;
  }
