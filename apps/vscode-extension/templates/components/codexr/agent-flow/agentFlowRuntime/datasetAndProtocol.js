// == agentFlowRuntime.js | datasetAndProtocol (assembled per manifest.json; see COMPONENTS.md) ==
  // Room protocol and the shared 'agent-flow' entity.
  //   client -> server: agent-flow-sources-request {}, agent-flow-open { sourceId },
  //                     agent-flow-close {}
  //   server -> client: agent-flow-sources { sources, activeSourceId },
  //                     agent-flow-error { message }
  //   entity (agent-flow/main): { status, revision, datasetUrl, sourceId, live, message? }
  // Passive mode-entity contract (COMPONENTS.md): the entity carries data,
  // never intent. It renders only while this mode is active or activating and
  // never changes the mode.

  function isAgentFlowActiveOrActivating() {
    var modeState = root.CodeXRAnalysisModeRuntime?.getState?.();
    if (modeState?.transitioning) { return modeState.pendingTransitionMode === MODE; }
    return modeState?.mode === MODE;
  }

  function unwrapPayload(message) {
    return message?.payload && typeof message.payload === 'object' ? message.payload : (message || {});
  }

  function requestSources() {
    var connection = client();
    state.sourcesRequested = true;
    if (connection?.isOfflineExport?.()) {
      setStatus('This exported copy replays the session it was exported with.', false);
      renderPanel();
      return false;
    }
    if (!connection?.sendMessage) {
      setStatus('Agent sessions are unavailable: no collaboration channel.', true);
      renderPanel();
      return false;
    }
    connection.sendMessage('agent-flow-sources-request', {});
    setStatus('Looking for agent sessions...', false);
    renderPanel();
    return true;
  }

  function openSource(sourceId) {
    if (!sourceId) { return false; }
    var connection = client();
    if (!connection?.sendMessage || connection.isOfflineExport?.()) {
      setStatus('Opening another session needs the live Code-XR session.', true);
      return false;
    }
    connection.sendMessage('agent-flow-open', { sourceId: String(sourceId) });
    state.activeSourceId = String(sourceId);
    setStatus('Opening the agent session...', false);
    renderPanel();
    return true;
  }

  function openSourceAt(rowIndex) {
    var source = refs.pageSources?.[rowIndex];
    return source ? openSource(source.id) : false;
  }

  function closeSession() {
    state.playback?.pause();
    var connection = client();
    if (connection?.sendMessage && !connection.isOfflineExport?.()) {
      connection.sendMessage('agent-flow-close', {});
      setStatus('Closing the session...', false);
    }
    renderPanel();
  }

  function handleSources(message) {
    var payload = unwrapPayload(message);
    state.sources = Array.isArray(payload.sources) ? payload.sources.filter(function (source) { return source && source.id; }) : [];
    if (payload.activeSourceId !== undefined) { state.activeSourceId = payload.activeSourceId || null; }
    state.sourcesRequested = true;
    setStatus(state.sources.length ? '' : 'No agent sessions found for this folder yet.', false);
    if (!state.dataset && state.active) { showIdleHint(); }
    renderPanel();
  }

  function handleError(message) {
    var failure = unwrapPayload(message).message || 'The agent session could not be opened.';
    setStatus(failure, true);
    if (!state.dataset && state.active) { showHint('Agent flow', failure, true); }
    renderPanel();
  }

  function normalizeEntity(payload) {
    var source = payload?.state && typeof payload.state === 'object' ? payload.state : payload;
    if (!source || typeof source !== 'object') { return null; }
    return {
      status: ['idle', 'loading', 'ready', 'error'].indexOf(source.status) >= 0 ? source.status : 'idle',
      revision: Number(source.revision) || 0,
      datasetUrl: source.datasetUrl ? String(source.datasetUrl) : null,
      sourceId: source.sourceId ? String(source.sourceId) : null,
      live: source.live === true,
      message: source.message ? String(source.message) : ''
    };
  }

  function showIdleHint() {
    var detail = state.sources.length
      ? state.sources.length + ' session' + (state.sources.length === 1 ? '' : 's') + ' found. Choose one in the Agent flow panel.'
      : 'Sessions from Claude Code, Codex or the Code-XR IDE on this folder are listed there.';
    showHint('Pick an agent session in the controller', detail, false);
  }

  function showIdle() {
    disposeCurrentView();
    state.dataset = null;
    state.loadedUrl = null;
    state.playback?.reset(-1);
    showIdleHint();
    renderPanel();
  }

  /** Applies the room entity; a no-op on the table unless the mode is showing. */
  function applySharedState(payload, options) {
    state.entity = normalizeEntity(payload);
    if (state.entity?.sourceId) { state.activeSourceId = state.entity.sourceId; }
    if (!isAgentFlowActiveOrActivating() || !state.active) {
      renderPanel();
      return Promise.resolve(false);
    }
    return syncEntity(options);
  }

  function syncEntity(options) {
    var shared = state.entity;
    if (!shared || shared.status === 'idle') {
      showIdle();
      return Promise.resolve(false);
    }
    if (shared.status === 'error') {
      setStatus(shared.message || 'The agent session could not be read.', true);
      if (!view) { showHint('The agent session could not be read', shared.message, true); }
      renderPanel();
      return Promise.resolve(false);
    }
    if (shared.status === 'loading' || !shared.datasetUrl) {
      setStatus(shared.message || 'Reading the agent session...', false);
      if (!view) { showHint('Reading the agent session...', shared.message, false); }
      renderPanel();
      return Promise.resolve(false);
    }
    if (state.dataset && state.loadedUrl === shared.datasetUrl && state.dataset.revision === shared.revision) {
      ensureView();
      return Promise.resolve(true);
    }
    return loadDataset(shared, options);
  }

  async function loadDataset(shared, options) {
    var generation = ++state.loadGeneration;
    var signal = options?.signal || null;
    try {
      var url = shared.datasetUrl + (shared.datasetUrl.indexOf('?') >= 0 ? '&' : '?') + 'revision=' + shared.revision;
      var response = await root.fetch(url, signal ? { cache: 'no-store', signal: signal } : { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('The agent session could not be loaded (HTTP ' + response.status + ').');
      }
      var raw = await response.json();
      if (generation !== state.loadGeneration || !state.active) { return false; }
      var dataset = normalizeDataset(raw);
      if (!dataset) { throw new Error('The agent session data is not a valid Agent Flow dataset.'); }
      state.loadedUrl = shared.datasetUrl;
      state.loadError = null;
      applyDataset(dataset);
      return true;
    } catch (error) {
      if (signal?.aborted) { return false; }
      var message = error && typeof error.message === 'string' ? error.message : String(error);
      state.loadError = message;
      setStatus(message, true);
      if (!view) { showHint('The agent session could not be loaded', message, true); }
      renderPanel();
      if (options?.rethrow) { throw error; }
      return false;
    }
  }

  /**
   * Draws a dataset: a first one, a newer revision of the same session (live
   * append), or another session. Rebuilds the city only when the layout
   * changed; follows live steps when the playhead was at the end.
   */
  function applyDataset(input) {
    var dataset = input?.normalized ? input : normalizeDataset(input);
    if (!dataset) { return false; }
    var playback = state.playback;
    var before = playback.getState();
    var previous = view && state.dataset && state.dataset.session?.id === dataset.session?.id ? state.dataset : null;
    var plan = planLiveUpdate(previous, dataset, before.index, { followLive: before.followLive });
    state.dataset = dataset;
    playback.setLive(!!dataset.session.live);
    if (!state.active || !ensureRoot()) { return true; }
    if (plan.rebuild || !view) {
      disposeCurrentView();
      view = createView(refs.root, dataset);
    } else {
      refreshViewDataset(dataset);
    }
    showHint(dataset.steps.length ? '' : 'Waiting for the agent', dataset.steps.length ? '' : 'The session has no steps yet: they appear here as the agent works.', false);
    if (!plan.rebuild && before.playing && plan.animateFrom === null) {
      // A replay in progress keeps playing; only the timeline grew.
      updateTimelineLectern(view, view.cityState || stateAt(dataset, before.index, view.timeline));
      renderPanel();
      return true;
    }
    playback.reset(plan.index);
    renderAt(plan.index, { animate: false });
    if (plan.animateFrom !== null) { playback.datasetGrew(plan.animateFrom); }
    setStatus(dataset.warnings.length ? compact(dataset.warnings[0], 90) : '', false);
    renderPanel();
    return true;
  }

  /** Rebuilds the scene from the kept dataset (re-entry into the mode). */
  function ensureView() {
    if (!state.dataset || !state.active || !ensureRoot()) { return; }
    if (view) { return; }
    view = createView(refs.root, state.dataset);
    showHint(state.dataset.steps.length ? '' : 'Waiting for the agent', '', false);
    var index = Math.min(state.playback.getState().index, view.timeline.count - 1);
    state.playback.reset(index);
    renderAt(index, { animate: false });
  }
