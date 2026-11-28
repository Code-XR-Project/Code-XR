// == drillDownRuntime.js | breadcrumbBar (assembled per manifest.json; see COMPONENTS.md) ==
  // The bar on the table's front edge: Back, Forward, Home and the crumbs
  // `project > folder > ... > current`, with one status line under them; and
  // the loading card over the table while the server analyses a target.

  var CRUMB_GAP = 0.16;
  var CRUMB_SEPARATOR = 0.12;

  function ensureBar() {
    var scene = sceneEl();
    if (!scene) { return null; }
    if (refs.bar && refs.bar.el.isConnected !== false) { return refs.bar; }
    var el = entity('a-entity', {
      id: 'codexrDrillDownBar',
      'data-codexr-role': 'drill-down breadcrumb bar',
      position: BAR.x + ' ' + BAR.y + ' ' + BAR.z,
      rotation: BAR.tilt + ' 0 0'
    });
    el.appendChild(entity('a-plane', {
      width: BAR.width, height: BAR.height,
      material: 'color: ' + COLORS.panel + '; opacity: 0.9; transparent: true; shader: flat'
    }));
    el.appendChild(entity('a-plane', {
      position: '0 ' + (BAR.height / 2 - 0.01) + ' 0.004', width: BAR.width, height: 0.02,
      material: 'color: ' + ACCENT + '; shader: flat'
    }));
    var left = -BAR.width / 2 + 0.1;
    var back = button('<', (left + 0.2).toFixed(3) + ' 0.12 0.012', 0.4, function () { send('drilldown-back'); }, COLORS.button);
    var forward = button('>', (left + 0.65).toFixed(3) + ' 0.12 0.012', 0.4, function () { send('drilldown-forward'); }, COLORS.button);
    var home = button('Home', (left + 1.2).toFixed(3) + ' 0.12 0.012', 0.6, function () { send('drilldown-home'); }, COLORS.home);
    back.el.setAttribute('data-codexr-role', 'drill-down back');
    forward.el.setAttribute('data-codexr-role', 'drill-down forward');
    home.el.setAttribute('data-codexr-role', 'drill-down home');
    el.appendChild(back.el);
    el.appendChild(forward.el);
    el.appendChild(home.el);
    var crumbs = entity('a-entity', { position: (left + 1.62).toFixed(3) + ' 0.12 0.012', 'data-codexr-role': 'drill-down crumbs' });
    el.appendChild(crumbs);
    var status = text('', left.toFixed(3) + ' -0.2 0.012', 5.1, COLORS.muted, 'left', 80);
    el.appendChild(status);
    scene.appendChild(el);
    refs.bar = { el: el, back: back, forward: forward, home: home, crumbs: crumbs, status: status, crumbsKey: '' };
    return refs.bar;
  }

  /** The crumbs the bar shows: where the table is (home's own while the classic analysis is up). */
  function visibleCrumbs(entityState) {
    if (!entityState) { return []; }
    return currentMode() === MODE ? (entityState.crumbs || []) : (entityState.homeCrumbs || entityState.crumbs || []);
  }

  function renderCrumbs(bar, crumbs) {
    var key = JSON.stringify(crumbs);
    if (bar.crumbsKey === key) { return; }
    bar.crumbsKey = key;
    while (bar.crumbs.firstChild) { bar.crumbs.removeChild(bar.crumbs.firstChild); }
    var laid = layoutCrumbs(crumbs, BAR.maxCrumbsWidth, CRUMB_GAP);
    var x = 0;
    laid.forEach(function (crumb, index) {
      var width = crumbWidth(crumb.ellipsis ? '...' : crumb.label);
      var isCurrent = index === laid.length - 1;
      var color = isCurrent ? COLORS.buttonActive : (crumb.home ? COLORS.home : COLORS.button);
      var handle = button(crumb.label, (x + width / 2).toFixed(3) + ' 0 0', width, function () {
        send('drilldown-goto', { relativePath: crumb.relativePath, kind: crumb.kind });
      }, color);
      handle.el.setAttribute('data-codexr-role', 'drill-down crumb' + (isCurrent ? ' current' : ''));
      handle.el.setAttribute('data-codexr-crumb-path', crumb.relativePath || '');
      if (isCurrent) { setButtonEnabled(handle, false); handle.el.setAttribute('material', 'color', COLORS.buttonActive); setText(handle.label, null, COLORS.current); }
      bar.crumbs.appendChild(handle.el);
      x += width;
      if (index < laid.length - 1) {
        bar.crumbs.appendChild(text('>', (x + CRUMB_GAP / 2).toFixed(3) + ' 0 0', 0.14, COLORS.muted, 'center', 2));
        x += CRUMB_GAP;
      }
    });
    bar.crumbsWidth = x;
  }

  function statusLine(entityState) {
    if (state.pendingLabel && (!entityState || entityState.status !== 'loading')) {
      return { text: 'Opening ' + state.pendingLabel + '...', color: COLORS.loading };
    }
    if (state.lastError) { return { text: state.lastError, color: COLORS.error }; }
    if (!entityState) { return { text: 'Select a building or a district and choose Analyze to drill into it.', color: COLORS.muted }; }
    if (entityState.status === 'loading') {
      var label = entityState.pending?.relativePath || entityState.rootLabel || '';
      var elapsed = entityState.startedAt ? formatElapsed(now() - entityState.startedAt) : '';
      return { text: 'Analyzing ' + label + '...' + (elapsed ? '  ' + elapsed : ''), color: COLORS.loading };
    }
    if (entityState.status === 'error') { return { text: entityState.message || 'The analysis failed.', color: COLORS.error }; }
    if (currentMode() !== MODE) { return { text: describeReady(Object.assign({}, entityState, { atHome: true, message: '' })), color: COLORS.muted }; }
    return { text: describeReady(entityState), color: COLORS.muted };
  }

  function renderBar() {
    var entityState = state.entity;
    var visible = state.initialized && isNavigableMode() && !!entityState;
    if (!visible) {
      setNodeVisible(refs.bar?.el, false);
      renderLoading();
      return;
    }
    var bar = ensureBar();
    if (!bar) { return; }
    setNodeVisible(bar.el, true);
    var inDrill = currentMode() === MODE;
    setButtonEnabled(bar.back, !!entityState.canBack);
    setButtonEnabled(bar.forward, !!entityState.canForward);
    setButtonEnabled(bar.home, inDrill || !entityState.atHome);
    renderCrumbs(bar, visibleCrumbs(entityState));
    var line = statusLine(entityState);
    setText(bar.status, compact(line.text, 96), line.color);
    renderLoading();
  }

  function ensureLoadingCard() {
    var scene = sceneEl();
    if (!scene) { return null; }
    if (refs.loading && refs.loading.el.isConnected !== false) { return refs.loading; }
    var el = entity('a-entity', {
      id: 'codexrDrillDownLoading',
      'data-codexr-role': 'drill-down loading',
      position: LOADING.x + ' ' + LOADING.y + ' ' + LOADING.z
    });
    el.appendChild(entity('a-plane', {
      width: LOADING.width, height: LOADING.height,
      material: 'color: ' + COLORS.panel + '; opacity: 0.92; transparent: true; shader: flat'
    }));
    el.appendChild(entity('a-plane', {
      position: '0 ' + (-LOADING.height / 2 + 0.03) + ' 0.004', width: LOADING.width, height: 0.04,
      material: 'color: ' + ACCENT + '; opacity: 0.5; transparent: true; shader: flat'
    }));
    var title = text('', '0 0.1 0.01', 3.2, COLORS.current, 'center', 44);
    var detail = text('', '0 -0.12 0.01', 3, COLORS.loading, 'center', 48);
    el.appendChild(title);
    el.appendChild(detail);
    scene.appendChild(el);
    refs.loading = { el: el, title: title, detail: detail };
    return refs.loading;
  }

  function renderLoading() {
    var entityState = state.entity;
    var loading = !!entityState && entityState.status === 'loading' && isNavigableMode();
    if (!loading) {
      setNodeVisible(refs.loading?.el, false);
      stopLoadingTicker();
      return;
    }
    var card = ensureLoadingCard();
    if (!card) { return; }
    setNodeVisible(card.el, true);
    var pending = entityState.pending || {};
    setText(card.title, (pending.kind === 'file' ? 'Analyzing file ' : 'Analyzing folder ') + compact(pending.relativePath || entityState.rootLabel || '', 36));
    var elapsed = entityState.startedAt ? formatElapsed(now() - entityState.startedAt) : '';
    setText(card.detail, 'Only new or changed files go to the analyzer' + (elapsed ? '  ·  ' + elapsed : ''));
    startLoadingTicker();
  }

  // The elapsed counter is text, not motion: it ticks under reduced motion too.
  function startLoadingTicker() {
    if (state.loadingTimer || !root.setInterval) { return; }
    state.loadingTimer = root.setInterval(function () {
      if (state.entity?.status !== 'loading') { stopLoadingTicker(); return; }
      renderBar();
    }, 250);
  }

  function stopLoadingTicker() {
    if (!state.loadingTimer) { return; }
    root.clearInterval?.(state.loadingTimer);
    state.loadingTimer = null;
  }

  function showPendingLocally(label) {
    state.pendingLabel = label || '';
    state.lastError = '';
    renderBar();
  }

  function showError(message) {
    state.pendingLabel = '';
    state.lastError = String(message || '');
    state.errorAt = now();
    renderBar();
  }
