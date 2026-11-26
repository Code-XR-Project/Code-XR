// == dependencyGraphRuntime.js | datasetProjection (assembled per manifest.json; see COMPONENTS.md) ==
  function getNormalVisualizationRoots() {
    var document = doc();
    if (!document) { return []; }
    var cfg = config();
    var roots = [];
    collectConfiguredIds(cfg, [
      'normalEntityIds',
      'visualizationEntityIds',
      'chartEntityIds',
      'chartEntityId',
      'chartId'
    ]).forEach(function (id) {
      var element = document.getElementById?.(id);
      if (element) { roots.push(element); }
    });
    if (cfg?.chartSelector && typeof document.querySelector === 'function') {
      var selected = document.querySelector(cfg.chartSelector);
      if (selected) { roots.push(selected); }
    }
    document.querySelectorAll?.('[data-codexr-normal-root="true"], [data-codexr-normal-visualization="true"]')
      .forEach(function (element) { roots.push(element); });
    return uniqueElements(roots);
  }
  // A-Frame's raycaster still intersects entities hidden via `visible`, so a
  // parked chart must also give up its raycast classes or its invisible nodes
  // keep stealing clicks from the graph. Suspended classes are marked on the
  // element and restored verbatim (same contract as the historical-comparison
  // and analysis-mode runtimes).
  var RAYCAST_SUSPENDED_ATTR = 'data-codexr-raycast-suspended';
  // The documented render budget (DEPGRAPH-5): one entity per node, so a root
  // with thousands of externals stalled a standalone headset.
  var RENDER_BUDGET = { nodes: 600, edges: 2000 };
  var BUDGET_REST_ID = 'scope:budget-rest';
  function suspendSubtreeRaycast(rootElement) {
    if (!rootElement) { return; }
    var suspend = function (element) {
      if (!element?.classList?.contains(RAYCAST_CLASS)) { return; }
      element.classList.remove(RAYCAST_CLASS);
      element.setAttribute(RAYCAST_SUSPENDED_ATTR, 'true');
    };
    suspend(rootElement);
    rootElement.querySelectorAll?.('.' + RAYCAST_CLASS).forEach(suspend);
  }
  function restoreSubtreeRaycast(rootElement) {
    if (!rootElement) { return; }
    var restore = function (element) {
      element.classList?.add(RAYCAST_CLASS);
      element.removeAttribute?.(RAYCAST_SUSPENDED_ATTR);
    };
    if (rootElement.getAttribute?.(RAYCAST_SUSPENDED_ATTR) === 'true') { restore(rootElement); }
    rootElement.querySelectorAll?.('[' + RAYCAST_SUSPENDED_ATTR + '="true"]').forEach(restore);
  }
  function parkOriginal() {
    var surface = root.CodeXRAnalysisSurfaceRuntime;
    if (surface?.setNormalVisible) {
      surface.setNormalVisible(false);
      state.originalRoots = [];
      return;
    }
    var roots = getNormalVisualizationRoots();
    if (!roots.length) { return; }
    state.originalRoots = roots;
    roots.forEach(function (element) {
      suspendSubtreeRaycast(element);
      element.setAttribute?.('visible', false);
      if (element.object3D) { element.object3D.visible = false; }
    });
  }
  function restoreOriginal() {
    var surface = root.CodeXRAnalysisSurfaceRuntime;
    if (surface?.setNormalVisible && root.CodeXRAnalysisModeRuntime?.getState?.().mode === 'single') {
      surface.setNormalVisible(true);
      return;
    }
    if (!state.originalRoots.length) { return; }
    if (root.CodeXRAnalysisModeRuntime?.getState?.().mode === 'single') {
      state.originalRoots.forEach(function (element) {
        element.setAttribute?.('visible', true);
        if (element.object3D) { element.object3D.visible = true; }
        restoreSubtreeRaycast(element);
      });
    } else {
      state.originalRoots.forEach(restoreSubtreeRaycast);
    }
    state.originalRoots = [];
  }
  function removeGraph() {
    refs.graph?.components?.[COMPONENT]?.disposeView?.();
    refs.graph?.remove?.();
    refs.graph = null;
  }
  function clearRenderRetries() {
    state.retryTimers.forEach(function (timer) { root.clearTimeout?.(timer); });
    state.retryTimers.clear();
  }
  // DEPGRAPH-7: shown when a click arrives while the lock is held.
  var BUSY_STATUS_MESSAGE = 'Busy, please wait...';
  function setTransitionLocked(locked, message) {
    state.transitionLocked = !!locked;
    if (message) {
      setStatus(message, false);
    } else if (!locked && state.busyStatusShown) {
      setStatus('', false);
    }
    // The lock is a promise of a server answer; if none arrives the watchdog
    // releases it with a visible error instead of eating every later click.
    if (state.transitionLockTimer) {
      clearTimeout(state.transitionLockTimer);
      state.transitionLockTimer = null;
    }
    if (state.transitionLocked) {
      state.transitionLockTimer = setTimeout(function () {
        state.transitionLockTimer = null;
        if (state.transitionLocked) {
          state.transitionLocked = false;
          setStatus('The dependency analysis did not respond. Try again.', true);
          if (root.CodeXRAnalysisModeRuntime?.getState?.()?.mode === 'selection') {
            root.CodeXRAnalysisModeRuntime.setSelectorStatus?.('The dependency analysis did not respond. Try again.', 'error');
          }
          root.console?.warn?.('[CodeXR][DependencyGraph] dependency-graph-start received no response within 20s.');
        }
      }, 20000);
      state.transitionLockTimer?.unref?.();
    }
  }
  function disposeView() {
    state.active = false;
    state.viewGeneration += 1;
    state.datasetLoadGeneration += 1;
    clearRenderRetries();
    removeGraph();
    restoreOriginal();
    setTransitionLocked(false);
  }
  function isDependencyModeActiveOrActivating() {
    var modeState = root.CodeXRAnalysisModeRuntime?.getState?.();
    if (modeState?.transitioning) {
      return modeState?.pendingTransitionMode === 'dependency-graph';
    }
    return modeState?.mode === 'dependency-graph';
  }

  // intensityBucket / edgeStyle live in edgeEncoding.js (shared IIFE scope).

  function graphDensityStats(dataset) {
    var nodes = Array.isArray(dataset?.nodes) ? dataset.nodes : [];
    var edges = Array.isArray(dataset?.edges) ? dataset.edges : [];
    var degree = {};
    edges.forEach(function (edge) {
      degree[edge.source] = Number(degree[edge.source] || 0) + 1;
      degree[edge.target] = Number(degree[edge.target] || 0) + 1;
    });
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      maxDegree: Math.max.apply(Math, Object.values(degree).concat([0]))
    };
  }

  function setDetailOverride(nextOverride) {
    root.CodeXRDependencyVisualBudgetRuntime?.setOverride?.(nextOverride);
    refs.graph?.components?.[COMPONENT]?.refreshVisualBudget?.();
    renderControls();
  }

  function mergeConfidence(current, next) {
    var rank = { exact: 0, probable: 1, ambiguous: 2 };
    return (rank[next] || 0) > (rank[current] || 0) ? next : current;
  }

  function buildExternalSummaryDataset(dataset) {
    var source = dataset || { nodes: [], edges: [] };
    var externalIds = new Set((source.nodes || []).filter(function (node) {
      return node.external;
    }).map(function (node) { return node.id; }));
    if (!externalIds.size) { return source; }

    var internalNodes = (source.nodes || []).filter(function (node) { return !node.external; });
    var internalIds = new Set(internalNodes.map(function (node) { return node.id; }));
    var externalEdges = (source.edges || []).filter(function (edge) {
      return externalIds.has(edge.source) || externalIds.has(edge.target);
    });
    if (!externalEdges.length) {
      return Object.assign({}, source, {
        nodes: internalNodes,
        edges: (source.edges || []).filter(function (edge) {
          return internalIds.has(edge.source) && internalIds.has(edge.target);
        })
      });
    }

    var packages = {};
    (source.nodes || []).filter(function (node) { return node.external; }).forEach(function (node) {
      packages[node.id] = node.label || node.id;
    });
    var relationKinds = {};
    var edgeMap = {};
    var totalOccurrences = 0;
    externalEdges.forEach(function (edge) {
      var internalId = externalIds.has(edge.source) ? edge.target : edge.source;
      if (!internalIds.has(internalId)) { return; }
      var outgoing = !externalIds.has(edge.source);
      var sourceId = outgoing ? internalId : EXTERNAL_SUMMARY_ID;
      var targetId = outgoing ? EXTERNAL_SUMMARY_ID : internalId;
      var key = sourceId + '|' + targetId + '|' + edge.kind;
      var occurrences = Math.max(1, Number(edge.occurrences || 1));
      relationKinds[edge.kind] = Number(relationKinds[edge.kind] || 0) + occurrences;
      totalOccurrences += occurrences;
      if (!edgeMap[key]) {
        edgeMap[key] = Object.assign({}, edge, {
          id: 'external-summary-edge:' + key,
          source: sourceId,
          target: targetId,
          occurrences: 0,
          confidence: edge.confidence || 'probable',
          syntheticExternal: true
        });
      }
      edgeMap[key].occurrences += occurrences;
      edgeMap[key].confidence = mergeConfidence(edgeMap[key].confidence, edge.confidence || 'probable');
    });

    var packageCounts = {};
    externalEdges.forEach(function (edge) {
      var externalId = externalIds.has(edge.source) ? edge.source : edge.target;
      var label = packages[externalId] || externalId;
      packageCounts[label] = Number(packageCounts[label] || 0) + Number(edge.occurrences || 1);
    });
    var topPackages = Object.keys(packageCounts).sort(function (a, b) {
      return packageCounts[b] - packageCounts[a] || a.localeCompare(b);
    }).slice(0, 3);
    var summaryNode = {
      id: EXTERNAL_SUMMARY_ID,
      kind: 'external-summary',
      label: 'External dependencies',
      external: true,
      syntheticExternal: true,
      metrics: {
        totalLines: 0,
        fanIn: 0,
        fanOut: 0,
        degree: externalEdges.length,
        dependentCount: 0,
        cycleSize: 0,
        relationCount: totalOccurrences
      },
      summary: {
        packageCount: externalIds.size,
        relationCount: totalOccurrences,
        topPackages: topPackages,
        relationKinds: relationKinds
      }
    };
    var internalEdges = (source.edges || []).filter(function (edge) {
      return internalIds.has(edge.source) && internalIds.has(edge.target);
    });
    return Object.assign({}, source, {
      nodes: internalNodes.concat([summaryNode]),
      edges: internalEdges.concat(Object.values(edgeMap))
    });
  }

  function normalizeRelativePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '')
      .replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  }
  function directoryName(value) {
    var normalized = normalizeRelativePath(value);
    var index = normalized.lastIndexOf('/');
    return index < 0 ? '' : normalized.slice(0, index);
  }
  function createAggregateNode(id, label, navigationPath, syntheticKind) {
    return {
      id: id, kind: 'group', label: label, relativePath: navigationPath,
      navigationPath: navigationPath, syntheticKind: syntheticKind,
      external: false,
      metrics: {
        totalLines: 0, fanIn: 0, fanOut: 0, degree: 0,
        dependentCount: 0, cycleSize: 0, relationCount: 0, files: 0
      }
    };
  }
  // A folder card describes the folder, not the sum of its files' cards
  // (DEPGRAPH-1). Only lines and file counts add up; `cycleSize` on an
  // aggregate counts its files that sit in a dependency cycle. The graph
  // metrics come from the edges drawn to the box, in aggregateMetricsFromEdges.
  function addNodeMetrics(target, source) {
    target.metrics.totalLines += Number(source?.metrics?.totalLines || 0);
    target.metrics.files += 1;
    if (Number(source?.metrics?.cycleSize || 0) > 1) { target.metrics.cycleSize += 1; }
  }
  /**
   * Fan-in, fan-out, degree and relations of every aggregate node, from the
   * edges actually drawn: distinct neighbours in and out, and edge records
   * touching the box. Run after the relation and external filters, so a card
   * matches what is on the table.
   */
  function aggregateMetricsFromEdges(nodes, edges) {
    var aggregates = {};
    nodes.forEach(function (node) {
      if (node.kind === 'group' && node.metrics) { aggregates[node.id] = { into: new Set(), out: new Set(), relations: 0 }; }
    });
    edges.forEach(function (edge) {
      if (aggregates[edge.source]) {
        aggregates[edge.source].out.add(edge.target);
        aggregates[edge.source].relations += 1;
      }
      if (aggregates[edge.target] && edge.target !== edge.source) {
        aggregates[edge.target].into.add(edge.source);
        aggregates[edge.target].relations += 1;
      }
    });
    return nodes.map(function (node) {
      var counts = aggregates[node.id];
      if (!counts) { return node; }
      var neighbours = new Set(Array.from(counts.into).concat(Array.from(counts.out)));
      return Object.assign({}, node, {
        metrics: Object.assign({}, node.metrics, {
          fanIn: counts.into.size, fanOut: counts.out.size, degree: neighbours.size,
          dependentCount: counts.into.size, relationCount: counts.relations
        })
      });
    });
  }
  function aggregateProjectedEdges(edges, membership, visibleIds) {
    var edgeMap = {};
    (edges || []).forEach(function (edge) {
      var source = membership[edge.source] || edge.source;
      var target = membership[edge.target] || edge.target;
      if (!visibleIds.has(source) || !visibleIds.has(target) || source === target) { return; }
      var key = source + '|' + target + '|' + edge.kind;
      if (!edgeMap[key]) {
        edgeMap[key] = Object.assign({}, edge, {
          id: 'scope-edge:' + key, source: source, target: target, occurrences: 0
        });
      }
      edgeMap[key].occurrences += Math.max(1, Number(edge.occurrences || 1));
      edgeMap[key].confidence = mergeConfidence(
        edgeMap[key].confidence || 'exact', edge.confidence || 'probable'
      );
    });
    return Object.values(edgeMap);
  }
  function projectDirectoryScope(dataset, scopePath) {
    var current = normalizeRelativePath(scopePath);
    var prefix = current ? current + '/' : '';
    var parentPath = directoryName(current);
    var parentId = 'scope:parent:' + (current || 'root');
    var nodes = [];
    var membership = {};
    var aggregates = {};
    if (current) {
      aggregates[parentId] = createAggregateNode(parentId, '..', parentPath, 'parent');
      nodes.push(aggregates[parentId]);
    }
    (dataset.nodes || []).filter(function (node) {
      return !node.external && node.kind === 'file';
    }).forEach(function (node) {
      var relative = normalizeRelativePath(node.relativePath || node.label);
      var directParent = directoryName(relative);
      if (directParent === current) {
        membership[node.id] = node.id;
        nodes.push(Object.assign({}, node));
        return;
      }
      if (relative.indexOf(prefix) === 0) {
        var remainder = relative.slice(prefix.length);
        if (remainder.indexOf('/') >= 0) {
          var childName = remainder.split('/')[0];
          var childPath = prefix + childName;
          var childId = 'scope:directory:' + childPath;
          if (!aggregates[childId]) {
            aggregates[childId] = createAggregateNode(childId, childName, childPath, 'directory');
            nodes.push(aggregates[childId]);
          }
          membership[node.id] = childId;
          addNodeMetrics(aggregates[childId], node);
          return;
        }
      }
      if (current) {
        membership[node.id] = parentId;
        addNodeMetrics(aggregates[parentId], node);
      }
    });
    (dataset.nodes || []).filter(function (node) { return node.external; }).forEach(function (node) {
      membership[node.id] = node.id;
      nodes.push(Object.assign({}, node));
    });
    var visibleIds = new Set(nodes.map(function (node) { return node.id; }));
    return Object.assign({}, dataset, {
      nodes: nodes,
      edges: aggregateProjectedEdges(dataset.edges, membership, visibleIds),
      scopeLabel: current || '(project root)'
    });
  }
  function projectFileScope(dataset) {
    var internalSummaryId = 'codexr:internal-files-summary';
    var symbols = (dataset.nodes || []).filter(function (node) {
      return node.kind === 'symbol';
    }).map(function (node) { return Object.assign({}, node); });
    var otherFiles = (dataset.nodes || []).filter(function (node) {
      return !node.external && node.kind === 'file';
    });
    var nodes = symbols.slice();
    var membership = {};
    symbols.forEach(function (node) { membership[node.id] = node.id; });
    if (otherFiles.length) {
      var summary = createAggregateNode(
        internalSummaryId, 'Other project files', '', 'internal-files'
      );
      otherFiles.forEach(function (node) {
        membership[node.id] = internalSummaryId;
        addNodeMetrics(summary, node);
      });
      nodes.push(summary);
    }
    (dataset.nodes || []).filter(function (node) { return node.external; }).forEach(function (node) {
      membership[node.id] = node.id;
      nodes.push(Object.assign({}, node));
    });
    var visibleIds = new Set(nodes.map(function (node) { return node.id; }));
    return Object.assign({}, dataset, {
      nodes: nodes,
      edges: aggregateProjectedEdges(dataset.edges, membership, visibleIds),
      scopeLabel: dataset.targetRelativePath || 'File dependencies'
    });
  }
  /**
   * Keeps the best-connected nodes within RENDER_BUDGET and folds the rest
   * into one "N more" node, then keeps the heaviest edges within the edge
   * budget. `budget` says what was left out, or is null when nothing was.
   */
  function applyRenderBudget(nodes, edges) {
    if (nodes.length <= RENDER_BUDGET.nodes && edges.length <= RENDER_BUDGET.edges) {
      return { nodes: nodes, edges: edges, budget: null };
    }
    var keptNodes = nodes;
    var keptEdges = edges;
    if (nodes.length > RENDER_BUDGET.nodes) {
      var degree = {};
      edges.forEach(function (edge) {
        degree[edge.source] = (degree[edge.source] || 0) + 1;
        degree[edge.target] = (degree[edge.target] || 0) + 1;
      });
      var ranked = nodes.map(function (node, index) { return { node: node, index: index }; })
        .sort(function (a, b) {
          var pinnedA = a.node.syntheticKind || a.node.syntheticExternal ? 1 : 0;
          var pinnedB = b.node.syntheticKind || b.node.syntheticExternal ? 1 : 0;
          return pinnedB - pinnedA || (degree[b.node.id] || 0) - (degree[a.node.id] || 0) || a.index - b.index;
        });
      var kept = ranked.slice(0, RENDER_BUDGET.nodes - 1).map(function (entry) { return entry.node; });
      var folded = ranked.slice(RENDER_BUDGET.nodes - 1).map(function (entry) { return entry.node; });
      var rest = createAggregateNode(BUDGET_REST_ID, folded.length + ' more', '', 'budget-rest');
      var membership = {};
      kept.forEach(function (node) { membership[node.id] = node.id; });
      folded.forEach(function (node) { membership[node.id] = BUDGET_REST_ID; addNodeMetrics(rest, node); });
      keptNodes = kept.concat([rest]);
      keptEdges = aggregateProjectedEdges(edges, membership, new Set(keptNodes.map(function (node) { return node.id; })));
    }
    if (keptEdges.length > RENDER_BUDGET.edges) {
      keptEdges = keptEdges.slice().sort(function (a, b) {
        return Number(b.occurrences || 1) - Number(a.occurrences || 1) || String(a.id).localeCompare(String(b.id));
      }).slice(0, RENDER_BUDGET.edges);
    }
    return {
      nodes: keptNodes,
      edges: keptEdges,
      budget: { totalNodes: nodes.length, totalEdges: edges.length, shownNodes: keptNodes.length, shownEdges: keptEdges.length }
    };
  }
  function renderBudgetNotice(budget) {
    if (!budget) { return ''; }
    return 'Showing ' + budget.shownNodes + ' of ' + budget.totalNodes + ' nodes and '
      + budget.shownEdges + ' of ' + budget.totalEdges + ' relations (render budget). Open a folder or hide externals for the rest.';
  }
  function filteredDataset() {
    if (!state.snapshot) { return { nodes: [], edges: [] }; }
    var scope = state.snapshot.scope || { kind: 'directory', relativePath: '' };
    var pathKey = normalizeRelativePath(scope.relativePath);
    var selected = scope.kind === 'file'
      ? state.fileDatasets[pathKey] || (state.dataset?.targetType === 'file' ? state.dataset : null)
      : state.projectDataset || (state.dataset?.targetType === 'directory' ? state.dataset : null);
    if (!selected) { return { nodes: [], edges: [] }; }
    var projected = scope.kind === 'file'
      ? projectFileScope(selected)
      : projectDirectoryScope(selected, scope.relativePath);
    var source = state.snapshot.showExternal ? projected : buildExternalSummaryDataset(projected);
    var nodes = (source.nodes || []).filter(function (node) {
      return state.snapshot.showExternal || !node.external || node.syntheticExternal;
    });
    var ids = new Set(nodes.map(function (node) { return node.id; }));
    var edges = (source.edges || []).filter(function (edge) {
      return ids.has(edge.source) && ids.has(edge.target)
        && state.snapshot.relationFilters?.[edge.kind] !== false;
    });
    var budgeted = applyRenderBudget(nodes, edges);
    return {
      nodes: aggregateMetricsFromEdges(budgeted.nodes, budgeted.edges),
      edges: budgeted.edges,
      scopeLabel: projected.scopeLabel,
      budget: budgeted.budget
    };
  }

  function publishState(patch) {
    if (!state.snapshot) { return; }
    if (state.transitionLocked) {
      // DEPGRAPH-7: a click during a re-analysis is still refused, but no
      // longer vanishes without a word.
      setStatus(BUSY_STATUS_MESSAGE, false);
      return;
    }
    state.snapshot = Object.assign({}, state.snapshot, patch || {});
    client()?.sendMessage?.('dependency-graph-settings', {
      layout: state.snapshot.layout,
      showExternal: state.snapshot.showExternal,
      edgeEncoding: state.snapshot.edgeEncoding || 'relation-type',
      flowSize: state.snapshot.flowSize || FLOW_DEFAULTS.flowSize,
      flowSpeed: state.snapshot.flowSpeed || FLOW_DEFAULTS.flowSpeed,
      relationFilters: state.snapshot.relationFilters,
      mapping: state.snapshot.mapping,
      scope: state.snapshot.scope
    });
    renderControls();
    renderGraph();
  }
