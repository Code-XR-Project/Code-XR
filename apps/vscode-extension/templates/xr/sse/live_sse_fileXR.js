
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
    const disabledEventSource = {
      close: function () {},
      addEventListener: function () {},
      onopen: null,
      onerror: null,
      onmessage: null
    };
    const eventSource = liveReloadDisabled
      ? disabledEventSource
      : new EventSource('/events');
    let isXRMode = false;

    if (liveReloadDisabled) {
      liveReloadDebugLog(' Offline export detected: live reload disabled.');
    } else {
      liveReloadDebugLog(' Setting up EventSource for unified live reload...');
      // Defensive compatibility for copies produced before the synchronous
      // marker existed. Current exports never open the channel in the first
      // place; older ones still close it as soon as their manifest is found.
      fetch('./codexr-export-manifest.json', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((manifest) => {
          if (manifest && manifest.kind === 'codexr-export') {
            liveReloadDebugLog(' Offline export detected: live reload disabled.');
            eventSource.close();
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
      if (mappingUiRuntime && mappingUiState && typeof mappingUiRuntime.restoreState === 'function') {
        mappingUiRuntime.restoreState(mappingUiState);
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

    eventSource.onopen = function() {
      liveReloadDebugLog(' EventSource connection established');
    };

    eventSource.onerror = function(err) {
      if (liveReloadDisabled) {
        eventSource.close();
        return;
      }
      console.error(' EventSource error:', err);
      // Try to reconnect after a delay
      setTimeout(() => {
        if (liveReloadDisabled) {
          return;
        }
        liveReloadDebugLog(' Attempting to reconnect...');
        eventSource.close();
        new EventSource('/events');
      }, 3000);
    };


    // Handle analysis-updated events
    eventSource.addEventListener('analysis-updated', function(event) {
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
        
        // Update each data entity
        dataEntities.forEach(dataEntity => {
          // Get current attributes
          const queryjson = dataEntity.getAttribute('babia-queryjson');
          if (queryjson) {
            // Add cache busting parameter
            const urlStr = typeof queryjson === 'string' ? queryjson : queryjson.url || '';
            let url = '';
            
            if (typeof urlStr === 'string') {
              url = urlStr.split('?')[0] + '?t=' + timestamp;
            }
            
            // Handle both string and object attributes
            if (typeof queryjson === 'string') {
              dataEntity.setAttribute('babia-queryjson', url);
            } else {
              const newAttr = { ...queryjson };
              newAttr.url = url;
              dataEntity.setAttribute('babia-queryjson', newAttr);
            }
            
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
    });
  

    // Handle dataRefresh events
    eventSource.addEventListener('dataRefresh', function(event) {
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
          const queryjson = dataEntity.getAttribute('babia-queryjson');
          if (queryjson) {
            // Simple cache busting - let A-Frame handle the rest
            const urlStr = typeof queryjson === 'string' ? queryjson : queryjson.url || '';
            let newUrl = '';
            
            if (typeof urlStr === 'string') {
              newUrl = urlStr.split('?')[0] + '?t=' + timestamp;
            }
            
            // Update the data source URL
            if (typeof queryjson === 'string') {
              dataEntity.setAttribute('babia-queryjson', newUrl);
            } else {
              const newAttr = { ...queryjson };
              newAttr.url = newUrl;
              dataEntity.setAttribute('babia-queryjson', newAttr);
            }
            
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
    });
  

    // Handle general reload messages
    eventSource.onmessage = function(event) {
      liveReloadDebugLog('Generic message received:', event.data);
      
      // Skip reload if in XR mode
      if (checkXRMode()) {
        liveReloadDebugLog(' Blocking page reload in XR mode');
        return false;
      }
      
      if (event.data === 'reload') {
        liveReloadDebugLog(' Live reload triggered, refreshing page...');
        window.location.reload();
      }
    };
