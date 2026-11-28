// == agentFlowRuntime.js | modeLifecycle (assembled per manifest.json; see COMPONENTS.md) ==
  // Registration with the analysis-mode switcher, the controller and the room;
  // the mounted root; the render budget; the public API.

  var AGENT_FLOW_UNAVAILABLE_REASON = 'Agent flow needs a folder or project analysis.';

  function parkOriginal() {
    var surface = root.CodeXRAnalysisSurfaceRuntime;
    if (surface?.setNormalVisible) {
      surface.setNormalVisible(false);
      return;
    }
    var normal = doc()?.getElementById?.('codexrNormalAnalysisRoot');
    if (normal) {
      state.originalRoots = [normal];
      setNodeVisible(normal, false);
    }
  }

  function restoreOriginal() {
    var surface = root.CodeXRAnalysisSurfaceRuntime;
    var backToSingle = root.CodeXRAnalysisModeRuntime?.getState?.().mode === 'single';
    if (surface?.setNormalVisible) {
      if (backToSingle) { surface.setNormalVisible(true); }
      return;
    }
    if (backToSingle) { state.originalRoots.forEach(function (element) { setNodeVisible(element, true); }); }
    state.originalRoots = [];
  }

  /** The mode's root at the table anchor, mounted on the analysis surface. */
  function ensureRoot() {
    if (!doc()) { return null; }
    if (refs.root && refs.root.isConnected === false) {
      // The selection sweep removed it: the scene inside went with it.
      disposeCurrentView();
      refs.root = null;
      refs.hint = null;
    }
    if (!refs.root) {
      refs.root = entity('a-entity', {
        id: ROOT_ID,
        position: ROOT_POSITION.x + ' ' + ROOT_POSITION.y + ' ' + ROOT_POSITION.z,
        'data-codexr-analysis-root': 'true',
        'data-codexr-analysis-mode': MODE
      });
      refs.root.setAttribute(COMPONENT, '');
      refs.hint = buildHint(refs.root);
      setNodeVisible(refs.hint.el, false);
    }
    var surface = root.CodeXRAnalysisSurfaceRuntime;
    if (surface?.mountRoot) {
      surface.mountRoot(MODE, refs.root);
    } else if (refs.root.parentNode !== sceneEl()) {
      sceneEl()?.appendChild(refs.root);
    }
    setNodeVisible(refs.root, true);
    return refs.root;
  }

  function removeRoot() {
    disposeCurrentView();
    refs.root?.parentNode?.removeChild?.(refs.root);
    refs.root = null;
    refs.hint = null;
  }

  function bindRenderBudget() {
    if (state.unsubscribeBudget) { return; }
    var budget = root.CodeXRRenderBudgetRuntime;
    if (!budget?.subscribe) { return; }
    // 'static' is both the low-frame-rate verdict and how prefers-reduced-motion
    // arrives: no hops, no pulses, the probe jumps (the logo's rule).
    state.unsubscribeBudget = budget.subscribe(function (snapshot) {
      var motion = !snapshot || snapshot.quality !== 'static';
      if (motion === state.motion) { return; }
      state.motion = motion;
      if (!motion && view?.cityState) {
        clearEffects(view);
        renderAt(view.cityState.stepIndex, { animate: false });
      }
    });
  }

  function activate(activation) {
    if (activation?.token?.isCurrent && !activation.token.isCurrent()) { return false; }
    state.active = true;
    state.viewGeneration += 1;
    parkOriginal();
    if (!ensureRoot()) { return false; }
    bindRenderBudget();
    buildPanel();
    if (!state.sources.length && !client()?.isOfflineExport?.()) { requestSources(); }
    if (state.dataset && (!state.entity || state.entity.status === 'ready')) {
      ensureView();
    }
    if (!state.entity) {
      if (!view) { showIdle(); }
      return true;
    }
    return syncEntity({ signal: activation?.signal, rethrow: true });
  }

  function deactivate() {
    state.active = false;
    state.viewGeneration += 1;
    state.loadGeneration += 1;
    state.playback?.pause();
    removeRoot();
    restoreOriginal();
    renderPanel();
  }

  function captureState() {
    var playback = state.playback?.getState() || {};
    return {
      revision: state.dataset?.revision || 0,
      index: playback.index,
      speed: playback.speed,
      followLive: playback.followLive,
      toggles: Object.assign({}, state.toggles)
    };
  }

  function restoreState(activation) {
    var saved = activation?.savedState;
    if (!saved || typeof saved !== 'object') { return; }
    if (saved.toggles) { Object.keys(state.toggles).forEach(function (key) { state.toggles[key] = !!saved.toggles[key]; }); }
    state.playback?.setSpeed(saved.speed || 1);
    state.playback?.setFollowLive(saved.followLive !== false);
    if (state.dataset && state.dataset.revision === saved.revision) { state.playback?.reset(saved.index); }
  }

  function selectMode() {
    if (state.availability !== 'enabled') {
      setStatus(state.unavailableReason || AGENT_FLOW_UNAVAILABLE_REASON, true);
      return;
    }
    if (!client()?.isOfflineExport?.()) {
      client()?.sendMessage?.('analysis-mode-activate', { mode: MODE });
    }
    void root.CodeXRAnalysisModeRuntime?.changeAnalysis?.(MODE, {
      reason: 'local-agent-flow-mode-option',
      panelViewId: MODE
    });
  }

  function registerModeOption() {
    state.unregisterMode?.();
    state.unregisterMode = root.CodeXRAnalysisModeRuntime?.registerModeOption?.({
      id: MODE,
      label: 'Agent flow',
      color: ACCENT,
      disabled: state.availability !== 'enabled',
      disabledReason: state.unavailableReason || AGENT_FLOW_UNAVAILABLE_REASON,
      onSelect: selectMode
    }) || null;
  }

  async function configureAvailability() {
    try {
      var info = await client()?.getSessionInfoAsync?.();
      state.availability = info?.capabilities?.agentFlow === true ? 'enabled' : 'disabled';
      state.unavailableReason = info?.capabilities?.agentFlowReason || AGENT_FLOW_UNAVAILABLE_REASON;
    } catch {
      state.availability = 'disabled';
      state.unavailableReason = 'Agent flow availability could not be checked.';
    }
    registerModeOption();
  }

  function registerLifecycle() {
    if (state.unregisterLifecycle || !root.CodeXRAnalysisModeRuntime?.register) { return !!state.unregisterLifecycle; }
    state.unregisterLifecycle = root.CodeXRAnalysisModeRuntime.register(MODE, {
      mappingContextId: null,
      activate: activate,
      deactivate: deactivate,
      captureState: captureState,
      restoreState: restoreState,
      resolveControllerView: function () { return MODE; }
    }) || null;
    return !!state.unregisterLifecycle;
  }

  function registerCollaboration() {
    var connection = client();
    if (!connection || state.collaborationRegistered) { return !!state.collaborationRegistered; }
    state.collaborationRegistered = true;
    state.disposables.push(connection.onMessage?.('agent-flow-sources', handleSources));
    state.disposables.push(connection.onMessage?.('agent-flow-error', handleError));
    connection.registerEntityRuntime?.({
      entityKind: ENTITY_KIND,
      entityId: ENTITY_ID,
      applySharedState: applySharedState,
      publishInitialSharedState: function () {},
      handleCollaborationMessage: function (message) {
        if (message?.type === 'entity-removed') {
          void applySharedState({ status: 'idle', revision: 0, datasetUrl: null, sourceId: null, live: false });
        }
      }
    });
    return true;
  }

  function mount(attempt) {
    var ready = [registerLifecycle(), buildPanel(), registerCollaboration()].every(Boolean);
    if (!state.unregisterMode && root.CodeXRAnalysisModeRuntime?.registerModeOption) { registerModeOption(); }
    if (ready && state.unregisterMode) { return; }
    if (attempt < 30) {
      root.setTimeout?.(function () { mount(attempt + 1); }, 100);
    } else {
      root.console?.warn?.('[CodeXR][AgentFlow] Gave up mounting after 3 s: '
        + [!state.unregisterLifecycle && 'mode lifecycle', !refs.panel && 'controller panel',
          !state.collaborationRegistered && 'collaboration client', !state.unregisterMode && 'mode option']
          .filter(Boolean).join(', ') + ' not available.');
    }
  }

  function createRuntimePlayback() {
    return createPlayback({
      getCount: function () { return view ? view.timeline.count : 0; },
      getTurnStarts: function () { return view ? view.timeline.turnStarts : []; },
      onPosition: function (index, info) { renderAt(index, info); },
      onChange: function () { renderPanel(); }
    });
  }

  function autoInit() {
    if (state.initialized || !doc()) { return; }
    state.initialized = true;
    state.playback = createRuntimePlayback();
    registerComponent();
    mount(0);
    void configureAvailability();
  }

  function debugSnapshot() {
    var playback = state.playback?.getState() || {};
    return {
      active: state.active,
      availability: state.availability,
      entity: state.entity ? Object.assign({}, state.entity) : null,
      revision: state.dataset?.revision || 0,
      sessionId: state.dataset?.session?.id || null,
      live: !!state.dataset?.session?.live,
      files: view ? view.files.length : 0,
      buildings: view ? view.city.state.buildings.count : 0,
      visibleBuildings: view ? Array.prototype.filter.call(view.heights, function (h) { return h > 0.0005; }).length : 0,
      districts: state.dataset ? state.dataset.districts.length : 0,
      steps: view ? view.timeline.count : 0,
      turns: view ? view.timeline.turns.length : 0,
      stepIndex: playback.index,
      playing: !!playback.playing,
      speed: playback.speed,
      followLive: playback.followLive,
      toggles: Object.assign({}, state.toggles),
      motion: state.motion,
      actors: view ? view.timeline.actors.length : 0,
      workers: view ? (view.workers || []).filter(function (worker) { return worker?.group.visible; }).map(function (worker) {
        var info = view.workerInfo?.[worker.actor];
        return { actor: worker.actor, label: worker.lane.label, active: !!info?.active, kind: info?.active ? info.step.kind : null, stepIndex: info ? info.stepIndex : -1 };
      }) : [],
      moving: view ? (view.workers || []).some(function (worker) { return !!worker?.hop; }) || view.city.isAnimating() : false,
      scaffolds: view ? view.city.scaffoldIndexes().length : 0,
      hazards: view ? { blind: view.city.hazardIndexes('blind').length, unread: view.city.hazardIndexes('unread').length, warning: view.city.hazardIndexes('warning').length } : null,
      tower: view?.tower ? view.tower.mode : 'idle',
      props: view ? (view.workers || []).reduce(function (sum, worker) { return sum + (worker?.props.length || 0); }, 0) : 0,
      trailPoints: view?.trail ? view.trail.points || 0 : 0,
      activeEffects: view ? view.effects.length : 0,
      turnRings: view ? view.rings.mesh.count : 0,
      deltaCaps: view ? view.caps.mesh.count : 0,
      unreadDependents: view ? view.unreadCount || 0 : 0,
      timelineTicks: view?.lectern ? view.lectern.meshes.reduce(function (sum, mesh) { return sum + mesh.count; }, 0) : 0,
      hint: refs.hint?.el?.object3D?.visible ? refs.hint.title.getAttribute('value') : '',
      sources: state.sources.length,
      status: state.status
    };
  }

  function playbackCall(name) {
    return function () {
      var playback = state.playback;
      return playback ? playback[name].apply(null, arguments) : undefined;
    };
  }

  root.CodeXRAgentFlowRuntime = {
    autoInit: autoInit,
    applySharedState: applySharedState,
    applyDataset: applyDataset,
    requestSources: requestSources,
    openSource: openSource,
    closeSession: closeSession,
    play: playbackCall('play'),
    pause: playbackCall('pause'),
    togglePlay: playbackCall('toggle'),
    seek: playbackCall('seek'),
    stepForward: playbackCall('stepForward'),
    stepBack: playbackCall('stepBack'),
    nextTurn: playbackCall('nextTurn'),
    previousTurn: playbackCall('previousTurn'),
    setSpeed: playbackCall('setSpeed'),
    setFollowLive: playbackCall('setFollowLive'),
    setToggle: setToggle,
    getState: debugSnapshot,
    __testing: {
      MODE: MODE,
      COLORS: COLORS,
      ROOT_POSITION: ROOT_POSITION,
      CITY_COMPONENT: CITY_COMPONENT,
      state: state,
      normalizeDataset: normalizeDataset,
      buildTimeline: buildTimeline,
      workersAt: workersAt,
      actorColor: actorColor,
      ACTOR_PALETTE: ACTOR_PALETTE,
      plateHeightOf: plateHeightOf,
      stateAt: stateAt,
      heightForLoc: heightForLoc,
      isOutsideFile: isOutsideFile,
      layoutSignature: layoutSignature,
      planLiveUpdate: planLiveUpdate,
      metricsModel: metricsModel,
      stepLine: stepLine,
      stepVerb: stepVerb,
      relativeTime: relativeTime,
      sourcesPage: sourcesPage,
      formatSigned: formatSigned,
      createPlayback: createPlayback,
      kindColor: kindColor,
      turnColor: turnColor,
      heatCategory: heatCategory,
      heatColor: heatColor,
      replayColor: replayColor,
      deltaCapStyle: deltaCapStyle,
      districtTone: districtTone,
      mixHex: mixHex,
      normalizeEntity: normalizeEntity,
      isAgentFlowActiveOrActivating: isAgentFlowActiveOrActivating,
      activate: activate,
      deactivate: deactivate,
      selectMode: selectMode,
      getView: function () { return view; }
    },
    destroy: function () {
      state.playback?.dispose();
      state.disposables.forEach(function (dispose) { if (typeof dispose === 'function') { dispose(); } });
      state.disposables = [];
      state.unsubscribeBudget?.();
      state.unsubscribeBudget = null;
      state.unregisterMode?.();
      state.unregisterPanel?.();
      state.unregisterLifecycle?.();
      state.unregisterMode = null;
      state.unregisterPanel = null;
      state.unregisterLifecycle = null;
      state.collaborationRegistered = false;
      removeRoot();
      refs.panel = null;
      state.initialized = false;
    }
  };

  if (doc()) {
    if (doc().readyState === 'loading') { doc().addEventListener('DOMContentLoaded', autoInit, { once: true }); }
    else { autoInit(); }
  }
})(typeof window !== 'undefined' ? window : this);
