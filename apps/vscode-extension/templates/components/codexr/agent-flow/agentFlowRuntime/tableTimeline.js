// == agentFlowRuntime.js | tableTimeline (assembled per manifest.json; see COMPONENTS.md) ==
  // The timeline lectern along the table's front edge: turn segments, one
  // tick per step coloured by kind, red marks on failures, a stacked bar per
  // turn (reads / searches / writes / commands, small multiples) and the
  // playhead. Clicking the strip seeks (the only raycastable part of it).

  var STRIP_Y = -0.065;
  var STRIP_H = 0.06;
  var BARS_BASE_Y = -0.02;
  var BARS_MAX_H = 0.085;
  var BAR_KINDS = ['read', 'search', 'write', 'execute'];

  function buildTimelineLectern(v) {
    var T = three();
    var W = TIMELINE.width;
    var lectern = entity('a-entity', {
      position: TIMELINE.x + ' ' + TIMELINE.y + ' ' + TIMELINE.z,
      rotation: TIMELINE.tilt + ' 0 0',
      'data-codexr-role': 'agent-flow timeline'
    });
    lectern.appendChild(entity('a-plane', {
      position: '0 0 -0.004', width: W + 0.24, height: TIMELINE.height,
      material: 'color: #0b1220; opacity: 0.92; transparent: true; shader: flat'
    }));
    lectern.appendChild(entity('a-plane', {
      position: '0 ' + (TIMELINE.height / 2 - 0.004) + ' -0.002', width: W + 0.24, height: 0.008,
      material: 'color: ' + ACCENT + '; opacity: 0.85; transparent: true; shader: flat'
    }));
    var header = text('', (-W / 2) + ' 0.205 0.001', 2.6, '#94a3b8', 'left', 84);
    var counter = text('', (W / 2) + ' 0.205 0.001', 1.4, '#94a3b8', 'right', 44);
    var stepLineText = text('', (-W / 2) + ' 0.135 0.001', 3.6, '#f1f5f9', 'left', 70);
    var badge = entity('a-entity', { position: (W / 2 - 0.06) + ' 0.135 0.001', visible: 'false' });
    badge.appendChild(entity('a-plane', { width: 0.16, height: 0.055, material: 'color: #be123c; shader: flat' }));
    badge.appendChild(text('LIVE', '0 0 0.001', 0.5, '#ffffff', 'center', 12));
    [header, counter, stepLineText, badge].forEach(function (node) { lectern.appendChild(node); });
    // One swatch + label per verb, each label anchored at its own swatch.
    var legendItems = [
      ['read', COLORS.read], ['search', COLORS.search], ['write', COLORS.write],
      ['run', COLORS.executeOk], ['wait', COLORS.unread], ['delegate', COLORS.think], ['failed', COLORS.failed]
    ];
    legendItems.forEach(function (item, order) {
      var x = -W / 2 + 0.03 + order * 0.3;
      lectern.appendChild(entity('a-plane', {
        position: x + ' -0.205 0.001', width: 0.03, height: 0.03,
        material: 'color: ' + item[1] + '; shader: flat'
      }));
      lectern.appendChild(text(item[0], (x + 0.03) + ' -0.205 0.001', 0.5, '#94a3b8', 'left', 16));
    });
    var strip = entity('a-plane', {
      position: '0 ' + (STRIP_Y + 0.015) + ' 0.004', width: W, height: 0.16,
      material: 'color: #000000; opacity: 0.001; transparent: true; shader: flat; depthWrite: false',
      class: RAYCAST_CLASS + ' codexr-agent-flow-timeline',
      'data-codexr-interactive': 'true'
    });
    strip.addEventListener('click', function (event) {
      var count = v.timeline.count;
      if (!count || !state.playback) { return; }
      var point = event?.detail?.intersection?.point;
      if (!point || !strip.object3D) { return; }
      var localX = strip.object3D.worldToLocal(point.clone()).x;
      var ratio = Math.min(0.9999, Math.max(0, (localX + W / 2) / W));
      state.playback.seek(Math.floor(ratio * count));
    });
    lectern.appendChild(strip);
    var group = new T.Group();
    lectern.setObject3D('agentFlowTimeline', group);
    v.rootEl.appendChild(lectern);
    v.lectern = {
      el: lectern, group: group, header: header, counter: counter, stepLine: stepLineText,
      badge: badge, strip: strip, labels: [], meshes: []
    };
  }

  function instancedPlanes(v, count, opacity) {
    var T = three();
    var geometry = track(v, new T.PlaneGeometry(1, 1));
    var material = track(v, new T.MeshBasicMaterial({ color: '#ffffff', transparent: opacity < 1, opacity: opacity }));
    var mesh = new T.InstancedMesh(geometry, material, Math.max(1, count));
    mesh.count = 0;
    return mesh;
  }

  function placePlane(v, mesh, slot, rect, color) {
    v.matrix.makeScale(Math.max(0.0005, rect.w), Math.max(0.0005, rect.h), 1);
    v.matrix.setPosition(rect.x, rect.y, rect.z || 0);
    mesh.setMatrixAt(slot, v.matrix);
    mesh.setColorAt(slot, v.color.set(color));
  }

  function clearTimelineGraphics(v) {
    var lectern = v.lectern;
    lectern.meshes.forEach(function (mesh) {
      lectern.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    });
    lectern.meshes = [];
    lectern.labels.forEach(function (label) { label.parentNode?.removeChild(label); });
    lectern.labels = [];
  }

  function stepX(count, index) {
    return -TIMELINE.width / 2 + ((index + 0.5) / Math.max(1, count)) * TIMELINE.width;
  }

  function buildTurnSegments(v, count) {
    var W = TIMELINE.width;
    var turns = v.timeline.turns.filter(function (turn) { return turn.start >= 0; });
    var segments = instancedPlanes(v, turns.length, 1);
    var bars = instancedPlanes(v, turns.length * BAR_KINDS.length, 1);
    var maxTotal = turns.reduce(function (max, turn) {
      return Math.max(max, BAR_KINDS.reduce(function (sum, kind) { return sum + turn.counts[kind]; }, 0));
    }, 1);
    var barSlot = 0;
    turns.forEach(function (turn, order) {
      var x0 = -W / 2 + (turn.start / count) * W;
      var x1 = -W / 2 + ((turn.end + 1) / count) * W;
      placePlane(v, segments, order, { x: (x0 + x1) / 2, y: STRIP_Y, w: Math.max(0.004, x1 - x0 - 0.006), h: STRIP_H }, order % 2 ? '#1e293b' : '#263449');
      var barWidth = Math.min(0.09, Math.max(0.012, (x1 - x0) * 0.32));
      var y = BARS_BASE_Y;
      BAR_KINDS.forEach(function (kind) {
        var height = (turn.counts[kind] / maxTotal) * BARS_MAX_H;
        if (height > 0) {
          placePlane(v, bars, barSlot, { x: (x0 + x1) / 2, y: y + height / 2, w: barWidth, h: height }, kindColor(kind, false));
          barSlot += 1;
          y += height;
        }
      });
      if (v.lectern.labels.length < 60 && x1 - x0 > 0.05) {
        var label = text(turn.label, ((x0 + x1) / 2) + ' -0.132 0.002', 0.8, '#cbd5e1', 'center', 22);
        v.lectern.el.appendChild(label);
        v.lectern.labels.push(label);
      }
    });
    segments.count = turns.length;
    bars.count = barSlot;
    return [segments, bars];
  }

  function buildTicks(v, count) {
    var ticks = instancedPlanes(v, count, 1);
    var failures = instancedPlanes(v, count, 1);
    var tickWidth = Math.max(0.0025, Math.min(0.03, (TIMELINE.width / count) * 0.55));
    var failSlot = 0;
    v.timeline.steps.forEach(function (step, index) {
      var x = stepX(count, index);
      placePlane(v, ticks, index, { x: x, y: STRIP_Y, w: tickWidth, h: STRIP_H * 0.62, z: 0.001 }, kindColor(step.kind, false));
      if (step.failed) {
        placePlane(v, failures, failSlot, { x: x, y: STRIP_Y + STRIP_H * 0.5 + 0.012, w: Math.max(tickWidth, 0.014), h: 0.014, z: 0.001 }, COLORS.failed);
        failSlot += 1;
      }
    });
    ticks.count = count;
    failures.count = failSlot;
    return [ticks, failures];
  }

  /** Rebuilds segments, ticks and bars for the current timeline (also after a live append). */
  function buildTimelineGraphics(v) {
    var T = three();
    clearTimelineGraphics(v);
    var count = v.timeline.count;
    var progress = instancedPlanes(v, 1, 0.75);
    var playhead = new T.Mesh(track(v, new T.PlaneGeometry(0.012, STRIP_H + 0.05)), track(v, new T.MeshBasicMaterial({ color: COLORS.playhead })));
    playhead.position.set(-TIMELINE.width / 2, STRIP_Y, 0.002);
    var meshes = [progress];
    if (count) {
      meshes = meshes.concat(buildTurnSegments(v, count), buildTicks(v, count));
    }
    meshes.forEach(function (mesh) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) { mesh.instanceColor.needsUpdate = true; }
      v.lectern.group.add(mesh);
    });
    v.lectern.group.add(playhead);
    v.lectern.meshes = meshes;
    v.lectern.progress = progress;
    v.lectern.playhead = playhead;
  }

  function updateTimelineLectern(v, cityState) {
    var lectern = v.lectern;
    var count = v.timeline.count;
    var index = cityState.stepIndex;
    var session = v.dataset.session || {};
    setText(lectern.header, compact((session.agent || 'Agent') + '  -  ' + (session.label || session.id || '') + (v.dataset.rootName ? '  -  ' + v.dataset.rootName : ''), 84));
    setText(lectern.counter, count ? 'Step ' + (index + 1) + ' / ' + count : 'No steps yet');
    setText(lectern.stepLine, count ? stepLine(v.timeline, index) : 'The agent has not touched any file yet.', cityState.current?.failed ? '#fda4af' : '#f1f5f9');
    setNodeVisible(lectern.badge, !!session.live);
    var x = index < 0 ? -TIMELINE.width / 2 : stepX(count, index);
    lectern.playhead.position.x = x;
    lectern.playhead.visible = count > 0;
    var fillWidth = x + TIMELINE.width / 2;
    v.matrix.makeScale(Math.max(0.0005, fillWidth), 0.008, 1);
    v.matrix.setPosition(-TIMELINE.width / 2 + fillWidth / 2, STRIP_Y - STRIP_H / 2 - 0.008, 0.001);
    lectern.progress.setMatrixAt(0, v.matrix);
    lectern.progress.setColorAt(0, v.color.set(ACCENT));
    lectern.progress.count = count ? 1 : 0;
    lectern.progress.instanceMatrix.needsUpdate = true;
    if (lectern.progress.instanceColor) { lectern.progress.instanceColor.needsUpdate = true; }
  }

  // -- Table hint (idle, loading, error, empty) ---------------------------------

  function buildHint(rootEl) {
    var hint = entity('a-entity', { position: '0 0.42 0', 'data-codexr-role': 'agent-flow hint' });
    var title = text('Pick an agent session in the controller', '0 0.06 0', 3.4, '#e2e8f0', 'center', 40);
    var detail = text('', '0 -0.12 0', 3.0, '#94a3b8', 'center', 56);
    hint.appendChild(title);
    hint.appendChild(detail);
    rootEl.appendChild(hint);
    return { el: hint, title: title, detail: detail };
  }

  function showHint(title, detail, isError) {
    if (!refs.hint) { return; }
    setText(refs.hint.title, title, isError ? '#fca5a5' : '#e2e8f0');
    setText(refs.hint.detail, detail || '');
    setNodeVisible(refs.hint.el, !!title);
  }
