// == drillDownRuntime.js | modeLifecycle (assembled per manifest.json; see COMPONENTS.md) ==
  // Registration with the analysis-mode switcher and the room; the public
  // API. The table's controller stays the analysis controller while drilled
  // (metrics and chart type drive the drilled chart); the bar navigates. Passive mode-entity contract (COMPONENTS.md):
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
      controllerSchema: snapshot.controllerSchema && typeof snapshot.controllerSchema === 'object' && Array.isArray(snapshot.controllerSchema.dimensions)
        ? snapshot.controllerSchema : null,
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
  }

  function activate(activation) {
    if (activation?.token?.isCurrent && !activation.token.isCurrent()) { return false; }
    state.active = true;
    closeCard();
    if (state.entity?.datasetUrl) {
      showDrilledView();
    } else {
      parkClassic();
      requestState();
    }
    renderBar();
    return true;
  }

  function deactivate() {
    state.active = false;
    closeCard();
    removeView();
    releaseController();
    restoreClassic();
    renderBar();
  }

  function registerLifecycle() {
    if (state.unregisterLifecycle || !root.CodeXRAnalysisModeRuntime?.register) { return !!state.unregisterLifecycle; }
    state.unregisterLifecycle = root.CodeXRAnalysisModeRuntime.register(MODE, {
      // The classic analysis' profile: the controller opens on the metrics
      // and chart the user had, and keeps them from one drill to the next.
      mappingContextId: 'normal-analysis',
      activate: activate,
      deactivate: deactivate,
      resolveControllerView: function () { return CONTROLLER_VIEW; }
    }) || null;
    return !!state.unregisterLifecycle;
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
    };
    table.addEventListener('componentchanged', onChange);
    state.tableBound = true;
    state.disposables.push(function () { table.removeEventListener('componentchanged', onChange); state.tableBound = false; });
    return true;
  }

  function mount(attempt) {
    var ready = [registerLifecycle(), registerCollaboration(), bindSceneClicks(), bindTableMode(), bindMappingChanges()].every(Boolean);
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
      namespaceNodes: namespaceNodes,
      chartMetrics: chartMetrics,
      hidePinnedLegend: hidePinnedLegend,
      drillChartSpec: drillChartSpec,
      controllerSchemaFor: controllerSchemaFor,
      tableScope: tableScope
    },
    destroy: function () {
      stopLoadingTicker();
      state.disposables.forEach(function (dispose) { if (typeof dispose === 'function') { dispose(); } });
      state.disposables = [];
      state.unregisterLifecycle?.();
      state.unregisterLifecycle = null;
      state.collaborationRegistered = false;
      closeCard();
      removeView();
      refs.bar?.el?.parentNode?.removeChild?.(refs.bar.el);
      refs.loading?.el?.parentNode?.removeChild?.(refs.loading.el);
      refs.bar = null;
      refs.loading = null;
      state.initialized = false;
    }
  };

  if (doc()) {
    if (doc().readyState === 'loading') { doc().addEventListener('DOMContentLoaded', autoInit, { once: true }); }
    else { autoInit(); }
  }
})(typeof window !== 'undefined' ? window : this);
