// == dependencyGraphRuntime.js | viewLifecycle (assembled per manifest.json; see COMPONENTS.md) ==
  function renderCurrentGraphIfReady() {
    if (!state.active || !state.dataset || state.snapshot?.status !== 'ready') { return; }
    var component = refs.graph?.components?.[COMPONENT];
    if (!isGraphComponentReady(component)) { return; }
    component.setGraph(filteredDataset(), state.snapshot);
  }

  // A-Frame exposes a component before running its init; a setGraph then made
  // a worker that init overwrote (DEPGRAPH-6). Wait for `initialized`.
  function isGraphComponentReady(component) {
    return Boolean(component?.setGraph) && component.initialized !== false;
  }

  function renderGraphWhenReady(graph, snapshot, viewGeneration, attempt) {
    if (!state.active || state.snapshot !== snapshot || state.viewGeneration !== viewGeneration) { return; }
    if (!refs.graph?.isConnected) {
      scheduleGraphRenderRetry(graph, snapshot, viewGeneration, attempt);
      return;
    }
    var component = refs.graph.components?.[COMPONENT];
    if (isGraphComponentReady(component)) {
      component.setGraph(graph, snapshot);
      return;
    }
    scheduleGraphRenderRetry(graph, snapshot, viewGeneration, attempt);
  }

  function scheduleGraphRenderRetry(graph, snapshot, viewGeneration, attempt) {
    if (attempt >= 120) {
      setStatus('Dependency graph component could not be initialized.', true);
      return;
    }
    var timer = setTimeout(function () {
      state.retryTimers.delete(timer);
      renderGraphWhenReady(graph, snapshot, viewGeneration, attempt + 1);
    }, 50);
    state.retryTimers.add(timer);
  }

  function resetView() {
    if (state.transitionLocked) { return; }
    refs.graph?.components?.[COMPONENT]?.resetView?.();
    var rig = doc()?.getElementById('rig');
    // Eye height lives on the rig itself — never on the camera.
    rig?.setAttribute?.('position', '0.07 1.75 -10.75');
    rig?.setAttribute?.('rotation', '0 0 0');
    setStatus('View reset.', false);
  }

  function withSnapshotDefaults(snapshot) {
    return snapshot ? Object.assign({
      edgeEncoding: 'relation-type',
      flowSize: FLOW_DEFAULTS.flowSize,
      flowSpeed: FLOW_DEFAULTS.flowSpeed,
      scope: { kind: 'directory', relativePath: '' }
    }, snapshot) : snapshot;
  }

  // A dataset response is still wanted only while no newer load started, the
  // view that asked for it is still the current one, and the graph is active.
  function isLoadCurrent(loadGeneration, viewGeneration) {
    return loadGeneration === state.datasetLoadGeneration
      && viewGeneration === state.viewGeneration
      && state.active;
  }

  // A new project dataset makes every cached file dataset stale (DEPGRAPH-8),
  // except the one the same snapshot just delivered.
  function setProjectDataset(dataset, keepFileKey) {
    if (state.projectDataset && state.projectDataset !== dataset
        && Number(state.projectDataset.revision) !== Number(dataset.revision)) {
      var kept = keepFileKey ? state.fileDatasets[keepFileKey] : null;
      state.fileDatasets = {};
      if (kept) { state.fileDatasets[keepFileKey] = kept; }
    }
    state.projectDataset = dataset;
  }

  function scopeFileKey(snapshot) {
    return snapshot.scope?.kind === 'file' ? normalizeRelativePath(snapshot.scope.relativePath) : '';
  }

  // The dataset that draws the snapshot's scope (DEPGRAPH-4).
  function datasetUrlForScope(snapshot) {
    if (snapshot.scope?.kind === 'file') {
      var fileUrl = snapshot.fileDatasetUrl
        && normalizeRelativePath(snapshot.fileDatasetPath) === scopeFileKey(snapshot)
        ? snapshot.fileDatasetUrl : '';
      return fileUrl || snapshot.datasetUrl;
    }
    return snapshot.projectDatasetUrl || snapshot.datasetUrl;
  }

  function hasDatasetForScope(snapshot) {
    var fileKey = scopeFileKey(snapshot);
    return fileKey ? Boolean(state.fileDatasets[fileKey]) : Boolean(state.projectDataset);
  }

  function storeDataset(snapshot, dataset) {
    state.dataset = dataset;
    if (dataset.targetType === 'directory') {
      setProjectDataset(dataset, scopeFileKey(snapshot));
    } else {
      var fileKey = normalizeRelativePath(
        dataset.targetRelativePath || snapshot.scope?.relativePath
      );
      state.fileDatasets[fileKey] = dataset;
    }
  }

  // A file-scoped snapshot also points at the project-wide dataset; keep it
  // when it is still wanted, by the same snapshot (DEPGRAPH-11).
  async function loadProjectDataset(snapshot, loadGeneration, viewGeneration, signal) {
    var projectResponse = await fetch(
      snapshot.projectDatasetUrl + '?sourceRevision=' + Number(snapshot.sourceRevision || 0),
      signal ? { cache: 'no-store', signal: signal } : { cache: 'no-store' }
    );
    if (projectResponse.ok && isLoadCurrent(loadGeneration, viewGeneration) && state.snapshot === snapshot) {
      var projectDataset = await projectResponse.json();
      if (projectDataset?.targetType === 'directory' && state.snapshot === snapshot) {
        setProjectDataset(projectDataset, scopeFileKey(snapshot));
      }
    }
  }

  /**
   * options.signal aborts the dataset fetch (the mode switcher cancels an
   * activation the user moved away from); options.rethrow makes a load
   * failure reject, so the activation fails visibly on the selector instead
   * of leaving an empty table that says "ready" (LIFECYCLE-5).
   */
  async function applySharedState(snapshot, options) {
    var signal = options?.signal || null;
    snapshot = withSnapshotDefaults(snapshot);
    state.snapshot = snapshot;
    if (snapshot && snapshot.status !== 'ready') {
      // A new analysis is under way: the old load error no longer applies.
      state.loadError = null;
    }
    if (!snapshot) {
      renderControls();
      return;
    }
    if (!isDependencyModeActiveOrActivating()) {
      renderControls();
      return;
    }
    renderControls();
    if (snapshot.status !== 'ready' || !snapshot.datasetUrl) {
      setStatus(snapshot.message || 'Analyzing dependencies...', false);
      if (snapshot.status === 'error') {
        setTransitionLocked(false);
      }
      return;
    }
    try {
      var loadGeneration = ++state.datasetLoadGeneration;
      var viewGeneration = state.viewGeneration;
      var primaryUrl = datasetUrlForScope(snapshot);
      var response = await fetch(
        primaryUrl + '?revision=' + snapshot.revision,
        signal ? { cache: 'no-store', signal: signal } : { cache: 'no-store' }
      );
      if (!response.ok) {
        throw new Error('The dependency data could not be loaded (HTTP ' + response.status + ').');
      }
      var dataset = await response.json();
      if (!isLoadCurrent(loadGeneration, viewGeneration) || state.snapshot !== snapshot) {
        return;
      }
      storeDataset(snapshot, dataset);
      if (snapshot.projectDatasetUrl && snapshot.projectDatasetUrl !== primaryUrl) {
        await loadProjectDataset(snapshot, loadGeneration, viewGeneration, signal);
      }
      state.loadError = null;
      if (!hasDatasetForScope(snapshot) && scopeFileKey(snapshot) && !client()?.isOfflineExport?.()) {
        // An older room entity named a file without its dataset: ask for it
        // rather than drawing an empty table.
        setStatus('Loading symbols for ' + scopeFileKey(snapshot) + '...', false);
        client()?.sendMessage?.('dependency-file-scope-request', { relativePath: scopeFileKey(snapshot) });
      }
      renderGraph();
      setTransitionLocked(false);
    } catch (error) {
      setTransitionLocked(false);
      if (signal?.aborted) {
        // Cancelled by the switcher: not an error the user should read.
        return;
      }
      var message = error && typeof error.message === 'string' ? error.message : String(error);
      // Sticky: renderControls re-runs on every panel route and would
      // otherwise overwrite it with the snapshot's "ready".
      state.loadError = message;
      setStatus(message, true);
      if (options?.rethrow) { throw error; }
    }
  }

  function hasReadySnapshot() {
    return state.snapshot?.status === 'ready' && !!state.snapshot?.datasetUrl;
  }

  function enterDependencyMode(reason) {
    var offline = client()?.isOfflineExport?.() === true;
    root.console?.log?.('[CodeXR.Debug]: Activating existing dependency graph snapshot', {
      offline: offline,
      hasDataset: !!state.dataset,
      datasetUrl: state.snapshot.datasetUrl
    });
    if (!offline) {
      client()?.sendMessage?.('analysis-mode-activate', {
        mode: 'dependency-graph'
      });
    }
    void root.CodeXRAnalysisModeRuntime?.changeAnalysis?.('dependency-graph', {
      reason: reason || 'local-dependency-mode-option',
      panelViewId: 'dependency-graph'
    });
    return true;
  }

  function activateReadySnapshot(reason) {
    if (!hasReadySnapshot()) { return false; }
    return enterDependencyMode(reason);
  }

  /** Mirrors the opening progress on the selector, which is what is visible. */
  function reportOnSelector(message, isError) {
    var modeRuntime = root.CodeXRAnalysisModeRuntime;
    if (modeRuntime?.getState?.()?.mode !== 'selection') { return; }
    modeRuntime.setSelectorStatus?.(message, isError ? 'error' : 'info');
  }

  async function start() {
    if (state.availability !== 'enabled') {
      setStatus(state.unavailableReason, true);
      return;
    }
    if (state.transitionLocked) {
      // A second click while the first is still opening: say so instead of
      // swallowing it (LIFECYCLE-6).
      reportOnSelector('Still opening the dependency graph...', false);
      return;
    }
    if (hasReadySnapshot() && client()?.isOfflineExport?.()) {
      activateReadySnapshot('offline-dependency-snapshot');
      return;
    }
    // An exported copy has no server to analyze with: say so instead of
    // entering the send-retry loop below, which would spin forever.
    if (client()?.isOfflineExport?.()) {
      setStatus('This exported analysis is read-only: re-analysis needs the live CodeXR session.', true);
      return;
    }
    var connection = client();
    if (!connection?.sendMessage) {
      setStatus('Dependency analysis is unavailable: no collaboration channel.', true);
      return;
    }
    setTransitionLocked(true, 'Opening dependencies...');
    reportOnSelector('Opening dependencies...', false);
    // The hop to selection is cosmetic; the server's authoritative
    // analysis-view broadcast is what really drives the scene into
    // dependency mode. A failed local transition must never swallow the
    // start message (start() is called as `void start()` — an escaped
    // rejection here is total silence in the scene).
    try {
      await root.CodeXRAnalysisModeRuntime?.changeAnalysis?.('selection', {
        reason: 'dependency-refresh'
      });
    } catch (error) {
      root.console?.warn?.('[CodeXR][DependencyGraph] selection hop failed; sending dependency-graph-start anyway.', error);
    }
    // send() drops silently while the socket is still connecting — retry
    // until it goes through. Gated on a send generation of its own (the
    // transition lock legitimately clears during the hop to selection).
    var sendGeneration = state.startSendGeneration = (state.startSendGeneration || 0) + 1;
    var attempts = 0;
    var attemptSend = function () {
      if (sendGeneration !== state.startSendGeneration) { return; }
      // Only an explicit `false` means "socket not ready, dropped" — clients
      // whose sendMessage returns nothing are treated as delivered.
      if (client()?.sendMessage?.('dependency-graph-start', {}) !== false) { return; }
      attempts += 1;
      // Bounded like the lock watchdog: a socket that stays down for 20 s
      // gets a visible answer, not a retry loop for the rest of the session.
      if (attempts >= START_SEND_MAX_ATTEMPTS) {
        root.console?.warn?.('[CodeXR][DependencyGraph] collaboration socket stayed down; giving up on dependency-graph-start.');
        setTransitionLocked(false);
        setStatus('CodeXR is not connected to VS Code. Try again once it reconnects.', true);
        reportOnSelector('CodeXR is not connected to VS Code. Try again once it reconnects.', true);
        return;
      }
      root.console?.warn?.('[CodeXR][DependencyGraph] collaboration socket not ready; retrying dependency-graph-start...');
      setTimeout(attemptSend, 500);
    };
    attemptSend();
  }
  async function reanalyze() {
    if (state.availability !== 'enabled' || state.transitionLocked) { return; }
    if (client()?.isOfflineExport?.()) {
      setStatus('This exported analysis is read-only: re-analysis needs the live CodeXR session.', true);
      return;
    }
    setTransitionLocked(true, 'Re-analyzing dependencies...');
    client()?.sendMessage?.('dependency-graph-start', { forceFull: true });
  }
  function selectDependencyMode() {
    if (activateReadySnapshot('local-dependency-mode-option')) {
      return;
    }
    // A refresh is already running (a file was saved, or another participant
    // started one): attach to it. The mode opens with its progress and
    // renders when the ready snapshot lands. Starting again was refused by
    // the server and stranded the user on the selector (DEPGRAPH-7).
    if (state.snapshot?.status === 'analyzing' && !client()?.isOfflineExport?.()) {
      root.console?.log?.('[CodeXR.Debug]: Dependency analysis already running; attaching to it');
      enterDependencyMode('attach-running-dependency-analysis');
      return;
    }
    root.console?.log?.('[CodeXR.Debug]: Dependency graph mode selected; starting dependency analysis', {
      hasDataset: !!state.dataset,
      availability: state.availability
    });
    void start();
  }
  async function openModeSelector() {
    return root.CodeXRAnalysisModeRuntime?.openSelector?.();
  }
  async function configureAvailability() {
    try {
      var info = await client()?.getSessionInfoAsync?.();
      state.availability = info?.capabilities?.dependencyGraph === true ? 'enabled' : 'disabled';
      state.unavailableReason = info?.capabilities?.dependencyGraphReason
        || 'Dependency graphs require an XR file, directory, or project analysis.';
    } catch {
      state.availability = 'disabled';
      state.unavailableReason = 'Dependency graph availability could not be checked.';
    }
    registerDependencyModeOption();
  }
  function registerDependencyModeOption() {
    state.unregisterMode?.();
    state.unregisterMode = root.CodeXRAnalysisModeRuntime?.registerModeOption?.({
      id: 'dependency-graph',
      label: 'Dependency graph',
      color: '#7c3aed',
      disabled: state.availability !== 'enabled',
      disabledReason: state.unavailableReason
        || 'Dependency graphs require an XR file, directory, or project analysis.',
      onSelect: selectDependencyMode
    }) || null;
  }
  function registerCollaboration() {
    var connection = client();
    state.disposables.push(connection?.onMessage?.('dependency-graph-progress', function (message) {
      var progress = message?.payload?.message || 'Analyzing dependencies...';
      setStatus(progress, false);
      // Progress is an answer: re-arm the 20 s watchdog so a long first
      // analysis is not reported as "did not respond" while it works.
      if (state.transitionLocked) {
        setTransitionLocked(true);
        reportOnSelector(progress, false);
      }
    }));
    state.disposables.push(connection?.onMessage?.('dependency-graph-error', function (message) {
      var failure = message?.payload?.message || 'Dependency analysis failed.';
      root.console?.warn?.('[CodeXR][DependencyGraph] Server reported:', failure);
      setStatus(failure, true);
      reportOnSelector(failure, true);
      setTransitionLocked(false);
    }));
    connection?.registerEntityRuntime?.({
      entityKind: ENTITY_KIND,
      entityId: ENTITY_ID,
      applySharedState: applySharedState,
      publishInitialSharedState: function () {}
    });
  }
  function mount(attempt) {
    buildPanel();
    if (!state.unregisterLifecycle && root.CodeXRAnalysisModeRuntime?.register) {
      state.unregisterLifecycle = root.CodeXRAnalysisModeRuntime.register('dependency-graph', {
        mappingContextId: null,
        activate: function (activation) {
          // Abandoned by the switcher before it started: leave the table alone.
          if (activation?.token?.isCurrent && !activation.token.isCurrent()) {
            return false;
          }
          state.active = true;
          state.viewGeneration += 1;
          parkOriginal();
          renderControls();
          if (state.dataset && state.snapshot?.status === 'ready') {
            renderGraph();
            setTransitionLocked(false);
            void applySharedState(state.snapshot);
            return;
          }
          if (state.snapshot) {
            return applySharedState(state.snapshot, { signal: activation?.signal, rethrow: true });
          }
        },
        deactivate: function () {
          disposeView();
        }
      });
    }
    if (!state.unregisterMode && root.CodeXRAnalysisModeRuntime?.registerModeOption) {
      registerDependencyModeOption();
    }
    if (!refs.controls || !state.unregisterMode || !state.unregisterLifecycle) {
      if (attempt < 30) {
        setTimeout(function () { mount(attempt + 1); }, 100);
      } else {
        // LIFECYCLE-11: say once why the mode never appeared, instead of
        // stopping silently after the 3 s of retries.
        root.console?.warn?.('[CodeXR][DependencyGraph] Gave up mounting after 3 s: '
          + [!refs.controls && 'controls panel', !state.unregisterMode && 'mode option', !state.unregisterLifecycle && 'mode lifecycle']
            .filter(Boolean).join(', ') + ' not available.');
      }
    }
  }
  function autoInit() {
    if (state.initialized || !doc()) { return; }
    state.initialized = true;
    registerComponent();
    mount(0);
    registerCollaboration();
    void configureAvailability();
  }
  root.CodeXRDependencyGraphRuntime = {
    autoInit: autoInit,
    start: start,
    openModeSelector: openModeSelector,
    applySharedState: applySharedState,
    resetView: resetView,
    openDirectory: openDirectory,
    openFile: openFile,
    getState: function () { return state; },
    __testing: {
      computeNiceScale: computeNiceScale,
      buildMetricScales: buildMetricScales,
      nodeDetailModel: nodeDetailModel,
      edgeDetailModel: edgeDetailModel,
      intensityBucket: intensityBucket,
      edgeStyle: edgeStyle,
      edgeEncodingLegend: edgeEncodingLegend,
      flowSizeOption: flowSizeOption,
      flowSpeedOption: flowSpeedOption,
      FLOW_SIZE_OPTIONS: FLOW_SIZE_OPTIONS,
      FLOW_SPEED_OPTIONS: FLOW_SPEED_OPTIONS,
      FLOW_DEFAULTS: FLOW_DEFAULTS,
      graphDensityStats: graphDensityStats,
      buildExternalSummaryDataset: buildExternalSummaryDataset,
      projectDirectoryScope: projectDirectoryScope,
      projectFileScope: projectFileScope,
      aggregateMetricsFromEdges: aggregateMetricsFromEdges,
      applyRenderBudget: applyRenderBudget,
      renderBudgetNotice: renderBudgetNotice,
      datasetUrlForScope: datasetUrlForScope,
      setProjectDataset: setProjectDataset,
      createLayoutWorker: createLayoutWorker,
      isGraphComponentReady: isGraphComponentReady,
      openFile: openFile,
      state: state,
      normalizeRelativePath: normalizeRelativePath,
      symbolVisual: symbolVisual,
      selectDependencyMode: selectDependencyMode
    },
    destroy: function () {
      state.disposables.forEach(function (dispose) { dispose?.(); });
      state.unregisterMode?.();
      state.unregisterPanel?.();
      state.unregisterLifecycle?.();
      state.unregisterLifecycle = null;
      clearRenderRetries();
      disposeView();
      state.initialized = false;
    }
  };
  if (doc()) {
    if (doc().readyState === 'loading') { doc().addEventListener('DOMContentLoaded', autoInit, { once: true }); }
    else { autoInit(); }
  }
})(typeof window !== 'undefined' ? window : this);
