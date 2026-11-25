// == analysisModeRuntime.js | selectorAndPanel (assembled per manifest.json; see COMPONENTS.md) ==
  function invoke(lifecycle, method, context) {
    if (typeof lifecycle?.[method] !== 'function') {
      return Promise.resolve();
    }
    return Promise.resolve(lifecycle[method](context));
  }

  /**
   * An abort handle with the AbortSignal shape. The real AbortController is
   * used when the page has one, so a lifecycle can hand the signal straight to
   * fetch(); the fallback keeps the runtime working in a bare vm context.
   */
  function createAbortHandle() {
    if (typeof root.AbortController === 'function') {
      return new root.AbortController();
    }
    var listeners = [];
    var signal = {
      aborted: false,
      reason: undefined,
      addEventListener: function (type, listener) {
        if (type === 'abort' && typeof listener === 'function') { listeners.push(listener); }
      },
      removeEventListener: function (type, listener) {
        listeners = listeners.filter(function (candidate) { return candidate !== listener; });
      }
    };
    return {
      signal: signal,
      abort: function (reason) {
        if (signal.aborted) { return; }
        signal.aborted = true;
        signal.reason = reason;
        listeners.splice(0).forEach(function (listener) {
          try { listener({ type: 'abort' }); } catch (_error) { /* a listener cannot stop the abort */ }
        });
      }
    };
  }

  function createModeError(code, message) {
    var error = new Error(message);
    error.name = code === 'aborted' ? 'AbortError' : 'CodeXRModeError';
    error.code = code;
    return error;
  }

  /**
   * Settles with `promise`, or rejects once `timeoutMs` passes or `signal`
   * aborts, whichever comes first. The lifecycle's own promise keeps running;
   * this only stops the switcher from waiting on it.
   */
  function settleWithin(promise, timeoutMs, signal, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = null;
      var onAbort = null;
      function finish(callback, value) {
        if (done) { return; }
        done = true;
        if (timer !== null) { root.clearTimeout?.(timer); }
        if (onAbort) { signal?.removeEventListener?.('abort', onAbort); }
        callback(value);
      }
      if (signal?.aborted) {
        finish(reject, createModeError('aborted', label + ' was cancelled by a newer request.'));
        return;
      }
      if (timeoutMs > 0 && typeof root.setTimeout === 'function') {
        timer = root.setTimeout(function () {
          finish(reject, createModeError('timeout', label + ' did not finish within ' + Math.round(timeoutMs / 1000) + ' s.'));
        }, timeoutMs);
      }
      if (signal?.addEventListener) {
        onAbort = function () {
          finish(reject, createModeError('aborted', label + ' was cancelled by a newer request.'));
        };
        signal.addEventListener('abort', onAbort);
      }
      Promise.resolve(promise).then(function (value) {
        finish(resolve, value);
      }, function (error) {
        finish(reject, error);
      });
    });
  }

  /**
   * Like invoke(), but failures are logged and swallowed (sync throws too),
   * and a hook that never settles is abandoned after LIFECYCLE_HOOK_TIMEOUT_MS.
   * Lifecycle hooks run through this: a mode that
   * fails to clean up may degrade itself, but it must never abort the
   * transition — otherwise the table keeps the old mode's theme and the
   * suspended interactions are never restored (dead clicks).
   */
  function invokeSafely(lifecycle, method, context) {
    try {
      return settleWithin(
        invoke(lifecycle, method, context),
        LIFECYCLE_HOOK_TIMEOUT_MS,
        null,
        'Lifecycle ' + method
      ).catch(function (error) {
        root.console?.error?.('[CodeXR][AnalysisMode] Lifecycle ' + method + ' failed:', error);
      });
    } catch (error) {
      root.console?.error?.('[CodeXR][AnalysisMode] Lifecycle ' + method + ' failed:', error);
      return Promise.resolve();
    }
  }

  function getModeLabel(mode) {
    if (mode === 'single') { return 'Normal analysis'; }
    var option = state.modeOptions.find(function (candidate) { return candidate.id === mode; });
    return option?.label || String(mode || 'this analysis');
  }

  function describeError(error) {
    return error && typeof error.message === 'string' ? error.message : String(error);
  }

  function register(mode, lifecycle) {
    if (!VALID_MODES.has(mode) || !lifecycle) {
      return function () {};
    }
    lifecycles[mode] = lifecycle;
    if (state.mode === mode && !state.transitioning) {
      void invoke(lifecycle, 'activate', {
        from: mode,
        to: mode,
        generation: state.generation,
        context: { reason: 'late-registration' }
      }).then(function () {
        if (!state.transitioning && state.mode === mode) {
          state.activeLifecycleMode = mode;
        }
      }).catch(function (error) {
        root.console?.error?.('[CodeXR][AnalysisMode] Could not activate late-registered mode:', mode, error);
      });
    }
    return function () {
      if (lifecycles[mode] === lifecycle) {
        delete lifecycles[mode];
      }
    };
  }

  function createEntity(tagName, attributes) {
    var element = root.document?.createElement?.(tagName);
    Object.keys(attributes || {}).forEach(function (key) {
      element?.setAttribute?.(key, attributes[key]);
    });
    return element;
  }

  function createModeButton(option, y) {
    var disabled = option.disabled === true;
    var disabledReason = String(option.disabledReason || 'This visualization mode is not available right now.');
    var button = createEntity('a-plane', {
      position: '0 ' + y + ' 0.02',
      width: 4.5,
      height: 0.48,
      material: 'color: ' + (disabled ? '#475569' : (option.color || '#0e7490')) + '; opacity: ' + (disabled ? '0.62' : '0.96') + '; shader: flat',
      class: 'codexr-analysis-mode-option',
      'data-codexr-interactive': 'true',
      'data-codexr-mode-option': option.id,
      'data-codexr-disabled': disabled ? 'true' : 'false'
    });
    var label = createEntity('a-text', {
      value: option.label,
      position: '0 0 0.02',
      width: 6.8,
      color: disabled ? '#cbd5e1' : '#ffffff',
      align: 'center',
      baseline: 'center'
    });
    button?.appendChild?.(label);
    if (disabled) {
      var tooltip = createEntity('a-entity', {
        visible: false,
        position: '0 -0.46 0.08',
        'data-codexr-mode-disabled-tooltip': option.id
      });
      tooltip.appendChild?.(createEntity('a-plane', {
        width: 4.7,
        height: 0.5,
        material: 'color: #111827; opacity: 0.96; shader: flat'
      }));
      tooltip.appendChild?.(createEntity('a-text', {
        value: disabledReason,
        position: '0 0 0.03',
        width: 5.8,
        color: '#fde68a',
        align: 'center',
        baseline: 'center',
        'wrap-count': 44
      }));
      var setTooltipVisible = function (visible) {
        tooltip.setAttribute?.('visible', !!visible);
      };
      button.appendChild?.(tooltip);
      button.addEventListener?.('mouseenter', function () { setTooltipVisible(true); });
      button.addEventListener?.('mouseleave', function () { setTooltipVisible(false); });
      button.addEventListener?.('raycaster-intersected', function () { setTooltipVisible(true); });
      button.addEventListener?.('raycaster-intersected-cleared', function () { setTooltipVisible(false); });
    }
    button?.addEventListener?.('click', function () {
      if (disabled) {
        debugLog('Visualization mode option disabled', option.id, disabledReason);
        return;
      }
      debugLog('Visualization mode option clicked', option.id);
      option.onSelect?.();
    });
    return button;
  }

  function requestModeActivation(mode) {
    if (!VALID_MODES.has(mode) || mode === 'selection') {
      return Promise.resolve(false);
    }
    debugLog('Requesting analysis mode activation', mode, {
      currentMode: state.mode,
      activeLifecycleMode: state.activeLifecycleMode,
      transitioning: state.transitioning
    });
    var client = root.CodeXRCollaborationRuntime?.getClient?.(root);
    client?.sendMessage?.('analysis-mode-activate', { mode: mode });
    return changeAnalysis(mode, {
      reason: 'local-analysis-mode-option',
      controllerView: getDefaultControllerViewForMode(mode),
      panelViewId: getPanelViewForControllerView(getDefaultControllerViewForMode(mode))
    });
  }

  /**
   * The line above the options. It is the selector's own status line: an
   * analysis that failed to open says so here (with its option relabelled
   * "Retry"), and a mode that is still opening reports its progress here.
   * Before, both went to the mapping view's status line, which is hidden
   * while the selector is up, so a failure read as "nothing happened".
   */
  function getSelectorHeadline() {
    if (state.lastError) {
      return {
        value: 'Could not open ' + getModeLabel(state.lastError.mode) + ': ' + state.lastError.message
          + '\nPick it again to retry, or choose another analysis.',
        color: '#fecaca',
        tone: 'error'
      };
    }
    if (state.selectorStatus?.message) {
      return {
        value: state.selectorStatus.message,
        color: state.selectorStatus.tone === 'error' ? '#fecaca' : '#fde68a',
        tone: state.selectorStatus.tone || 'info'
      };
    }
    return { value: 'Choose how the analysis table represents the data.', color: '#cde7ff', tone: 'info' };
  }

  function renderModeOptions() {
    if (!state.panelRoot) { return; }
    while (state.panelRoot.firstChild) {
      state.panelRoot.removeChild(state.panelRoot.firstChild);
    }
    var headline = getSelectorHeadline();
    state.panelRoot.appendChild(createEntity('a-text', {
      value: headline.value,
      position: '0 1.18 0.02',
      width: 5.5,
      color: headline.color,
      align: 'center',
      baseline: 'center',
      'wrap-count': 52,
      'data-codexr-mode-selector-status': headline.tone
    }));
    var options = [{
      id: 'single',
      label: 'Normal analysis',
      color: '#0e7490',
      onSelect: function () {
        void requestModeActivation('single');
      }
    }].concat(state.modeOptions);
    options.forEach(function (option, index) {
      var shown = option;
      if (state.lastError?.mode === option.id && option.disabled !== true) {
        shown = Object.assign({}, option, { label: 'Retry: ' + option.label });
      }
      state.panelRoot.appendChild(createModeButton(shown, 0.55 - (index * 0.62)));
    });
  }

  /**
   * Lets a mode report progress on the selector while it opens (the
   * dependency graph's "Opening dependencies…", for one). Pass an empty
   * message to clear it.
   */
  function setSelectorStatus(message, tone) {
    var text = String(message || '').trim();
    state.selectorStatus = text ? { message: text, tone: tone === 'error' ? 'error' : 'info', at: Date.now() } : null;
    renderModeOptions();
  }

  function registerModeOption(option) {
    if (!option?.id || typeof option.onSelect !== 'function') {
      return function () {};
    }
    state.modeOptions = state.modeOptions.filter(function (candidate) {
      return candidate.id !== option.id;
    });
    state.modeOptions.push(option);
    renderModeOptions();
    return function () {
      state.modeOptions = state.modeOptions.filter(function (candidate) {
        return candidate.id !== option.id;
      });
      renderModeOptions();
    };
  }

  function resumeRequestedMode() {
    debugLog('Resuming requested analysis mode', state.requestedMode || 'single');
    root.CodeXRCollaborationRuntime?.getClient?.(root)
      ?.sendMessage?.('analysis-mode-activate', { mode: state.requestedMode || 'single' });
    void changeAnalysis(state.requestedMode || 'single', {
      reason: 'local-visualization-mode-toggle',
      controllerView: getDefaultControllerViewForMode(state.requestedMode || 'single')
    });
  }

  function openSelector() {
    debugLog('Opening visualization mode selector', {
      currentMode: state.mode,
      activeLifecycleMode: state.activeLifecycleMode,
      transitioning: state.transitioning
    });
    state.selectionPanelView = 'visualization-mode';
    var transition = changeAnalysis('selection', {
      reason: 'local-mode-selection',
      controllerView: 'visualization-menu',
      panelViewId: 'visualization-mode'
    });
    // The generation this intent owns. If the user picks an analysis before
    // the selection transition lands, that pick is newer: announcing the
    // selection afterwards would make the room (and this page, through the
    // echo) snap back to the empty selector (LIFECYCLE-2).
    var selectionGeneration = state.generation;
    return transition.then(function () {
      if (state.generation !== selectionGeneration) {
        debugLog('Selection announcement skipped: a newer analysis was picked', {
          selectionGeneration: selectionGeneration,
          generation: state.generation
        });
        return false;
      }
      root.CodeXRCollaborationRuntime?.getClient?.(root)
        ?.sendMessage?.('analysis-mode-selection', {});
      return true;
    });
  }

  function mountModePanel(attempt) {
    if (state.unregisterPanelView) { return; }
    var mappingRuntime = root.CodeXRMappingUiRuntime;
    if (!mappingRuntime?.registerPanelView || !mappingRuntime.isPanelReady?.()) {
      // Event-driven: the controller calls back the moment its panel exists.
      // A capped retry here used to permanently lose the analysis selector on
      // slow scenes. The interval is only a fallback for a controller build
      // without whenPanelReady (mixed-version scene) or one that loads late.
      if (!state.modePanelMountQueued) {
        state.modePanelMountQueued = true;
        var rearm = function () {
          state.modePanelMountQueued = false;
          mountModePanel(attempt);
        };
        if (mappingRuntime?.whenPanelReady) {
          mappingRuntime.whenPanelReady(rearm);
        } else {
          // unref (Node-only) keeps this browser-oriented retry from pinning
          // test processes open; in the browser it is a no-op.
          root.setTimeout?.(rearm, 250)?.unref?.();
        }
      }
      return;
    }
    state.panelRoot = createEntity('a-entity', {
      id: 'codexrVisualizationModePanel',
      position: '0 0 0.04'
    });
    state.unregisterPanelView = mappingRuntime.registerPanelView({
      id: 'visualization-mode',
      title: 'Visualization mode',
      // A word instead of the old 'V': the button names what it opens, and
      // its colour says which analysis you are currently in.
      buttonLabel: 'Analyses',
      buttonWidth: 0.9,
      buttonColor: MODE_ACCENT_BY_ID[state.mode] || MODE_ACCENT_BY_ID.single,
      headerButton: true,
      panelHeight: 3.35,
      content: state.panelRoot,
      onShow: function () {
        state.selectionPanelView = 'visualization-mode';
        if (state.mode !== 'selection' && !state.openingSelectorFromPanel) {
          state.openingSelectorFromPanel = true;
          debugLog('Visualization mode panel shown directly; forcing selection mode', {
            currentMode: state.mode,
            activeLifecycleMode: state.activeLifecycleMode,
            transitioning: state.transitioning
          });
          void openSelector().finally(function () {
            state.openingSelectorFromPanel = false;
          });
        }
      },
      onToggleActive: resumeRequestedMode
    });
    if (!state.unregisterPanelView) {
      state.panelRoot = null;
      root.CodeXRMappingUiRuntime?.whenPanelReady?.(function () {
        mountModePanel(attempt);
      });
      return;
    }
    // One unconditional marker so a scene can be checked at a glance: if this
    // line is absent from the console, the selector view never registered.
    root.console?.log?.('[CodeXR] Analysis selector registered on the controller panel.');
    renderModeOptions();
  }

  /**
   * An activation the switcher stopped waiting for (a newer pick, or its
   * timeout) keeps running in the lifecycle. When it does settle, and its
   * mode is no longer the one on the table, it is deactivated once more so
   * whatever it mounted late is removed.
   */
  function watchAbandonedActivation(mode, lifecycle, rawActivation, token) {
    Promise.resolve(rawActivation).catch(function () {}).then(function () {
      if (state.activeLifecycleMode === mode || state.pendingTransitionMode === mode) {
        return;
      }
      debugLog('Abandoned activation settled; cleaning up', { mode: mode });
      return invokeSafely(lifecycle, 'deactivate', {
        from: mode,
        to: state.mode,
        generation: token?.generation,
        context: { reason: 'abandoned-activation-settled' },
        token: token
      });
    });
  }

  /**
   * A failed activation lands on the selector with the reason shown there,
   * and the room is told, so the server and every guest leave the failed
   * mode too. The room's echo of the failed pick (already in flight) is not
   * re-run here.
   */
  function recordActivationFailure(mode, error, context) {
    state.lastError = { mode: mode, message: describeError(error), code: error?.code || 'error', at: Date.now() };
    state.suppressEcho = { mode: mode, until: Date.now() + FAILED_MODE_ECHO_WINDOW_MS };
    state.selectorStatus = null;
    renderModeOptions();
    if (context?.reason !== 'authoritative-analysis-view') {
      root.CodeXRCollaborationRuntime?.getClient?.(root)
        ?.sendMessage?.('analysis-mode-selection', {});
    }
  }

  async function performTransition(mode, context, generation) {
    var previousMode = state.activeLifecycleMode;
    var activationToken = createActivationToken(mode, generation);
    debugLog('Analysis mode transition started', {
      from: previousMode,
      to: mode,
      generation: generation,
      reason: context?.reason || ''
    });
    if (previousMode !== mode) {
      var capturedState = await invokeSafely(lifecycles[previousMode], 'captureState', {
        from: previousMode,
        to: mode,
        generation: generation
      });
      if (capturedState !== undefined) {
        state.modeSnapshots[previousMode] = capturedState;
      }
      await invokeSafely(lifecycles[previousMode], 'deactivate', {
        from: previousMode,
        to: mode,
        generation: generation,
        token: activationToken
      });
      if (state.activeLifecycleMode === previousMode) {
        state.activeLifecycleMode = null;
      }
    }
    if (generation !== state.generation) { return false; }
    releasePrimaryAnalysisOwnership(mode);
    await invokeSafely(lifecycles[mode], 'restoreState', {
      from: previousMode,
      to: mode,
      generation: generation,
      savedState: state.modeSnapshots[mode],
      context: context || null,
      token: activationToken
    });
    if (generation !== state.generation) { return false; }
    // requestedMode is what "Analyses" resumes; a mode that fails to open
    // must not become it (pressing the header would retry the failure).
    var requestedBefore = state.requestedMode;
    applyAnalysisMode(mode, context || null);
    var lifecycle = lifecycles[mode];
    var abortHandle = createAbortHandle();
    var activation = { mode: mode, generation: generation, abort: abortHandle, startedAt: Date.now() };
    state.activation = activation;
    activationToken.signal = abortHandle.signal;
    var timeoutMs = Number(lifecycle?.activateTimeoutMs) > 0
      ? Number(lifecycle.activateTimeoutMs)
      : DEFAULT_ACTIVATE_TIMEOUT_MS;
    var rawActivation;
    try {
      rawActivation = invoke(lifecycle, 'activate', {
        from: previousMode,
        to: mode,
        generation: generation,
        context: context || null,
        savedState: state.modeSnapshots[mode],
        token: activationToken,
        signal: abortHandle.signal
      });
    } catch (error) {
      rawActivation = Promise.reject(error);
    }
    try {
      await settleWithin(rawActivation, timeoutMs, abortHandle.signal, 'Opening ' + getModeLabel(mode));
    } catch (error) {
      if (state.activation === activation) { state.activation = null; }
      if (error?.code === 'aborted' || generation !== state.generation) {
        // Superseded: the newer transition deactivates this mode as its
        // previous one. If the abandoned activate settles later, it is
        // cleaned up then (it may have mounted something after that).
        watchAbandonedActivation(mode, lifecycle, rawActivation, activationToken);
        debugLog('Analysis mode activation abandoned for a newer request', { mode: mode, generation: generation });
        return false;
      }
      // Stop the lifecycle's own work (fetches honour the signal), then clean up.
      abortHandle.abort(error);
      if (error?.code === 'timeout') {
        watchAbandonedActivation(mode, lifecycle, rawActivation, activationToken);
      }
      await invokeSafely(lifecycle, 'deactivate', {
        from: mode,
        to: 'selection',
        generation: generation,
        context: { reason: 'activation-error', error: error },
        token: activationToken
      });
      if (generation !== state.generation) { return false; }
      // The room's echo of this pick may already have set it (it can land
      // before the transition starts); either way it must not be the failed
      // mode.
      state.requestedMode = requestedBefore !== mode ? requestedBefore : 'single';
      recordActivationFailure(mode, error, context);
      applyAnalysisMode('selection', { panelViewId: 'visualization-mode', controllerView: 'visualization-menu' });
      await clearVisualizationsForSelection({ generation: generation });
      console.error('[CodeXR][AnalysisMode] Could not activate mode:', mode, error);
      return false;
    }
    if (state.activation === activation) { state.activation = null; }
    if (generation !== state.generation) {
      await invokeSafely(lifecycle, 'deactivate', {
        from: mode,
        to: null,
        generation: generation,
        context: { reason: 'superseded-activation' },
        token: activationToken
      });
      if (state.activeLifecycleMode === mode && state.pendingTransitionMode !== mode) {
        state.activeLifecycleMode = null;
      }
      return false;
    }
    if (mode !== 'selection') {
      state.lastError = null;
      state.suppressEcho = null;
    }
    if (state.selectorStatus || mode !== 'selection') {
      state.selectorStatus = null;
      renderModeOptions();
    }
    // The mode was applied once before activate (the lifecycle needs it in
    // place while it mounts). Re-applying it here would redo the table geometry
    // and the panel routing — and overwrite the view the lifecycle just chose
    // (historical routes itself to the comparison or the source selector).
    debugLog('Analysis mode transition completed', {
      mode: mode,
      activeLifecycleMode: state.activeLifecycleMode,
      generation: generation
    });
    return true;
  }
