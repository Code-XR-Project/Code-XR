// == agentFlowRuntime.js | controllerPanel (assembled per manifest.json; see COMPONENTS.md) ==
  // The controller view 'agent-flow': session picker, transport, view toggles,
  // the session metrics and the current step. Built once with a fixed layout;
  // renderPanel() only rewrites labels and colours.

  var PANEL = {
    height: 7.6,
    left: -2.85,
    sectionY: 3.18,
    rowsTopY: 2.72,
    rowGap: 0.44,
    pagerY: 0.98,
    stepY: 0.5,
    transportY: 0.02,
    speedY: -0.48,
    togglesY: -0.98,
    agentsY: -1.48,
    metricsTopY: -1.98,
    metricsGap: 0.3,
    statusY: -3.58
  };
  var BUTTON_IDLE = '#334155';
  var BUTTON_ACTIVE = '#047857';
  var BUTTON_DISABLED = '#1e293b';
  var BUTTON_TEXT_WIDTH = 2.1;
  var BUTTON_WRAP = 26;

  function panelButton(label, x, y, width, onClick, color, textWidth) {
    var el = entity('a-plane', {
      position: x + ' ' + y + ' 0.02', width: width, height: 0.36,
      material: 'color: ' + (color || BUTTON_IDLE) + '; opacity: 0.97; shader: flat',
      class: RAYCAST_CLASS + ' codexr-agent-flow-button', 'data-codexr-interactive': 'true'
    });
    // One glyph size for every button: the wrap count scales with the text
    // box, so a wide row and a narrow button print letters of the same size.
    var boxWidth = textWidth || BUTTON_TEXT_WIDTH;
    var labelEl = text(label, '0 0 0.02', boxWidth, '#ffffff', 'center', Math.round(BUTTON_WRAP * boxWidth / BUTTON_TEXT_WIDTH));
    el.appendChild(labelEl);
    el.addEventListener('click', function (event) {
      event?.stopPropagation?.();
      onClick();
    });
    return { el: el, label: labelEl };
  }

  function paintButton(button, color) {
    button?.el?.setAttribute('material', 'color', color);
  }

  function buildSourceRow(index) {
    var y = PANEL.rowsTopY - index * PANEL.rowGap;
    var row = panelButton('', 0, y, 5.7, function () { openSourceAt(index); }, '#1e293b', 4.4);
    row.label.setAttribute('visible', 'false');
    row.title = text('', '-2.7 0 0.02', 4.2, '#f1f5f9', 'left', 52);
    row.time = text('', '2.7 0 0.02', 1.6, '#94a3b8', 'right', 20);
    row.badge = entity('a-entity', { position: '1.55 0 0.02', visible: 'false' });
    row.badge.appendChild(entity('a-plane', { width: 0.5, height: 0.2, material: 'color: #be123c; shader: flat' }));
    row.badge.appendChild(text('LIVE', '0 0 0.01', 1.2, '#ffffff', 'center', 12));
    row.el.appendChild(row.title);
    row.el.appendChild(row.time);
    row.el.appendChild(row.badge);
    return row;
  }

  function buildMetricCells(panel) {
    refs.metricCells = [];
    for (var i = 0; i < 10; i += 1) {
      var column = i % 2;
      var x = column ? 0.15 : PANEL.left;
      var y = PANEL.metricsTopY - Math.floor(i / 2) * PANEL.metricsGap;
      var label = text('', x + ' ' + y + ' 0.02', 2.9, '#94a3b8', 'left', 44);
      var value = text('', (x + 2.75) + ' ' + y + ' 0.02', 1.4, '#f8fafc', 'right', 18);
      panel.appendChild(label);
      panel.appendChild(value);
      refs.metricCells.push({ label: label, value: value });
    }
  }

  function buildTransport(panel) {
    var y = PANEL.transportY;
    refs.transport = {
      prevTurn: panelButton('Prev turn', -2.32, y, 1.08, function () { state.playback?.previousTurn(); }),
      back: panelButton('Back', -1.16, y, 1.08, function () { state.playback?.stepBack(); }),
      play: panelButton('Play', 0, y, 1.08, function () { state.playback?.toggle(); }, BUTTON_ACTIVE),
      next: panelButton('Next', 1.16, y, 1.08, function () { state.playback?.stepForward(); }),
      nextTurn: panelButton('Next turn', 2.32, y, 1.08, function () { state.playback?.nextTurn(); })
    };
    Object.keys(refs.transport).forEach(function (key) { panel.appendChild(refs.transport[key].el); });
    panel.appendChild(text('Speed', PANEL.left + ' ' + PANEL.speedY + ' 0.02', 1.4, '#94a3b8', 'left', 16));
    refs.speeds = SPEED_PRESETS.map(function (speed, order) {
      var button = panelButton(speed + 'x', -1.85 + order * 0.82, PANEL.speedY, 0.72, function () { state.playback?.setSpeed(speed); });
      button.speed = speed;
      panel.appendChild(button.el);
      return button;
    });
    refs.follow = panelButton('Follow live', 2.12, PANEL.speedY, 1.6, function () {
      state.playback?.setFollowLive(!state.playback.getState().followLive);
    });
    panel.appendChild(refs.follow.el);
  }

  function buildToggles(panel) {
    var defs = [['trail', 'Trail'], ['heat', 'Heat'], ['blast', 'Blast radius'], ['rings', 'Turn rings']];
    refs.toggleButtons = defs.map(function (def, order) {
      var button = panelButton(def[1], -2.13 + order * 1.42, PANEL.togglesY, 1.32, function () { setToggle(def[0], !state.toggles[def[0]]); });
      button.key = def[0];
      panel.appendChild(button.el);
      return button;
    });
  }

  var AGENT_CHIPS = 4;

  /** The Agents legend: one chip per worker, its colour and its step count. */
  function buildAgentChips(panel) {
    panel.appendChild(text('Agents', PANEL.left + ' ' + PANEL.agentsY + ' 0.02', 1.4, '#94a3b8', 'left', 16));
    refs.agentChips = [];
    for (var i = 0; i < AGENT_CHIPS; i += 1) {
      var x = -1.6 + i * 1.22;
      var chip = entity('a-entity', { position: x + ' ' + PANEL.agentsY + ' 0.02' });
      var swatch = entity('a-plane', { position: '-0.5 0 0', width: 0.14, height: 0.14, material: 'color: #334155; shader: flat' });
      var label = text('', '-0.4 0 0.001', 1.75, '#e2e8f0', 'left', 26);
      chip.appendChild(swatch);
      chip.appendChild(label);
      panel.appendChild(chip);
      refs.agentChips.push({ el: chip, swatch: swatch, label: label });
    }
    refs.agentsMore = text('', (-1.6 + AGENT_CHIPS * 1.22 - 0.5) + ' ' + PANEL.agentsY + ' 0.02', 1.2, '#94a3b8', 'left', 12);
    panel.appendChild(refs.agentsMore);
  }

  function agentChipModel() {
    if (!view) { return []; }
    var workers = view.workerInfo || [];
    return view.timeline.actors.map(function (lane) {
      return {
        color: lane.color,
        text: compact(lane.label, 13) + ' ' + lane.steps.length,
        active: !!workers[lane.index]?.active
      };
    });
  }

  function renderAgentChips() {
    var chips = agentChipModel();
    refs.agentChips.forEach(function (chip, index) {
      var model = chips[index];
      setNodeVisible(chip.el, !!model);
      if (!model) { return; }
      chip.swatch.setAttribute('material', 'color', model.color);
      setText(chip.label, model.text, model.active ? '#ffffff' : '#94a3b8');
    });
    setText(refs.agentsMore, chips.length > AGENT_CHIPS ? '+' + (chips.length - AGENT_CHIPS) : '');
  }

  function buildPanelContent() {
    var panel = entity('a-entity', { position: '0 0 0.04' });
    panel.appendChild(text('Agent sessions', PANEL.left + ' ' + PANEL.sectionY + ' 0.02', 2.6, '#a7f3d0', 'left', 30));
    refs.refreshButton = panelButton('Refresh', 1.55, PANEL.sectionY, 1.2, requestSources);
    refs.closeButton = panelButton('Close', 2.5, PANEL.sectionY, 0.62, closeSession, '#7f1d1d');
    panel.appendChild(refs.refreshButton.el);
    panel.appendChild(refs.closeButton.el);
    refs.sourceRows = [];
    for (var i = 0; i < SOURCE_PAGE_SIZE; i += 1) {
      refs.sourceRows.push(buildSourceRow(i));
      panel.appendChild(refs.sourceRows[i].el);
    }
    refs.sourcesEmpty = text('', '0 ' + (PANEL.rowsTopY - PANEL.rowGap) + ' 0.02', 5.4, '#94a3b8', 'center', 60);
    panel.appendChild(refs.sourcesEmpty);
    refs.pagePrev = panelButton('<', -0.75, PANEL.pagerY, 0.5, function () { state.sourcePage -= 1; renderPanel(); });
    refs.pageNext = panelButton('>', 0.75, PANEL.pagerY, 0.5, function () { state.sourcePage += 1; renderPanel(); });
    refs.pageText = text('', '0 ' + PANEL.pagerY + ' 0.02', 1.2, '#cbd5e1', 'center', 12);
    panel.appendChild(refs.pagePrev.el);
    panel.appendChild(refs.pageNext.el);
    panel.appendChild(refs.pageText);
    panel.appendChild(entity('a-plane', {
      position: '0 ' + (PANEL.stepY + 0.27) + ' 0.015', width: 5.8, height: 0.012,
      material: 'color: ' + ACCENT + '; opacity: 0.6; transparent: true; shader: flat'
    }));
    refs.panelStep = text('', PANEL.left + ' ' + PANEL.stepY + ' 0.02', 5.7, '#f8fafc', 'left', 50);
    panel.appendChild(refs.panelStep);
    buildTransport(panel);
    buildToggles(panel);
    buildAgentChips(panel);
    buildMetricCells(panel);
    refs.panelStatus = text('', PANEL.left + ' ' + PANEL.statusY + ' 0.02', 5.7, '#fde68a', 'left', 58);
    panel.appendChild(refs.panelStatus);
    return panel;
  }

  function buildPanel() {
    var mapping = root.CodeXRMappingUiRuntime;
    if (refs.panel || !mapping?.registerPanelView) { return !!refs.panel; }
    if (mapping.isPanelReady && !mapping.isPanelReady()) {
      if (!refs.panelMountQueued) {
        refs.panelMountQueued = true;
        mapping.whenPanelReady?.(function () {
          refs.panelMountQueued = false;
          buildPanel();
        });
      }
      return false;
    }
    refs.panel = buildPanelContent();
    state.unregisterPanel = mapping.registerPanelView({
      id: MODE,
      title: 'Agent flow',
      headerButton: false,
      panelHeight: PANEL.height,
      content: refs.panel,
      onShow: function () {
        if (!state.sources.length && !state.sourcesRequested) { requestSources(); }
        renderPanel();
      }
    }) || null;
    renderPanel();
    return true;
  }

  function sourceRowTitle(source) {
    return compact((source.agent || 'Agent') + '  -  ' + (source.label || source.id), 48);
  }

  function renderSources() {
    var page = sourcesPage(state.sources, state.sourcePage, SOURCE_PAGE_SIZE);
    state.sourcePage = page.page;
    refs.pageSources = page.items;
    refs.sourceRows.forEach(function (row, index) {
      var source = page.items[index];
      setNodeVisible(row.el, !!source);
      if (!source) { return; }
      setText(row.title, sourceRowTitle(source));
      setText(row.time, relativeTime(source.updatedAt, Date.now()));
      setNodeVisible(row.badge, !!source.live);
      paintButton(row, source.id === state.activeSourceId ? '#065f46' : '#1e293b');
    });
    setText(refs.sourcesEmpty, page.total ? '' : (state.sourcesRequested ? 'No agent sessions found for this folder yet.' : 'Press Refresh to list agent sessions.'));
    setText(refs.pageText, page.pages > 1 ? (page.page + 1) + ' / ' + page.pages : '');
    setNodeVisible(refs.pagePrev.el, page.pages > 1);
    setNodeVisible(refs.pageNext.el, page.pages > 1);
  }

  function renderTransport() {
    var playback = state.playback?.getState() || { playing: false, speed: 1, followLive: true, count: 0 };
    var enabled = !!view && playback.count > 0;
    setText(refs.transport.play.label, playback.playing ? 'Pause' : 'Play');
    Object.keys(refs.transport).forEach(function (key) {
      paintButton(refs.transport[key], !enabled ? BUTTON_DISABLED : (key === 'play' ? BUTTON_ACTIVE : BUTTON_IDLE));
    });
    refs.speeds.forEach(function (button) {
      paintButton(button, button.speed === playback.speed ? BUTTON_ACTIVE : BUTTON_IDLE);
    });
    paintButton(refs.follow, playback.followLive ? BUTTON_ACTIVE : BUTTON_IDLE);
    refs.toggleButtons.forEach(function (button) {
      paintButton(button, state.toggles[button.key] ? BUTTON_ACTIVE : BUTTON_IDLE);
    });
  }

  function renderPanel() {
    if (!refs.panel) { return; }
    renderSources();
    renderTransport();
    renderAgentChips();
    var metrics = state.dataset ? metricsModel(state.dataset) : [];
    refs.metricCells.forEach(function (cell, index) {
      setText(cell.label, metrics[index]?.label || '');
      setText(cell.value, metrics[index]?.value || '');
    });
    var stepText = view ? stepLine(view.timeline, view.cityState ? view.cityState.stepIndex : -1) : 'No session open';
    setText(refs.panelStep, stepText);
    setNodeVisible(refs.closeButton.el, !!state.entity?.sourceId || !!state.dataset);
    setStatus(state.status, state.statusError);
  }

  function setToggle(key, enabled) {
    if (!Object.prototype.hasOwnProperty.call(state.toggles, key)) { return; }
    state.toggles[key] = !!enabled;
    refreshStatic();
    renderPanel();
  }
