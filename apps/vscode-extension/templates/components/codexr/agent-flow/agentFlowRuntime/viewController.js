// == agentFlowRuntime.js | viewController (assembled per manifest.json; see COMPONENTS.md) ==
  // Builds and tears down the scene for one dataset, draws the state at a
  // playhead (renderAt) and drives the per-frame animation from one A-Frame
  // component on the mounted root.

  var view = null;

  function registerComponent() {
    registerCityComponent();
    var aframe = root.AFRAME;
    if (!aframe?.registerComponent || aframe.components?.[COMPONENT]) { return; }
    aframe.registerComponent(COMPONENT, {
      tick: function (time, delta) { tickView(time, delta); }
    });
  }

  function hopDuration() {
    var speed = state.playback?.getState().speed || 1;
    return BASE_HOP_MS / speed;
  }

  function createView(rootEl, dataset) {
    var T = three();
    var group = new T.Group();
    group.name = 'agentFlowCity';
    rootEl.setObject3D('agentFlowCity', group);
    var v = {
      rootEl: rootEl, group: group, dataset: dataset, timeline: buildTimeline(dataset),
      files: dataset.files, disposables: [], effects: [], hoverFile: -1, workers: [],
      outside: dataset.files.map(function (file) { return isOutsideFile(file, dataset.districts); })
    };
    mountCity(v);
    buildTurnRings(v);
    buildDeltaCaps(v);
    buildGhosts(v);
    buildTestTower(v);
    buildTrail(v);
    buildFloatingLabel(v);
    buildTimelineLectern(v);
    buildTimelineGraphics(v);
    return v;
  }

  function removeNode(node) { node?.parentNode?.removeChild?.(node); }

  function destroyView(v) {
    if (!v) { return; }
    clearEffects(v);
    destroyWorkers(v);
    replaceArcTubes(v, 'blastLines', [], 0);
    replaceArcLines(v, 'pathLines', []);
    updateUnreadHalos(v, []);
    clearTimelineGraphics(v);
    v.city?.dispose();
    [v.cityEl, v.label?.el, v.lectern?.el, v.pillarLabel, v.tooltip?.root, v.tooltip?.connectorRoot].forEach(removeNode);
    v.rootEl.removeObject3D?.('agentFlowCity');
    disposeTracked(v);
  }

  function disposeCurrentView() {
    destroyView(view);
    view = null;
  }

  /** Same dataset, more steps (a live append on an unchanged layout). */
  function refreshViewDataset(dataset) {
    view.dataset = dataset;
    view.files = dataset.files;
    view.timeline = buildTimeline(dataset);
    view.outside = dataset.files.map(function (file) { return isOutsideFile(file, dataset.districts); });
    // New actors may have joined: their workers are created on demand.
    destroyWorkers(view);
    replaceArcLines(view, 'pathLines', []);
    buildTimelineGraphics(view);
  }

  function updateOverlays(v, cityState) {
    updateTurnRings(v, cityState);
    updateDeltaCaps(v, cityState);
    updateGhosts(v, cityState);
    updateBlastRadius(v, cityState);
    updateAgentPath(v, cityState);
    syncTrailVisibility(v);
  }

  function updatePillarIdle(v, index) {
    var lastRun = null;
    for (var i = Math.min(index, v.timeline.count - 1); i >= 0 && !lastRun; i -= 1) {
      if (v.timeline.steps[i].kind === 'execute') { lastRun = v.timeline.steps[i]; }
    }
    v.pillar.lastColor = lastRun ? (lastRun.failed ? COLORS.executeFailed : COLORS.executeOk) : null;
    if (!v.pillar.flash) {
      v.pillar.material.emissive.set(v.pillar.lastColor || '#0f766e');
      v.pillar.material.emissiveIntensity = lastRun ? 0.35 : 0.22;
      v.pillar.cap.material.color.set(v.pillar.lastColor || v.pillar.idleCap);
    }
  }

  /** Re-applies everything that does not move (a toggle changed). */
  function refreshStatic() {
    if (!view?.cityState) { return; }
    applyColors(view, view.cityState);
    updateOverlays(view, view.cityState);
    syncSite(view, view.cityState, workersAt(view.timeline, view.cityState.stepIndex));
    refreshTrail(view);
  }

  /** Draws the city at the playhead; a forward single step animates. */
  function renderAt(index, options) {
    if (!view) { return; }
    var v = view;
    var cityState = stateAt(v.dataset, index, v.timeline);
    v.cityState = cityState;
    var step = cityState.current;
    var animate = !!options?.animate && state.motion && !!step;
    var workers = workersAt(v.timeline, cityState.stepIndex);
    v.workerInfo = workers;
    if (animate) {
      var hopMs = hopDuration();
      state.playback?.hopStarted();
      animateWorkers(v, cityState.stepIndex, workers, step, hopMs, function () {
        try {
          if (view === v && v.cityState === cityState) {
            applyHeights(v, cityState, true, hopMs * 2.4);
            applyColors(v, cityState);
            updateOverlays(v, cityState);
            syncSite(v, cityState, workers);
            updateFloatingLabel(v, cityState);
          }
        } finally {
          // Never leave the transport waiting on a hop that will not finish.
          state.playback?.hopFinished();
        }
      });
      updateFloatingLabel(v, cityState);
    } else {
      applyHeights(v, cityState, false);
      placeWorkersAt(v, cityState.stepIndex, workers);
      applyColors(v, cityState);
      updateOverlays(v, cityState);
      syncSite(v, cityState, workers);
      updateFloatingLabel(v, cityState);
      state.playback?.hopFinished();
    }
    updatePillarIdle(v, cityState.stepIndex);
    updateTimelineLectern(v, cityState);
    renderPanel();
  }

  function tickView(time, delta) {
    var v = view;
    if (!v || !state.active) { return; }
    // Clamped: a tab that slept must not fast-forward every animation at once.
    var dt = Math.min(64, Math.max(0, Number(delta) || 16));
    var camera = v.rootEl.sceneEl?.camera;
    var heightsMoving = v.city.tick(dt, time || 0);
    if (heightsMoving && v.cityState) {
      updateTurnRings(v, v.cityState);
      updateDeltaCaps(v, v.cityState);
    }
    tickWorkers(v, dt, time || 0, camera);
    tickEffects(v, dt);
    tickPillar(v, dt);
    tickTower(v, dt);
    if (v.label?.el?.object3D?.visible) {
      faceYaw(v.label.el, camera);
      if (heightsMoving && v.cityState) { updateFloatingLabel(v, v.cityState); }
    }
    if (v.tooltip?.root?.object3D?.visible) { faceYaw(v.tooltip.root, camera); }
    pollHover(v, time || 0);
  }
