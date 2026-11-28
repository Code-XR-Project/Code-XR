// == agentFlowRuntime.js | configAndState (assembled per manifest.json; see COMPONENTS.md) ==
// Agent Flow: the fifth analysis type. Replays (or tails) an AI coding agent
// session on the analysis table: the analysed folder drawn as a city of files,
// a probe that hops to every file the agent reads, searches, edits or runs,
// and a timeline along the table's front edge. The dataset contract is
// src/core/agent-flow/agentFlowModels.ts (AgentFlowDataset / AgentFlowEntity).
(function registerCodeXRAgentFlowRuntime(root) {
  'use strict';

  var MODE = 'agent-flow';
  var ENTITY_KIND = 'agent-flow';
  var ENTITY_ID = 'main';
  var COMPONENT = 'codexr-agent-flow';
  var RAYCAST_CLASS = 'babiaxraycasterclass';
  var ACCENT = '#10b981';
  // Same anchor as the dependency graph root ('0 1.02 -18'), lowered onto the
  // tabletop: the table's top slab ends at y = 0.92 and its glass sits about
  // 1.5 cm above it, so the city stands ON the table instead of floating.
  var ROOT_ID = 'codexrAgentFlowRoot';
  var ROOT_POSITION = { x: 0, y: 0.935, z: -18 };
  // The city box (AGENT_FLOW_TABLE in agentFlowModels.ts) and the visible table.
  var CITY = { width: 4.7, depth: 2.35, maxHeight: 0.9, minHeight: 0.04 };
  var SURFACE = { width: 6.514, depth: 4.118 };
  // The timeline is a lectern along the front edge (the side facing the
  // viewer, +z), tilted toward the user: flat on the table it would be read at
  // a grazing angle from where people stand.
  var TIMELINE = { width: 4.4, height: 0.5, x: 0, y: 0.13, z: 1.66, tilt: -58 };
  // Front-left corner: commands are about the whole project, not one file.
  var CONSOLE_PILLAR = { x: -2.78, z: 1.2, height: 0.36, radius: 0.07 };
  var TRAIL_HOPS = 24;
  var HOP_SAMPLES = 10;
  var BASE_STEP_MS = 900;
  var BASE_HOP_MS = 400;
  var SPEED_PRESETS = [0.5, 1, 2, 4];
  var SOURCE_PAGE_SIZE = 4;

  // Visual verbs (docs/agent-flow/research.md section 3.1): cool observation,
  // warm mutation, low saliency for steps without a code location.
  var COLORS = {
    read: '#22d3ee',
    search: '#a78bfa',
    write: '#fb923c',
    created: '#4ade80',
    executeOk: '#34d399',
    executeFailed: '#f43f5e',
    failed: '#f43f5e',
    unread: '#f59e0b',
    probe: '#e0f2fe',
    think: '#cbd5e1',
    base: '#526177',
    baseDark: '#3b4759',
    outside: '#5f5b7a',
    deltaUp: '#f87171',
    deltaDown: '#60a5fa',
    heatRead: '#3b82f6',
    heatSearch: '#8b5cf6',
    playhead: '#f8fafc',
    text: '#e2e8f0',
    muted: '#94a3b8',
    panel: '#0f172a'
  };
  // District plates: slate tones that darken one step per folder level.
  var DISTRICT_TONES = ['#2c3b52', '#283649', '#243142', '#202c3b', '#1c2734', '#18222d'];
  // Workers: the main agent is emerald (ACCENT); subagents cycle these.
  var ACTOR_PALETTE = ['#38bdf8', '#f472b6', '#facc15', '#a78bfa', '#fb923c'];
  // Live construction effects at once (scaffolds, cones, beacons, signs).
  var EFFECT_CAP = 40;
  var WORKER_CAP = 12;
  // Turn rings: a sequential sky -> emerald -> amber ramp (first turn coolest).
  var TURN_RAMP = ['#38bdf8', '#10b981', '#facc15'];

  var state = {
    initialized: false,
    active: false,
    availability: 'loading',
    unavailableReason: '',
    entity: null,
    dataset: null,
    timeline: null,
    loadGeneration: 0,
    viewGeneration: 0,
    loadError: null,
    sources: [],
    activeSourceId: null,
    sourcePage: 0,
    sourcesRequested: false,
    toggles: { trail: true, heat: false, blast: false, rings: false },
    motion: true,
    status: '',
    statusError: false,
    disposables: [],
    unregisterMode: null,
    unregisterLifecycle: null,
    unregisterPanel: null,
    unsubscribeBudget: null,
    originalRoots: [],
    playback: null
  };
  var refs = {};

  function doc() { return root.document || null; }
  function three() { return root.AFRAME?.THREE || root.THREE || null; }
  function client() { return root.CodeXRCollaborationRuntime?.getClient?.(root) || null; }
  function sceneEl() { return doc()?.querySelector?.('a-scene') || null; }
  function now() { return root.performance?.now ? root.performance.now() : Date.now(); }

  function entity(tag, attributes) {
    var el = doc().createElement(tag);
    Object.keys(attributes || {}).forEach(function (key) { el.setAttribute(key, attributes[key]); });
    return el;
  }

  function text(value, position, width, color, align, wrapCount) {
    return entity('a-text', {
      value: value || '', position: position || '0 0 0.02', width: width || 5,
      color: color || '#ffffff', align: align || 'center', baseline: 'center',
      'wrap-count': wrapCount || 42
    });
  }

  function setNodeVisible(node, visible) {
    if (!node) { return; }
    if (node.object3D) { node.object3D.visible = !!visible; }
    node.setAttribute?.('visible', visible ? 'true' : 'false');
  }

  function setText(node, value, color) {
    if (!node) { return; }
    node.setAttribute('value', value == null ? '' : String(value));
    if (color) { node.setAttribute('color', color); }
  }

  function compact(value, max) {
    var textValue = String(value == null ? '' : value);
    return textValue.length > max ? textValue.slice(0, Math.max(0, max - 3)) + '...' : textValue;
  }

  function setStatus(message, isError) {
    state.status = message || '';
    state.statusError = !!isError;
    if (refs.panelStatus) {
      setText(refs.panelStatus, state.status, isError ? '#fca5a5' : '#fde68a');
    }
  }
