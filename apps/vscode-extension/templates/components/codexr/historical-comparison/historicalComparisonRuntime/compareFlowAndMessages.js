// == historicalComparisonRuntime.js | compareFlowAndMessages (assembled per manifest.json; see COMPONENTS.md) ==
  // Replay support for self-contained exports: the manifest lists every
  // comparison that was computed before the export, newest first.
  function getOfflineReplayList() {
    var manifest = getClient()?.getOfflineExportManifest?.();
    var comparisons = manifest?.historicalComparison?.comparisons;
    return Array.isArray(comparisons) ? comparisons : [];
  }

  function showOfflineReplayStatus() {
    var replays = getOfflineReplayList();
    if (replays.length === 0) {
      setStatus('No comparison was computed before this export: computing one needs the live CodeXR session.', 'error');
      return;
    }
    var next = replays[(state.offlineReplayIndex || 0) % replays.length];
    setStatus(
      'Offline export: ' + replays.length + ' computed comparison(s) available.\n'
      + 'Compare replays the next one: #' + next.revision + ' ' + (next.leftLabel || '?') + ' vs ' + (next.rightLabel || '?'),
      'info'
    );
  }

  async function loadOfflineComparison(entry) {
    try {
      setStatus('Loading exported comparison #' + entry.revision + '...', 'info');
      var response = await fetch(String(entry.url), { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Exported comparison #' + entry.revision + ' could not be loaded.');
      }
      var result = await response.json();
      await applySharedState({
        entityKind: 'historical-comparison',
        entityId: 'main',
        mode: 'historical-compare',
        result: result
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function setComparisonJobRunning(running) {
    state.jobRunning = !!running;
    refs.compareButton?.querySelector?.('a-text')?.setAttribute?.('value', state.jobRunning ? 'Cancel' : 'Compare');
  }

  function compareOrCancel() {
    if (state.jobRunning && !getClient()?.isOfflineExport?.()) {
      setStatus('Cancelling the historical comparison...', 'info');
      if (!getClient()?.sendMessage?.('historical-comparison-cancel', {})) {
        setStatus('Could not reach VS Code to cancel the comparison.', 'error');
      }
      return;
    }
    startComparison();
  }

  function handleCancelled(message) {
    setComparisonJobRunning(false);
    setStatus(message?.payload?.message || 'Historical comparison cancelled.', 'info');
  }

  function startComparison() {
    // Offline with exported git payloads, Compare works for real: validate
    // the selection like online and compose the comparison locally. Without
    // payloads, walk the replay list of precomputed comparisons.
    if (getClient()?.isOfflineExport?.()) {
      if (getOfflineGitData()) {
        if (!state.selected.left || !state.selected.right) {
          setStatus('Select both comparison sources.', 'error');
          return;
        }
        if (state.selected.left === state.selected.right) {
          setStatus('Choose two different comparison sources.', 'error');
          return;
        }
        void startOfflineGitComparison();
        return;
      }
      var replays = getOfflineReplayList();
      if (replays.length === 0) {
        setStatus('No comparison was computed before this export: computing one needs the live CodeXR session.', 'error');
        return;
      }
      var index = (state.offlineReplayIndex || 0) % replays.length;
      state.offlineReplayIndex = index + 1;
      void loadOfflineComparison(replays[index]);
      return;
    }
    if (!state.selected.left || !state.selected.right) {
      setStatus('Select both comparison sources.', 'error');
      return;
    }
    if (state.selected.left === state.selected.right) {
      setStatus('Choose two different comparison sources.', 'error');
      return;
    }
    setStatus('Analyzing historical comparison. Please wait...', 'info');
    getClient()?.sendMessage?.('historical-comparison-start', {
      leftSourceId: state.selected.left,
      rightSourceId: state.selected.right
    });
  }

  function showHistoricalSelectionPanel() {
    root.CodeXRAnalysisModeRuntime.setSelectionPanel?.('historical-selection');
    root.CodeXRMappingUiRuntime.showPanelView?.('historical-selection');
    showSourceSelection();
  }

  // Single entry path: no explicit controllerView/panelViewId — the mode's
  // resolveControllerView routes (mapping when a comparison is live, source
  // selector otherwise), so the local transition and the server echo can
  // never disagree.
  async function enterHistoricalSelection() {
    getClient().sendMessage?.('analysis-mode-activate', {
      mode: 'historical-compare'
    });
    await root.CodeXRAnalysisModeRuntime.changeAnalysis('historical-compare', {
      reason: 'historical-mode-entry'
    });
  }

  function selectHistoricalMode() {
    root.console?.log?.('[CodeXR.Debug]: Historical comparison mode selected', {
      hasResult: !!state.result,
      revision: state.result?.revision || null
    });
    void enterHistoricalSelection();
  }

  function handleReferences(message) {
    state.references = message?.payload || null;
    var activeRequest = state.references?.activeRequest;
    if (activeRequest?.leftSourceId && activeRequest?.rightSourceId) {
      state.selected = {
        left: activeRequest.leftSourceId,
        right: activeRequest.rightSourceId
      };
    }
    // Category/paging now live inside the shared picker; the panel only feeds
    // it the references and keeps the selection detail.
    renderReferences();
    var job = state.references?.job;
    if (job && (job.state === 'running' || job.state === 'queued')) {
      setComparisonJobRunning(true);
      setStatus('A historical comparison is running for the room...', 'info');
      return;
    }
    var excludedCount = Number(state.references?.eligibility?.excludedSources?.length || 0);
    setStatus(
      excludedCount
        ? excludedCount + ' revision(s) were hidden because they contain no analyzable data.'
        : '',
      'info'
    );
  }

  function handleProgress(message) {
    setComparisonJobRunning(message?.payload?.state === 'analyzing');
    setStatus(message?.payload?.message || 'Analyzing...', 'info');
  }

  function handleError(message) {
    var code = String(message?.payload?.code || '');
    var rawMessage = String(message?.payload?.message || '');
    // "Busy" answers only this participant: the room's comparison runs on.
    if (code !== 'comparison-busy') {
      setComparisonJobRunning(false);
    }
    // Only a references failure or "not a git repository" means the target is
    // outside Git; a failed git command elsewhere (a deleted branch) is not
    // that, and gets its own typed code from the server (HIST-10).
    var friendlyMessage = code === 'references-unavailable' || /not a git repository/i.test(rawMessage)
      ? 'History compare requires an analysis inside a local Git repository.'
      : code === 'comparison-busy'
        ? 'Another comparison is already being generated.'
        : code === 'comparison-source-no-data' || code === 'comparison-timeout'
          || code === 'comparison-reference-gone' || code === 'comparison-snapshot-limit'
          || code === 'comparison-step-timeout' || code === 'comparison-live-refresh-stopped'
          ? rawMessage
        : /git-command-timeout|revision-analysis-timeout/i.test(rawMessage)
          ? 'A Git or analysis step took too long and was stopped. Please try again.'
        : 'Historical comparison failed. Please try again.';
    setStatus(friendlyMessage, 'error');
  }

  async function applySharedState(snapshot, options) {
    var signal = options?.signal || null;
    var fetchOptions = signal ? { cache: 'no-store', signal: signal } : { cache: 'no-store' };
    if (!snapshot || !snapshot.result) {
      return;
    }
    setComparisonJobRunning(false);
    // state.result is the room's latest comparison, stored before any await:
    // a load abandoned because the user left mid-fetch can no longer drop
    // it, and re-entry re-syncs from it (HIST-4b).
    state.result = snapshot.result;
    if (!isHistoricalModeActiveOrActivating()) {
      return;
    }
    try {
      var loadGeneration = ++state.loadGeneration;
      setStatus('Loading comparison datasets...', 'info');
      var result = snapshot.result;
      var responses = await Promise.all([
        fetch(result.left.url + '?revision=' + result.revision, fetchOptions),
        fetch(result.right.url + '?revision=' + result.revision, fetchOptions)
      ]);
      if (!responses[0].ok || !responses[1].ok) {
        throw new Error('Comparison datasets could not be loaded.');
      }
      var datasets = await Promise.all(responses.map(function (response) { return response.json(); }));
      if (
        loadGeneration !== state.loadGeneration
        || !isHistoricalModeActiveOrActivating()
      ) {
        return;
      }
      // Decide against what is MOUNTED, not against state.result: a result
      // stored while the mode was parked would otherwise be compared with
      // itself, and only the live side would be refreshed (HIST-4a).
      if (canRefreshLiveSide(result, refs.renderedResult || null)) {
        await refreshLiveSide(result, datasets);
      } else {
        await renderComparison(result, datasets[0], datasets[1]);
      }
      // The datasets are on screen: the loading text must not stay (HIST-10).
      setStatus('', 'info');
      closePanel();
    } catch (error) {
      if (signal?.aborted) { return; }
      setStatus(error && typeof error.message === 'string' ? error.message : String(error), 'error');
      if (options?.rethrow) { throw error; }
    }
  }
