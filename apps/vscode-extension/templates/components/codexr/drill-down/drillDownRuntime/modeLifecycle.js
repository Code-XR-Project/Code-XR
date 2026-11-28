// == drillDownRuntime.js | modeLifecycle (assembled per manifest.json; see COMPONENTS.md) ==
  // Registration with the analysis-mode switcher, the controller panel and
  // the room; the public API. Passive mode-entity contract (COMPONENTS.md):
  // the `drill-down` entity carries data, never intent. The server switches
  // the room's mode (analysis-view) and this runtime only draws what the
  // entity says while its mode is active.

  function normalizeEntity(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') { return null; }
    return {
      status: String(snapshot.status || 'idle'),
      revision: Number(snapshot.revision) || 0,
      target: snapshot.target && typeof snapshot.target === 'object'
        ? { kind: snapshot.target.kind === 'file' ? 'file' : 'directory', relativePath: String(snapshot.target.relativePath || '') }
        : { kind: 'directory', relativePath: '' },
      targetPath: String(snapshot.targetPath || ''),
      homeKind: snapshot.homeKind === 'file' ? 'file' : 'directory',
      homeRelativePath: String(snapshot.homeRelativePath || ''),
      homePath: String(snapshot.homePath || ''),
      homeCrumbs: Array.isArray(snapshot.homeCrumbs) ? snapshot.homeCrumbs : [],
      atHome: snapshot.atHome !== false,
      pending: snapshot.pending && typeof snapshot.pending === 'object' ? snapshot.pending : null,
      crumbs: Array.isArray(snapshot.crumbs) ? snapshot.crumbs : [],
      canBack: !!snapshot.canBack,
      canForward: !!snapshot.canForward,
      rootLabel: String(snapshot.rootLabel || ''),
      rootPath: String(snapshot.rootPath || ''),
      datasetUrl: typeof snapshot.datasetUrl === 'string' && snapshot.datasetUrl ? snapshot.datasetUrl : null,
      chartId: String(snapshot.chartId || 'boats'),
      mapping: snapshot.mapping && typeof snapshot.mapping === 'object' ? snapshot.mapping : {},
      treeField: String(snapshot.treeField || 'filePath'),
      rowCount: Number(snapshot.rowCount) || 0,
      analyzedCount: Number(snapshot.analyzedCount) || 0,
      reusedCount: Number(snapshot.reusedCount) || 0,
      source: snapshot.source || null,
      message: String(snapshot.message || ''),
      startedAt: Number(snapshot.startedAt) || null
    };
  }

  function applySharedState(snapshot) {
    var next = normalizeEntity(snapshot);
    if (!next) { return; }
    var previous = state.entity;
    state.entity = next;
    if (!previous || previous.revision !== next.revision) {
      state.pendingLabel = '';
      if (next.status !== 'error') { state.lastError = ''; }
    }
    if (next.status === 'error') { state.lastError = next.message; }
    var targetChanged = !previous || previous.target.kind !== next.target.kind || previous.target.relativePath !== next.target.relativePath;
    if (targetChanged) { closeCard(); }
    if (state.active && next.datasetUrl && next.status !== 'loading') { showDrilledView(); }
    renderBar();
    renderPanel();
  }

  function activate(activation) {
    if (activation?.token?.isCurrent && !activation.token.isCurrent()) { return false; }
    state.active = true;
    closeCard();
    buildPanel();
    if (state.entity?.datasetUrl) {
      showDrilledView();
    } else {
      parkClassic();
      requestState();
    }
    renderBar();
    renderPanel();
    return true;
  }

  function deactivate() {
    state.active = false;
    closeCard();
    removeView();
    restoreClassic();
    renderBar();
    renderPanel();
  }

  function registerLifecycle() {
    if (state.unregisterLifecycle || !root.CodeXRAnalysisModeRuntime?.register) { return !!state.unregisterLifecycle; }
    state.unregisterLifecycle = root.CodeXRAnalysisModeRuntime.register(MODE, {
      mappingContextId: null,
      activate: activate,
      deactivate: deactivate,
      resolveControllerView: function () { return MODE; }
    }) || null;
    return !!state.unregisterLifecycle;
  }

  // The controller's view while a drilled target is on the table: where you
  // are, how it was computed, and the same moves as the bar.
  function buildPanel() {
    var mapping = root.CodeXRMappingUiRuntime;
    if (refs.panel || !mapping?.registerPanelView) { return !!refs.panel; }
    if (mapping.isPanelReady && !mapping.isPanelReady()) {
      if (!refs.panelMountQueued) {
        refs.panelMountQueued = true;
        mapping.whenPanelReady?.(function () { refs.panelMountQueued = false; buildPanel(); });
      }
      return false;
    }
    var panel = entity('a-entity', { position: '0 0 0.04' });
    refs.panelTitle = text('', '-2.85 1.2 0.02', 5.7, COLORS.current, 'left', 46);
    refs.panelInfo = text('', '-2.85 0.75 0.02', 5.7, COLORS.muted, 'left', 60);
    panel.appendChild(refs.panelTitle);
    panel.appendChild(refs.panelInfo);
    refs.panelBack = button('Back', '-1.9 0.15 0.02', 1.1, function () { send('drilldown-back'); }, COLORS.button, { height: 0.36 });
    refs.panelUp = button('Up one level', '-0.35 0.15 0.02', 1.7, goUp, COLORS.button, { height: 0.36 });
    refs.panelHome = button('Classic analysis', '1.65 0.15 0.02', 2, function () { send('drilldown-home'); }, COLORS.home, { height: 0.36 });
    panel.appendChild(refs.panelBack.el);
    panel.appendChild(refs.panelUp.el);
    panel.appendChild(refs.panelHome.el);
    panel.appendChild(text('Select a building or a district on the table to analyse it.', '-2.85 -0.4 0.02', 5.7, COLORS.muted, 'left', 60));
    refs.panel = panel;
    state.unregisterPanel = mapping.registerPanelView({
      id: MODE,
      title: 'Drill-down',
      headerButton: false,
      panelHeight: 3.4,
      content: panel,
      onShow: renderPanel
    }) || null;
    renderPanel();
    return !!refs.panel;
  }

  function parentCrumb() {
    var crumbs = state.entity?.crumbs || [];
    return crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  }

  function goUp() {
    var parent = parentCrumb();
    if (parent) { send('drilldown-goto', { relativePath: parent.relativePath, kind: parent.kind }); }
  }

  function renderPanel() {
    if (!refs.panel) { return; }
    var entityState = state.entity;
    var target = entityState?.target;
    setText(refs.panelTitle, target
      ? (target.kind === 'file' ? 'File: ' : 'Folder: ') + compact(target.relativePath || entityState.rootLabel, 44)
      : 'Drill-down');
    var line = statusLine(entityState);
    setText(refs.panelInfo, compact(line.text, 120), line.color);
    setButtonEnabled(refs.panelBack, !!entityState?.canBack);
    setButtonEnabled(refs.panelUp, !!parentCrumb());
    setButtonEnabled(refs.panelHome, !!entityState);
  }

  function requestState(attempt) {
    var connection = client();
    if (!connection?.sendMessage || connection.isOfflineExport?.()) { return; }
    state.stateRequested = true;
    if (connection.sendMessage('drilldown-state-request', {}) === false && (attempt || 0) < 20) {
      root.setTimeout?.(function () { if (!state.entity) { requestState((attempt || 0) + 1); } }, 500);
    }
  }

  function handleError(message) {
    var payload = message?.payload && typeof message.payload === 'object' ? message.payload : (message || {});
    showError(payload.message || 'The drill-down request failed.');
    renderPanel();
  }

  function registerCollaboration() {
    var connection = client();
    if (!connection || state.collaborationRegistered) { return !!state.collaborationRegistered; }
    state.collaborationRegistered = true;
    state.disposables.push(connection.onMessage?.('drilldown-error', handleError));
    connection.registerEntityRuntime?.({
      entityKind: ENTITY_KIND,
      entityId: ENTITY_ID,
      applySharedState: applySharedState,
      publishInitialSharedState: function () {},
      handleCollaborationMessage: function (message) {
        if (message?.type === 'entity-removed') {
          state.entity = null;
          renderBar();
        }
      }
    });
    if (!state.entity) { requestState(0); }
    return true;
  }

  // The table writes its mode on a real change only, so this is a precise,
  // poll-free signal for the bar and the card (the logo's contract).
  function bindTableMode() {
    var table = doc()?.getElementById?.('codexrAnalysisTable');
    if (!table || state.tableBound) { return !!state.tableBound; }
    var onChange = function (event) {
      if (event?.detail?.name && event.detail.name !== 'codexr-analysis-table') { return; }
      if (!isNavigableMode()) { closeCard(); }
      renderBar();
      renderPanel();
    };
    table.addEventListener('componentchanged', onChange);
    state.tableBound = true;
    state.disposables.push(function () { table.removeEventListener('componentchanged', onChange); state.tableBound = false; });
    return true;
  }

  function mount(attempt) {
    var ready = [registerLifecycle(), registerCollaboration(), bindSceneClicks(), bindTableMode()].every(Boolean);
    buildPanel();
    if (ready) { renderBar(); return; }
    if (attempt < 40) {
      root.setTimeout?.(function () { mount(attempt + 1); }, 100);
    } else {
      root.console?.warn?.('[CodeXR][DrillDown] Gave up mounting after 4 s: '
        + [!state.unregisterLifecycle && 'mode lifecycle', !state.collaborationRegistered && 'collaboration client',
          !state.sceneClickBound && 'scene', !state.tableBound && 'analysis table'].filter(Boolean).join(', ') + ' not available.');
    }
  }

  function autoInit() {
    if (state.initialized || !doc()) { return; }
    state.initialized = true;
    mount(0);
  }

  function debugSnapshot() {
    return {
      active: state.active,
      mode: currentMode(),
      entity: state.entity ? Object.assign({}, state.entity) : null,
      viewKey: state.viewKey,
      chartBuilt: !!refs.chart,
      card: refs.card ? state.cardTarget : null,
      barVisible: !!refs.bar?.el?.object3D?.visible,
      crumbs: refs.bar ? Array.prototype.map.call(refs.bar.crumbs.querySelectorAll?.('[data-codexr-crumb-path]') || [], function (el) {
        return el.getAttribute('data-codexr-crumb-path');
      }) : [],
      status: refs.bar ? refs.bar.status.getAttribute('value') : '',
      loadingVisible: !!refs.loading?.el?.object3D?.visible,
      lastError: state.lastError
    };
  }

  root.CodeXRDrillDownRuntime = {
    autoInit: autoInit,
    applySharedState: applySharedState,
    open: function (kind, absolutePath) { return send('drilldown-open', { path: String(absolutePath || ''), kind: kind === 'file' ? 'file' : 'directory' }); },
    back: function () { return send('drilldown-back'); },
    forward: function () { return send('drilldown-forward'); },
    home: function () { return send('drilldown-home'); },
    goto: function (relativePath, kind) { return send('drilldown-goto', { relativePath: String(relativePath || ''), kind: kind === 'file' ? 'file' : 'directory' }); },
    closeCard: closeCard,
    getState: debugSnapshot,
    __testing: {
      MODE: MODE,
      state: state,
      refs: refs,
      normalizePath: normalizePath,
      stripNamespace: stripNamespace,
      relativeTo: relativeTo,
      parentPath: parentPath,
      targetFromRaw: targetFromRaw,
      findRawData: findRawData,
      pickableChartOf: pickableChartOf,
      layoutCrumbs: layoutCrumbs,
      crumbWidth: crumbWidth,
      describeReady: describeReady,
      formatElapsed: formatElapsed,
      normalizeEntity: normalizeEntity,
      cardActions: cardActions,
      handleSceneClick: handleSceneClick,
      statusLine: statusLine,
      renderBar: renderBar,
      activate: activate,
      deactivate: deactivate,
      namespaceNodes: namespaceNodes
    },
    destroy: function () {
      stopLoadingTicker();
      state.disposables.forEach(function (dispose) { if (typeof dispose === 'function') { dispose(); } });
      state.disposables = [];
      state.unregisterPanel?.();
      state.unregisterLifecycle?.();
      state.unregisterPanel = null;
      state.unregisterLifecycle = null;
      state.collaborationRegistered = false;
      closeCard();
      removeView();
      refs.bar?.el?.parentNode?.removeChild?.(refs.bar.el);
      refs.loading?.el?.parentNode?.removeChild?.(refs.loading.el);
      refs.bar = null;
      refs.loading = null;
      refs.panel = null;
      state.initialized = false;
    }
  };

  if (doc()) {
    if (doc().readyState === 'loading') { doc().addEventListener('DOMContentLoaded', autoInit, { once: true }); }
    else { autoInit(); }
  }
})(typeof window !== 'undefined' ? window : this);
