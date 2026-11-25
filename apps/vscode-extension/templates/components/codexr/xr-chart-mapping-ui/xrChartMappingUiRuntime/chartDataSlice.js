  // == xrChartMappingUiRuntime.js | chartDataSlice (assembled per manifest.json; see COMPONENTS.md) ==
  //
  // Top-N sliced datasource for row-budgeted charts.
  //
  // The bars/cyls families draw ONE element per data row keyed by the axis
  // label — Babia does not aggregate, and duplicate labels overwrite each
  // other — so a deep analysis (hundreds of rows) turns them into unreadable
  // walls that the table then shrinks to nothing. Charts whose presentation
  // profile declares a rowBudget therefore read from a CodeXR-maintained
  // babia-queryjson entity that carries only the top-N rows, ranked by the
  // field mapped to the profile's orderBy dimension. Boats has no budget (its
  // design is per-file) and keeps the full tree.
  //
  // The slice also honours dimension value rules BY VALUE: rows whose mapped
  // field violates numeric-positive are dropped (babia-cylsmap computes axis
  // lengths with Math.max over radii filtered by `o != ''`, which drops 0 and
  // yields -Infinity axes when any radius is 0 — the "invalid axes" rejection).
  //
  // One slice entity per underlying source (normal analysis: data; historical
  // duals: one per comparison producer). Each slice subscribes to its
  // producer's NotiBuffer, so re-analysis pushes and evolution frame swaps
  // flow through automatically.

  var CHART_DATA_SLICE_PREFIX = 'codexrChartDataSlice__';
  // sourceId -> { el, producer, notiBufferId, rows, lastChartId, lastMapping }
  var chartDataSlices = {};

  function getSliceEntityId(sourceId) {
    return CHART_DATA_SLICE_PREFIX + sourceId;
  }

  function getSourceIdFromSliceId(candidateId) {
    var value = String(candidateId || '');
    return value.indexOf(CHART_DATA_SLICE_PREFIX) === 0
      ? value.slice(CHART_DATA_SLICE_PREFIX.length)
      : null;
  }

  // Mirror of the value rules templateCharts declares per dimension, for
  // scenes whose injected config predates them (and for harnesses without a
  // config). The injected availableCharts always wins when present.
  var DIMENSION_VALUE_RULES_FALLBACK = {
    bars: { height: 'numeric-finite' },
    barsmap: { height: 'numeric-finite' },
    cyls: { height: 'numeric-finite', radius: 'numeric-positive' },
    cylsmap: { height: 'numeric-finite', radius: 'numeric-positive' },
    bubbles: { height: 'numeric-finite', radius: 'numeric-positive' },
    pie: { size: 'numeric-positive' },
    donut: { size: 'numeric-positive' }
  };

  function getChartDimensionDefs(config, chartId) {
    var charts = Array.isArray(config && config.availableCharts) ? config.availableCharts : [];
    for (var i = 0; i < charts.length; i += 1) {
      if (charts[i] && charts[i].id === chartId) {
        return Array.isArray(charts[i].dimensions) ? charts[i].dimensions : [];
      }
    }
    var fallbackRules = DIMENSION_VALUE_RULES_FALLBACK[chartId] || {};
    return Object.keys(fallbackRules).map(function (dimensionId) {
      return { id: dimensionId, valueRule: fallbackRules[dimensionId] };
    });
  }

  function computeChartDataSlice(chartId, rows, mappingSnapshot) {
    var profile = getChartPresentation(chartId);
    var budget = Number(profile.rowBudget);
    if (!Array.isArray(rows) || !isFinite(budget) || budget <= 0) {
      return Array.isArray(rows) ? rows : [];
    }
    var mapping = mappingSnapshot || {};
    var dimensionDefs = getChartDimensionDefs(getConfig(), chartId);

    var filtered = rows.filter(function (row) {
      if (!row || typeof row !== 'object') {
        return false;
      }
      for (var i = 0; i < dimensionDefs.length; i += 1) {
        var dimension = dimensionDefs[i];
        var field = dimension && mapping[dimension.id];
        if (!field || !dimension.valueRule) {
          continue;
        }
        var value = Number(row[field]);
        if (dimension.valueRule === 'numeric-positive' && !(isFinite(value) && value > 0)) {
          return false;
        }
        if (dimension.valueRule === 'numeric-finite' && !isFinite(value)) {
          return false;
        }
      }
      return true;
    });

    var orderField = profile.orderBy ? mapping[profile.orderBy] : null;
    if (orderField) {
      // Stable rank by the mapped magnitude, largest first: the slice keeps
      // the rows the chart is most likely being asked about.
      filtered = filtered
        .map(function (row, index) { return { row: row, index: index }; })
        .sort(function (a, b) {
          var left = Number(a.row[orderField]);
          var right = Number(b.row[orderField]);
          var leftRank = isFinite(left) ? left : -Infinity;
          var rightRank = isFinite(right) ? right : -Infinity;
          if (leftRank !== rightRank) {
            return rightRank - leftRank;
          }
          return a.index - b.index;
        })
        .map(function (entry) { return entry.row; });
    }

    // Babia keys chart elements by the label values of the keyBy dimensions
    // (babia-name): rows sharing a key collapse onto one element and the
    // later row silently overwrites the earlier one — three same-named
    // vendored files became one corrupted bar. Keep only the highest-ranked
    // row per distinct key combination.
    var keyFields = Array.isArray(profile.keyBy)
      ? profile.keyBy.map(function (dimensionId) { return mapping[dimensionId]; }).filter(Boolean)
      : [];
    if (keyFields.length) {
      var seenKeys = {};
      filtered = filtered.filter(function (row) {
        var key = keyFields.map(function (field) { return String(row[field]); }).join('\u0000');
        if (seenKeys[key]) {
          return false;
        }
        seenKeys[key] = true;
        return true;
      });
    }

    return filtered.slice(0, budget);
  }

  function applyChartDataSliceRows(record) {
    if (!record || !record.el || !Array.isArray(record.rows) || !record.lastChartId) {
      return;
    }
    var sliceRows = computeChartDataSlice(record.lastChartId, record.rows, record.lastMapping);
    try {
      record.el.setAttribute('babia-queryjson', 'data', JSON.stringify(sliceRows));
    } catch (error) {
      console.warn('CODEXR_MAPPING_UI: could not update chart data slice', error);
    }
  }

  function ensureChartDataSlice(sourceId) {
    var document = getDoc();
    var producerEl = document ? document.getElementById(sourceId) : null;
    var producer = producerEl && producerEl.components && producerEl.components['babia-queryjson'];
    var existing = chartDataSlices[sourceId];
    if (existing) {
      // A producer that was removed and rebuilt under the same id (project
      // evolution re-entry) leaves the record subscribed to a dead buffer:
      // the slice would never see the new frames. Re-subscribe instead.
      if (!producer || existing.producer === producer) {
        return existing;
      }
      try {
        existing.producer?.notiBuffer?.unregister?.(existing.notiBufferId);
      } catch (_error) {
        // The old buffer is gone with its entity; nothing to unsubscribe.
      }
      delete chartDataSlices[sourceId];
    }
    if (!producer || !producer.notiBuffer) {
      // Not a queryjson producer (or not initialized yet): nothing to slice.
      return null;
    }
    var sliceEl = document.getElementById(getSliceEntityId(sourceId));
    if (!sliceEl) {
      sliceEl = document.createElement('a-entity');
      sliceEl.id = getSliceEntityId(sourceId);
      (producerEl.parentNode || producerEl.sceneEl || document.body).appendChild(sliceEl);
    }
    var record = {
      el: sliceEl,
      producer: producer,
      notiBufferId: undefined,
      rows: null,
      lastChartId: null,
      lastMapping: null
    };
    // NotiBuffer.register fires immediately when the producer already has
    // data, so `record.rows` is normally populated before this returns; later
    // pushes (re-analysis, evolution frames) recompute the slice in place.
    record.notiBufferId = producer.notiBuffer.register(function (rows) {
      record.rows = Array.isArray(rows) ? rows : [];
      applyChartDataSliceRows(record);
    });
    chartDataSlices[sourceId] = record;
    return record;
  }

  function updateChartDataSlice(sourceId, chartId, mappingSnapshot) {
    var record = ensureChartDataSlice(sourceId);
    if (!record) {
      return false;
    }
    record.lastChartId = chartId;
    record.lastMapping = Object.assign({}, mappingSnapshot || {});
    applyChartDataSliceRows(record);
    return true;
  }

  // Builds (or refreshes) the slice behind a producer for one chart and
  // returns the slice entity, so a caller that mounts its own producer can
  // wait for the slice's babia-queryjson before building the chart on it.
  // Without that wait the first build falls back to the raw source, which for
  // project evolution meant every frame rendered every row (CHARTS-8).
  function prepareChartDataSlice(sourceId, chartId, mappingSnapshot) {
    if (!sourceId || !getChartPresentation(chartId).rowBudget) {
      return null;
    }
    var underlyingSourceId = getSourceIdFromSliceId(sourceId) || sourceId;
    if (!updateChartDataSlice(underlyingSourceId, chartId, mappingSnapshot)) {
      return null;
    }
    return chartDataSlices[underlyingSourceId].el;
  }

  // Called while building a chart's component data: budgeted charts are
  // redirected to their source's slice entity; everything else (boats' tree,
  // unknown producers) keeps the original source untouched.
  function resolveChartDataSourceId(chartId, sourceId, mappingSnapshot) {
    var profile = getChartPresentation(chartId);
    if (!profile.rowBudget || !sourceId) {
      return sourceId;
    }
    var underlyingSourceId = getSourceIdFromSliceId(sourceId) || sourceId;
    if (!updateChartDataSlice(underlyingSourceId, chartId, mappingSnapshot)) {
      // Producer not ready yet (bootstrap): keep the raw source for now and
      // re-point once the slice can be built.
      scheduleChartDataSliceSync();
      return underlyingSourceId;
    }
    var record = chartDataSlices[underlyingSourceId];
    var sliceComponent = record.el.components && record.el.components['babia-queryjson'];
    if (!sliceComponent || !sliceComponent.notiBuffer) {
      // The slice entity was created this very tick: A-Frame registers the
      // component instance BEFORE running init(), so `components` may already
      // list babia-queryjson while its notiBuffer does not exist yet. Babia's
      // updateFunction silently skips registration in that window, leaving
      // the chart permanently data-less. Render from the raw source once and
      // re-point when the slice is genuinely live.
      scheduleChartDataSliceSync();
      return underlyingSourceId;
    }
    return getSliceEntityId(underlyingSourceId);
  }

  // Re-points the ACTIVE chart entities at their slice when they still read a
  // raw source that should be budgeted. Used at bootstrap (a generated scene's
  // initial chart carries `from: data` in its HTML) and whenever a slice
  // entity was not yet live at build time.
  function syncActiveChartDataSlice() {
    var config = getConfig();
    // Warm the main slice as soon as the producer is live, whatever chart is
    // active: a budgeted chart built against a slice that does not exist yet
    // falls back to the raw source once, and Babia's keyed element reuse then
    // keeps the raw build's positions when the slice lands.
    ensureChartDataSlice('data');
    var chartId = state.activeChartId || (config && config.chartId) || null;
    if (!chartId || !getChartPresentation(chartId).rowBudget) {
      return true;
    }
    var componentName = COMPONENT_BY_CHART[chartId];
    if (!componentName) {
      return true;
    }
    var mapping = Object.keys(state.selectedByDimension || {}).length
      ? state.selectedByDimension
      : ((config && config.defaultMappingsByChart && config.defaultMappingsByChart[chartId]) || {});
    var synced = true;
    getChartEntities(config).forEach(function (chartEntity) {
      var currentData = chartEntity && typeof chartEntity.getAttribute === 'function'
        ? chartEntity.getAttribute(componentName)
        : null;
      if (!currentData || typeof currentData !== 'object' || !currentData.from) {
        return;
      }
      var currentSource = String(currentData.from);
      var resolved = resolveChartDataSourceId(chartId, currentSource, mapping);
      if (getSourceIdFromSliceId(currentSource) && !getSourceIdFromSliceId(resolved)) {
        // Generated scenes start on the slice (an empty one until `data` has
        // rows). Falling back to the raw source here would bring back the
        // all-rows first build; keep the slice and try again shortly.
        synced = false;
        return;
      }
      if (resolved !== currentSource) {
        chartEntity.setAttribute(componentName, 'from', resolved);
      } else if (!getSourceIdFromSliceId(currentSource)) {
        synced = false;
      }
    });
    return synced;
  }

  var chartDataSliceSyncTimer = null;
  var chartDataSliceSyncAttempts = 0;

  function scheduleChartDataSliceSync() {
    if (chartDataSliceSyncTimer || chartDataSliceSyncAttempts >= 25) {
      return;
    }
    chartDataSliceSyncTimer = root.setTimeout?.(function () {
      chartDataSliceSyncTimer = null;
      chartDataSliceSyncAttempts += 1;
      if (!syncActiveChartDataSlice()) {
        scheduleChartDataSliceSync();
      }
    }, 400);
  }

  // Mapping changes ranked/filter fields: recompute the slice content behind
  // every chart entity that reads from one, keeping `from` untouched.
  function refreshChartDataSlicesForMapping(chartEntities, componentName, chartId, mappingSnapshot) {
    (chartEntities || []).forEach(function (chartEntity) {
      var currentData = chartEntity && componentName ? chartEntity.getAttribute(componentName) : null;
      var sourceId = currentData && typeof currentData === 'object'
        ? getSourceIdFromSliceId(currentData.from)
        : null;
      if (sourceId) {
        updateChartDataSlice(sourceId, chartId, mappingSnapshot);
      }
    });
  }
