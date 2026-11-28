
    // Debug mode - set to true to trace live reload in the browser console.
    // Same convention as the LivePanel scripts (DEBUG_MODE + debugLog), with
    // page-unique names: this is a classic script sharing the page's global scope.
    const LIVE_RELOAD_DEBUG_MODE = false;

    function liveReloadDebugLog(...args) {
      if (LIVE_RELOAD_DEBUG_MODE) {
        console.log(...args);
      }
    }

    function hasOfflineExportMarker() {
      try {
        const node = document.getElementById('codexr-tooling-config-virtual-screen');
        const config = JSON.parse(node && node.textContent ? node.textContent : '{}');
        return config.offlineExport === true;
      } catch (_error) {
        return false;
      }
    }

    const liveReloadDisabled = hasOfflineExportMarker();
    // The live channel (CodeXRLiveChannel, templates/components/live/liveChannel.js,
    // bundled ahead of this script): one WebSocket to /codexr-live that
    // reconnects with back-off and reports missed updates (onResync).
    let liveChannel = null;
    let isXRMode = false;

    if (liveReloadDisabled) {
      liveReloadDebugLog(' Offline export detected: live reload disabled.');
    } else {
      liveReloadDebugLog(' Setting up the live channel for unified live reload...');
      // Defensive compatibility for copies produced before the synchronous
      // marker existed. Current exports never open the channel in the first
      // place; older ones still close it as soon as their manifest is found.
      fetch('./codexr-export-manifest.json', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((manifest) => {
          if (manifest && manifest.kind === 'codexr-export') {
            liveReloadDebugLog(' Offline export detected: live reload disabled.');
            stopLiveReload();
          }
        })
        .catch(() => {});
    }
    const CHART_COMPONENT_TYPES = [
      'babia-bars',
      'babia-barsmap',
      'babia-boats',
      'babia-cyls',
      'babia-cylsmap',
      'babia-pie',
      'babia-doughnut',
      'babia-bubbles'
    ];

    function getNormalRefreshRuntime() {
      return window.CodeXRNormalAnalysisRefreshRuntime || {
        begin: function () { return Date.now(); },
        complete: function () {}
      };
    }

    async function completeNormalRefresh(generation, reason, chartEntities) {
      const chartIds = (chartEntities || [])
        .map(chart => chart && chart.id)
        .filter(Boolean);
      if (chartIds.length && window.CodeXRAnalysisTableRuntime?.waitForChartsStable) {
        await window.CodeXRAnalysisTableRuntime.waitForChartsStable(chartIds, {
          timeoutMs: 8000,
          pollMs: 100,
          stablePasses: 2
        });
      }
      getNormalRefreshRuntime().complete(generation);
      document.dispatchEvent(new CustomEvent('codexr-normal-analysis-refreshed', {
        detail: { generation: generation, reason: reason }
      }));
    }

    // Check if we're in an A-Frame scene
    function checkXRMode() {
      isXRMode = !!document.querySelector('a-scene');
      liveReloadDebugLog(isXRMode ? ' XR mode detected' : ' Standard mode detected');
      return isXRMode;
    }

    document.addEventListener('DOMContentLoaded', checkXRMode);

    function getChartEntities() {
      const unique = new Set();
      CHART_COMPONENT_TYPES.forEach(type => {
        document.querySelectorAll('[' + type + ']').forEach(chartEntity => unique.add(chartEntity));
      });
      return Array.from(unique);
    }

    function hasBoatsChart(chartEntities) {
      return chartEntities.some(chartEntity => chartEntity && chartEntity.hasAttribute && (
        chartEntity.hasAttribute('babia-boats')
      ));
    }

    function restoreXrUiState(mappingUiRuntime, mappingUiState, chartDebugRuntime, chartDebugState) {
      // Re-applies the mapping on screen to the rebuilt charts. It reads the
      // mapping NOW, not the copy taken when the update arrived: a remap made
      // in between (or one still being validated) used to be silently
      // reverted to the mapping of a moment ago (CHARTS-12).
      const pendingRemap = mappingUiRuntime
        && typeof mappingUiRuntime.hasPendingMapping === 'function'
        && mappingUiRuntime.hasPendingMapping();
      const currentState = mappingUiRuntime && typeof mappingUiRuntime.getState === 'function'
        ? mappingUiRuntime.getState()
        : mappingUiState;
      if (!pendingRemap && mappingUiRuntime && currentState && typeof mappingUiRuntime.restoreState === 'function') {
        mappingUiRuntime.restoreState(currentState);
      }
      if (chartDebugRuntime && chartDebugState && typeof chartDebugRuntime.restoreState === 'function') {
        chartDebugRuntime.restoreState(chartDebugState);
      }
    }

    function renormalizeChartContainment(reason, mappingUiRuntime) {
      const analysisTableRuntime = window.CodeXRAnalysisTableRuntime;
      if (analysisTableRuntime && typeof analysisTableRuntime.renormalizeAll === 'function') {
        const updated = analysisTableRuntime.renormalizeAll(reason);
        if (updated > 0) {
          liveReloadDebugLog('[CodeXR] Re-normalized chart containment:', updated);
        }
      }

      if (mappingUiRuntime && typeof mappingUiRuntime.refreshAdaptivePlacement === 'function') {
        mappingUiRuntime.refreshAdaptivePlacement();
      }
    }

    // Live-reload connection state, readable by the scene and by tests:
    // 'connecting' | 'open' | 'reconnecting' | 'disabled'.
    function setLiveReloadStatus(status) {
      window.__CODEXR_LIVE_RELOAD_STATUS__ = status;
      try {
        document.dispatchEvent(new CustomEvent('codexr-live-reload-status', { detail: { status: status } }));
      } catch (_error) {
        // CustomEvent is missing only in non-browser hosts.
      }
    }

    function stopLiveReload() {
      if (liveChannel) {
        liveChannel.close();
        liveChannel = null;
      }
      setLiveReloadStatus('disabled');
    }

    function handleLiveMessage(message) {
      switch (message.type) {
        case 'analysis-updated':
          handleAnalysisUpdated(message);
          break;
        case 'dataRefresh':
          handleDataRefresh(message);
          break;
        default:
          liveReloadDebugLog(' Live message ignored:', message.type);
      }
    }

    // Opens the live channel and binds every handler to it. Reconnects,
    // back-off and the half-open watchdog belong to the shared runtime; a
    // reconnect that missed an update refreshes the data once (resync).
    function connectLiveReload() {
      if (!window.CodeXRLiveChannel) {
        console.warn('[CodeXR] live channel runtime missing; live reload disabled');
        setLiveReloadStatus('disabled');
        return null;
      }
      liveChannel = window.CodeXRLiveChannel.connect({
        onMessage: handleLiveMessage,
        onStatus: setLiveReloadStatus,
        onResync: function (greeting) {
          liveReloadDebugLog(' Live channel resync after a reconnect');
          handleDataRefresh(greeting);
        }
      });
      return liveChannel;
    }

    // --- Data-source cache busting -------------------------------------
    // A babia-queryjson value is either the parsed object ({ url, ... }) or,
    // before A-Frame initialised the component, the raw declaration string
    // ("url: ./data.json; ..."). Both forms are read the same way, and any
    // "url:" prefix that leaked into the url itself is stripped, which also
    // heals a value already corrupted to "url: url: ./data.json".
    function readQueryJsonUrl(value) {
      let raw = '';
      if (typeof value === 'string') {
        const match = /(?:^|;)\s*url\s*:\s*([^;]*)/.exec(value);
        raw = match ? match[1] : '';
      } else if (value && typeof value.url === 'string') {
        raw = value.url;
      }
      raw = raw.trim();
      while (/^url\s*:/i.test(raw)) {
        raw = raw.replace(/^url\s*:\s*/i, '');
      }
      return raw.trim();
    }

    // Sets one query parameter and keeps every other one (comparison sources
    // carry ?revision=, which the old split('?')[0] dropped).
    function withQueryParam(url, key, value) {
      const hashIndex = url.indexOf('#');
      const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
      const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
      const queryIndex = withoutHash.indexOf('?');
      const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
      const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '');
      params.set(key, String(value));
      return base + '?' + params.toString() + hash;
    }

    function isDerivedDataSource(dataEntity) {
      // The row-budgeted chart slices hold inline data fed by their producer;
      // they have no URL of their own to refresh.
      const id = dataEntity && dataEntity.id ? String(dataEntity.id) : '';
      return id.indexOf('codexrChartDataSlice__') === 0;
    }

    // Cache-busts one data source. Returns false when the entity has no URL
    // to refresh (inline data, chart slices), so it is left untouched.
    function bustDataSource(dataEntity, timestamp) {
      if (!dataEntity || typeof dataEntity.getAttribute !== 'function' || isDerivedDataSource(dataEntity)) {
        return false;
      }
      const queryjson = dataEntity.getAttribute('babia-queryjson');
      if (!queryjson) {
        return false;
      }
      const currentUrl = readQueryJsonUrl(queryjson);
      if (!currentUrl) {
        return false;
      }
      const nextUrl = withQueryParam(currentUrl, 't', timestamp);
      if (typeof queryjson === 'string') {
        const rest = queryjson.split(';')
          .map(part => part.trim())
          .filter(part => part && !/^url\s*:/i.test(part));
        dataEntity.setAttribute('babia-queryjson', ['url: ' + nextUrl].concat(rest).join('; '));
      } else {
        dataEntity.setAttribute('babia-queryjson', Object.assign({}, queryjson, { url: nextUrl }));
      }
      return true;
    }

    // Handle analysis-updated events
    function handleAnalysisUpdated(event) {
      liveReloadDebugLog(' Received analysis-updated event:', event);

      // Find data entities using all provided selectors
      let dataEntities = [];
      
      dataEntities = [...dataEntities, ...document.querySelectorAll('#data')];
      dataEntities = [...dataEntities, ...document.querySelectorAll('[babia-queryjson]')];
      
      const chartEntities = getChartEntities();
      const containsBoatsChart = hasBoatsChart(chartEntities);
      const refreshGeneration = getNormalRefreshRuntime().begin('analysis-updated');

      // Preserve custom mapping UI state across chart component rebuilds
      const mappingUiRuntime = window.CodeXRMappingUiRuntime;
      const mappingUiState = mappingUiRuntime && typeof mappingUiRuntime.getState === 'function'
        ? mappingUiRuntime.getState()
        : null;
      const chartDebugRuntime = window.CodeXRChartDebug;
      const chartDebugState = chartDebugRuntime && typeof chartDebugRuntime.getState === 'function'
        ? chartDebugRuntime.getState()
        : null;

      if (dataEntities.length > 0) {
        const timestamp = Date.now();
        liveReloadDebugLog(' Refreshing ' + dataEntities.length + ' data entities');
        
        // Update each data entity (once, even when it matches both selectors)
        Array.from(new Set(dataEntities)).forEach(dataEntity => {
          if (bustDataSource(dataEntity, timestamp)) {
            // Trigger data refresh event after a short delay
            setTimeout(() => {
              dataEntity.emit('data-loaded', {});
              liveReloadDebugLog(' Data entity refreshed');
            }, 100);
          }
        });

        // Let Babia rebuild from refreshed data/tree sources and only renormalize after the source pipeline settles.
        setTimeout(() => {
          restoreXrUiState(mappingUiRuntime, mappingUiState, chartDebugRuntime, chartDebugState);
          renormalizeChartContainment('analysis-updated', mappingUiRuntime);
        }, 260);

        if (containsBoatsChart) {
          setTimeout(() => {
            restoreXrUiState(mappingUiRuntime, mappingUiState, chartDebugRuntime, chartDebugState);
            renormalizeChartContainment('analysis-updated-boats-settled', mappingUiRuntime);
            void completeNormalRefresh(
              refreshGeneration,
              'analysis-updated-boats-settled',
              chartEntities
            );
          }, 900);
        } else {
          setTimeout(() => {
            void completeNormalRefresh(refreshGeneration, 'analysis-updated', chartEntities);
          }, 300);
        }
      } else {
        console.warn(' No data entities found for refresh');
      }
      if (dataEntities.length === 0) {
        void completeNormalRefresh(refreshGeneration, 'analysis-updated-no-data', chartEntities);
      }
    }


    // Handle dataRefresh events
    function handleDataRefresh(event) {
      liveReloadDebugLog(' Received dataRefresh event:', event);
      liveReloadDebugLog(' Reloading data.json for XR chart refresh...');
      
      // Simple approach: just reload the data entities with cache busting
      // A-Frame will automatically re-render charts with fresh data
      const dataEntities = document.querySelectorAll('[babia-queryjson]');
      const refreshGeneration = getNormalRefreshRuntime().begin('dataRefresh');
      
      if (dataEntities.length > 0) {
        const timestamp = Date.now();
        liveReloadDebugLog(' Refreshing ' + dataEntities.length + ' data entities with cache busting');
        
        dataEntities.forEach(dataEntity => {
          // Simple cache busting - let A-Frame handle the rest
          if (bustDataSource(dataEntity, timestamp)) {
            liveReloadDebugLog(' Data entity refreshed with cache busting');
          }
        });

        const chartEntities = getChartEntities();
        const containsBoatsChart = hasBoatsChart(chartEntities);

        setTimeout(() => {
          renormalizeChartContainment('dataRefresh', window.CodeXRMappingUiRuntime);
        }, 240);

        if (containsBoatsChart) {
          setTimeout(() => {
            renormalizeChartContainment('dataRefresh-boats-settled', window.CodeXRMappingUiRuntime);
            void completeNormalRefresh(
              refreshGeneration,
              'dataRefresh-boats-settled',
              chartEntities
            );
          }, 900);
        } else {
          setTimeout(() => {
            void completeNormalRefresh(refreshGeneration, 'dataRefresh', chartEntities);
          }, 300);
        }
        
        liveReloadDebugLog(' XR data refresh completed - A-Frame will handle chart updates');
      } else {
        console.warn(' No babia-queryjson data entities found for refresh');
      }
      if (dataEntities.length === 0) {
        void completeNormalRefresh(refreshGeneration, 'dataRefresh-no-data', []);
      }
    }


    if (liveReloadDisabled) {
      setLiveReloadStatus('disabled');
    } else {
      connectLiveReload();
    }
