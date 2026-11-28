// == drillDownRuntime.js | chartView (assembled per manifest.json; see COMPONENTS.md) ==
  // The drilled chart: its own producer, tree builder and chart under one
  // root on the analysis surface, built with the controller's declarative
  // builders and fitted by the table containment like every other analysis.
  // The classic analysis is parked (hidden), never touched, so Home is
  // instant and its mapping state is exactly what it was.

  function containmentProfile() {
    return root.CodeXRAnalysisTableRuntime?.getContainmentProfile?.(MODE)
      || root.CodeXRAnalysisTableRuntime?.getContainmentProfile?.('single')
      || null;
  }

  function serialize(data) {
    var serializer = root.CodeXRMappingUiRuntime?.serializeDeclarativeComponentData;
    if (typeof serializer === 'function') { return serializer(data); }
    return Object.keys(data || {}).filter(function (key) {
      return data[key] !== undefined && data[key] !== null && data[key] !== '';
    }).map(function (key) { return key + ': ' + String(data[key]).replace(/;/g, ','); }).join(';\n');
  }

  function setDeclarative(el, name, value) {
    var setter = root.CodeXRMappingUiRuntime?.setDeclarativeAttribute;
    if (typeof setter === 'function') { setter(el, name, value); } else { el.setAttribute(name, value); }
  }

  function parkClassic() {
    var surface = root.CodeXRAnalysisSurfaceRuntime;
    if (surface?.setNormalVisible) { surface.setNormalVisible(false); return; }
    setNodeVisible(doc()?.getElementById?.('codexrNormalAnalysisRoot'), false);
  }

  function restoreClassic() {
    if (currentMode() !== 'single') { return; }
    var surface = root.CodeXRAnalysisSurfaceRuntime;
    if (surface?.setNormalVisible) { surface.setNormalVisible(true); return; }
    setNodeVisible(doc()?.getElementById?.('codexrNormalAnalysisRoot'), true);
  }

  function ensureViewRoot() {
    if (refs.viewRoot && refs.viewRoot.isConnected === false) { refs.viewRoot = null; }
    if (!refs.viewRoot) {
      refs.viewRoot = entity('a-entity', {
        id: ROOT_ID,
        'data-codexr-analysis-root': 'true',
        'data-codexr-analysis-mode': MODE,
        'data-codexr-role': 'drill-down root'
      });
    }
    var surface = root.CodeXRAnalysisSurfaceRuntime;
    if (surface?.mountRoot) { surface.mountRoot(MODE, refs.viewRoot); }
    else if (refs.viewRoot.parentNode !== sceneEl()) { sceneEl()?.appendChild(refs.viewRoot); }
    setNodeVisible(refs.viewRoot, true);
    return refs.viewRoot;
  }

  function removeView() {
    state.buildGeneration += 1;
    state.viewKey = '';
    state.viewRevision = 0;
    refs.viewRoot?.parentNode?.removeChild?.(refs.viewRoot);
    refs.viewRoot = null;
    refs.data = null;
    refs.tree = null;
    refs.chart = null;
  }

  function namespaceNodes(nodes) {
    return (Array.isArray(nodes) ? nodes : []).map(function (node) {
      var copy = Object.assign({}, node);
      var rawUid = String(node?.uid || node?.name || '');
      copy.uid = rawUid.indexOf(UID_NAMESPACE + ':') === 0 ? rawUid : UID_NAMESPACE + ':' + rawUid;
      if (Array.isArray(node?.children)) { copy.children = namespaceNodes(node.children); }
      return copy;
    });
  }

  /** Prefixes the tree's uids once its buffer exists (Babia ids its boats entities after them). */
  function scopeTreeOutput(tree, generation, attempt) {
    if (generation !== state.buildGeneration || !tree) { return; }
    var buffer = tree.components?.['babia-treebuilder']?.notiBuffer;
    if (!buffer || typeof buffer.set !== 'function') {
      if ((attempt || 0) < 60) { root.setTimeout?.(function () { scopeTreeOutput(tree, generation, (attempt || 0) + 1); }, 25); }
      return;
    }
    if (buffer.__codexrDrillNamespace) { return; }
    var originalSet = buffer.set.bind(buffer);
    buffer.set = function (payload) { originalSet(namespaceNodes(payload)); };
    buffer.__codexrDrillNamespace = UID_NAMESPACE;
    if (buffer.data !== undefined) { buffer.data = namespaceNodes(buffer.data); }
  }

  function chartTitle(entityState) {
    var targetLabel = entityState.target?.relativePath || entityState.rootLabel || 'Drill-down';
    return (entityState.target?.kind === 'file' ? 'File: ' : 'Folder: ') + targetLabel;
  }

  function isHierarchical(chartId) {
    var mapping = root.CodeXRMappingUiRuntime;
    return typeof mapping?.isHierarchicalChart === 'function' ? mapping.isHierarchicalChart(chartId) : chartId === 'boats';
  }

  /**
   * Draws the entity's dataset. Same target and chart: only the producer's
   * url changes (Babia re-reads and the chart updates in place). Anything
   * else: the root is rebuilt from scratch.
   */
  function renderView(entityState) {
    if (!entityState?.datasetUrl) { return false; }
    var key = [entityState.target?.kind, entityState.target?.relativePath, entityState.chartId, entityState.treeField,
      JSON.stringify(entityState.mapping || {})].join('|');
    if (refs.viewRoot && refs.viewRoot.isConnected !== false && state.viewKey === key && refs.data) {
      if (state.viewRevision !== entityState.revision) {
        state.viewRevision = entityState.revision;
        setDeclarative(refs.data, 'babia-queryjson', serialize({ url: entityState.datasetUrl }));
      }
      return true;
    }
    removeView();
    var viewRoot = ensureViewRoot();
    var mappingRuntime = root.CodeXRMappingUiRuntime;
    var chartId = String(entityState.chartId || 'boats');
    var generation = state.buildGeneration;
    state.viewKey = key;
    state.viewRevision = entityState.revision;

    refs.data = entity('a-entity', { id: DATA_ID, 'data-codexr-role': 'drill-down datasource' });
    setDeclarative(refs.data, 'babia-queryjson', serialize({ url: entityState.datasetUrl }));
    viewRoot.appendChild(refs.data);

    var sourceId = DATA_ID;
    if (isHierarchical(chartId)) {
      refs.tree = mappingRuntime?.buildDeclarativeTreeEntity?.({
        entityId: TREE_ID, sourceId: DATA_ID, field: entityState.treeField || 'filePath', splitBy: '/'
      }) || null;
      if (refs.tree) {
        refs.tree.setAttribute('data-codexr-role', 'drill-down treebuilder');
        viewRoot.appendChild(refs.tree);
        scopeTreeOutput(refs.tree, generation, 0);
        sourceId = TREE_ID;
      }
    } else {
      // Flat charts read the row-budgeted slice, like the classic analysis.
      var slice = mappingRuntime?.prepareChartDataSlice?.(DATA_ID, chartId, entityState.mapping || {});
      if (slice?.id) { sourceId = slice.id; }
    }

    refs.chart = mappingRuntime?.buildDeclarativeChartEntity?.({
      entityId: CHART_ID,
      chartId: chartId,
      sourceId: sourceId,
      mapping: Object.assign({}, entityState.mapping || {}),
      title: chartTitle(entityState),
      containmentProfile: containmentProfile(),
      role: 'drill-down chart',
      applyTransform: true,
      applyInitialScale: true
    }) || null;
    if (!refs.chart) {
      showError('This scene cannot draw a ' + chartId + ' chart for the drill-down.');
      return false;
    }
    viewRoot.appendChild(refs.chart);
    return true;
  }

  function showDrilledView() {
    if (!state.entity?.datasetUrl) { return false; }
    parkClassic();
    return renderView(state.entity);
  }
