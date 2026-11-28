// == agentFlowRuntime.js | sceneOverlays (assembled per manifest.json; see COMPONENTS.md) ==
  // The static summaries that answer questions without playing anything
  // (research.md section 3.2): turn rings, Heat delta caps, deletion ghosts,
  // blast-radius arcs with the unread dependents, and the agent's path. Plus
  // the floating label and the hover tooltip. All
  // decoration: none of it carries the raycaster class.

  function buildTurnRings(v) {
    var T = three();
    var capacity = v.files.reduce(function (sum, file) { return sum + Math.max(1, file.turns.length); }, 0) || 1;
    var geometry = track(v, new T.BoxGeometry(1, 1, 1));
    var mesh = new T.InstancedMesh(geometry, track(v, new T.MeshBasicMaterial({ color: '#ffffff' })), capacity);
    mesh.count = 0;
    mesh.name = 'agentFlowTurnRings';
    v.group.add(mesh);
    v.rings = { mesh: mesh, capacity: capacity };
  }

  function updateTurnRings(v, cityState) {
    var rings = v.rings;
    var turnCount = Math.max(1, v.timeline.turns.length);
    var used = 0;
    if (state.toggles.rings) {
      cityState.files.forEach(function (fileState, index) {
        if (!fileState.turns.length || v.heights[index] <= 0.0005) { return; }
        var file = v.files[index];
        fileState.turns.slice().sort(function (a, b) { return a - b; }).forEach(function (turn, level) {
          if (used >= rings.capacity) { return; }
          v.matrix.makeScale(file.w * FOOTPRINT_FILL + 0.024, 0.007, file.d * FOOTPRINT_FILL + 0.024);
          v.matrix.setPosition(file.x, v.baseY[index] + 0.012 + level * 0.017, file.z);
          rings.mesh.setMatrixAt(used, v.matrix);
          rings.mesh.setColorAt(used, v.color.set(turnColor(turnOrder(v, turn), turnCount)));
          used += 1;
        });
      });
    }
    rings.mesh.count = used;
    rings.mesh.instanceMatrix.needsUpdate = true;
    if (rings.mesh.instanceColor) { rings.mesh.instanceColor.needsUpdate = true; }
  }

  function turnOrder(v, turnIndex) {
    var turn = v.timeline.turns.find(function (candidate) { return candidate.index === turnIndex; });
    return turn ? turn.order : 0;
  }

  function buildDeltaCaps(v) {
    var T = three();
    var written = v.files.filter(function (file) { return file.touches.writes > 0 || file.delta; });
    var mesh = new T.InstancedMesh(
      track(v, new T.BoxGeometry(1, 1, 1)),
      track(v, new T.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4, metalness: 0.1, emissive: '#1f2937', emissiveIntensity: 0.4 })),
      Math.max(1, written.length)
    );
    mesh.count = 0;
    v.group.add(mesh);
    v.caps = {
      mesh: mesh,
      maxAbs: written.reduce(function (max, file) { return Math.max(max, Math.abs(file.delta?.codeLines || 0)); }, 1)
    };
  }

  function updateDeltaCaps(v, cityState) {
    var caps = v.caps;
    var used = 0;
    if (state.toggles.heat) {
      cityState.files.forEach(function (fileState, index) {
        var file = v.files[index];
        if (!(fileState.touches.writes > 0) || !file.delta || fileState.deleted || v.heights[index] <= 0.0005) { return; }
        var style = deltaCapStyle(file.delta.codeLines, caps.maxAbs);
        v.matrix.makeScale(file.w * FOOTPRINT_FILL + 0.012, style.thickness, file.d * FOOTPRINT_FILL + 0.012);
        v.matrix.setPosition(file.x, v.baseY[index] + v.heights[index] + style.thickness / 2, file.z);
        caps.mesh.setMatrixAt(used, v.matrix);
        caps.mesh.setColorAt(used, v.color.set(style.color));
        used += 1;
      });
    }
    caps.mesh.count = used;
    caps.mesh.instanceMatrix.needsUpdate = true;
    if (caps.mesh.instanceColor) { caps.mesh.instanceColor.needsUpdate = true; }
  }

  function buildGhosts(v) {
    var T = three();
    v.ghosts = {};
    v.files.forEach(function (file, index) {
      if (!file.deleted) { return; }
      var height = Math.max(0.06, file.h);
      var box = new T.BoxGeometry(file.w * FOOTPRINT_FILL, height, file.d * FOOTPRINT_FILL);
      box.translate(0, height / 2, 0);
      var lines = new T.LineSegments(track(v, new T.EdgesGeometry(box)), track(v, new T.LineBasicMaterial({
        color: '#94a3b8', transparent: true, opacity: 0.55, depthWrite: false
      })));
      box.dispose();
      lines.position.set(file.x, v.baseY[index], file.z);
      lines.visible = false;
      v.group.add(lines);
      v.ghosts[index] = lines;
    });
  }

  function updateGhosts(v, cityState) {
    Object.keys(v.ghosts).forEach(function (key) {
      v.ghosts[key].visible = !!cityState.files[key]?.deleted;
    });
  }

  function arcPoints(from, to, lift, segments) {
    var control = { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + lift, z: (from.z + to.z) / 2 };
    var points = [];
    for (var i = 0; i <= segments; i += 1) { points.push(bezierPoint(from, control, to, i / segments)); }
    return points;
  }

  /** Line-segment geometry for arcs, colour + alpha per arc. */
  function arcGeometry(arcs) {
    var T = three();
    var positions = [];
    var colors = [];
    var color = new T.Color();
    arcs.forEach(function (arc) {
      color.set(arc.color);
      for (var i = 0; i < arc.points.length - 1; i += 1) {
        [arc.points[i], arc.points[i + 1]].forEach(function (point, end) {
          positions.push(point.x, point.y, point.z);
          var fade = arc.fadeEnds ? 0.35 + 0.65 * Math.sin(Math.PI * ((i + end) / (arc.points.length - 1))) : 1;
          colors.push(color.r, color.g, color.b, arc.alpha * fade);
        });
      }
    });
    var geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new T.Float32BufferAttribute(colors, 4));
    return geometry;
  }

  function replaceArcLines(v, key, arcs) {
    var T = three();
    if (v[key]) {
      v.group.remove(v[key]);
      v[key].geometry.dispose();
      v[key].material.dispose();
      v[key] = null;
    }
    if (!arcs.length) { return; }
    v[key] = new T.LineSegments(arcGeometry(arcs), new T.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    v[key].frustumCulled = false;
    v.group.add(v[key]);
  }

  var BLAST_TUBE_LIMIT = 160;

  /** Thick arcs (tubes): a 1 px line is unreadable at table distance. */
  function replaceArcTubes(v, key, arcs, radius) {
    var T = three();
    if (v[key]) {
      v.group.remove(v[key]);
      v[key].children.forEach(function (mesh) { mesh.geometry.dispose(); mesh.material.dispose(); });
      v[key] = null;
    }
    if (!arcs.length) { return; }
    var group = new T.Group();
    arcs.slice(0, BLAST_TUBE_LIMIT).forEach(function (arc) {
      var curve = new T.CatmullRomCurve3(arc.points.map(function (point) { return new T.Vector3(point.x, point.y, point.z); }));
      var mesh = new T.Mesh(
        new T.TubeGeometry(curve, Math.max(8, arc.points.length), radius, 6, false),
        new T.MeshBasicMaterial({ color: arc.color, transparent: true, opacity: arc.alpha, depthWrite: false })
      );
      mesh.frustumCulled = false;
      group.add(mesh);
    });
    v[key] = group;
    v.group.add(group);
  }

  function updateBlastRadius(v, cityState) {
    var arcs = [];
    var unread = [];
    if (state.toggles.blast) {
      var unreadSet = unreadDependentSet(v, cityState);
      v.dataset.blastRadius.forEach(function (entry) {
        if (!(cityState.files[entry.file]?.touches.writes > 0)) { return; }
        var from = roofPoint(v, entry.file);
        entry.dependents.forEach(function (dependent) {
          var to = roofPoint(v, dependent);
          var distance = Math.hypot(to.x - from.x, to.z - from.z);
          arcs.push({
            points: arcPoints(from, to, 0.18 + distance * 0.35, 28),
            color: unreadSet[dependent] ? COLORS.unread : '#fdba74',
            alpha: unreadSet[dependent] ? 0.95 : 0.7
          });
        });
      });
      unread = Object.keys(unreadSet).map(Number);
    }
    replaceArcTubes(v, 'blastLines', arcs, 0.009);
    updateUnreadHalos(v, unread);
  }

  /** Unread dependents wear amber hazard tape (drawn by the city, see syncSite); this keeps the count. */
  function updateUnreadHalos(v, unread) {
    v.unreadCount = unread.length;
  }

  /** The agent's path as faint arcs, brighter for moves it made more often. */
  function updateAgentPath(v, cityState) {
    var atEnd = cityState.stepIndex >= v.timeline.count - 1;
    // Blast radius owns the sky while it is on: two families of arcs at once
    // read as noise.
    var show = state.toggles.trail && !state.toggles.blast && atEnd && v.timeline.count > 0 && !state.playback?.getState().playing;
    if (!show) {
      replaceArcLines(v, 'pathLines', []);
      return;
    }
    if (v.pathLines) { return; }
    var maxCount = v.dataset.transitions.reduce(function (max, move) { return Math.max(max, Number(move.count) || 1); }, 1);
    var arcs = v.dataset.transitions.filter(function (move) { return move.from !== move.to; }).map(function (move) {
      var from = roofPoint(v, move.from);
      var to = roofPoint(v, move.to);
      var weight = (Number(move.count) || 1) / maxCount;
      return {
        points: arcPoints(from, to, 0.1 + Math.hypot(to.x - from.x, to.z - from.z) * 0.2, 22),
        color: mixHex('#7dd3fc', COLORS.probe, weight),
        alpha: 0.28 + weight * 0.55,
        fadeEnds: true
      };
    });
    replaceArcLines(v, 'pathLines', arcs);
  }

  // -- Floating label over the current building --------------------------------

  function buildFloatingLabel(v) {
    var label = entity('a-entity', { visible: 'false', 'data-codexr-role': 'agent-flow current-step-label' });
    var backing = entity('a-plane', { width: 1.0, height: 0.2, material: 'color: #0b1220; opacity: 0.86; transparent: true; shader: flat' });
    var accent = entity('a-plane', { position: '-0.49 0 0.001', width: 0.02, height: 0.2, material: 'color: ' + COLORS.read + '; shader: flat' });
    var title = text('', '-0.45 0.042 0.002', 0.95, '#f8fafc', 'left', 30);
    var verb = text('', '-0.45 -0.048 0.002', 0.85, COLORS.read, 'left', 34);
    label.appendChild(backing);
    label.appendChild(accent);
    label.appendChild(title);
    label.appendChild(verb);
    v.rootEl.appendChild(label);
    v.label = { el: label, backing: backing, accent: accent, title: title, verb: verb, anchor: null };
  }

  function updateFloatingLabel(v, cityState) {
    var step = cityState.current;
    var label = v.label;
    if (!step) {
      setNodeVisible(label.el, false);
      label.anchor = null;
      return;
    }
    var color = kindColor(step.kind, step.failed);
    var title;
    var anchor;
    if (step.target.type === 'console') {
      title = compact(step.command || step.title, 34);
      anchor = { x: CONSOLE_PILLAR.x + 0.62, y: CONSOLE_PILLAR.height + 0.66, z: CONSOLE_PILLAR.z };
    } else if (step.target.type === 'none') {
      title = compact(step.title, 34);
      var rest = workerRest(v, step.actor) || { x: 0, y: 0.3, z: 0 };
      anchor = { x: rest.x, y: rest.y + 0.46, z: rest.z };
    } else {
      var primary = step.target.type === 'file' ? step.target.primary : step.target.files[0];
      title = step.target.type === 'files' ? compact(step.title, 34) : compact(v.files[primary]?.name || step.title, 34);
      var point = step.target.type === 'files' ? centroidOf(v, step.target.files) : roofPoint(v, primary);
      anchor = { x: point.x, y: point.y + (step.target.type === 'files' ? 0.5 : 0.46), z: point.z };
    }
    setText(label.title, title);
    setText(label.verb, stepVerb(step, v.files[step.files[0]]), color);
    label.accent.setAttribute('material', 'color', color);
    label.anchor = anchor;
    label.el.setAttribute('position', anchor.x + ' ' + anchor.y + ' ' + anchor.z);
    setNodeVisible(label.el, true);
  }

  function faceYaw(el, camera) {
    if (!el?.object3D || !camera?.getWorldPosition) { return; }
    var T = three();
    var target = camera.getWorldPosition(v3(T));
    var parent = el.object3D.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      parent.worldToLocal(target);
    }
    el.object3D.rotation.set(0, Math.atan2(target.x - el.object3D.position.x, target.z - el.object3D.position.z), 0);
  }

  var scratchVector = null;
  function v3(T) {
    scratchVector = scratchVector || new T.Vector3();
    return scratchVector.set(0, 0, 0);
  }

  // -- Hover tooltip (instanceId -> file) ---------------------------------------

  function ensureTooltip(v) {
    if (v.tooltip !== undefined) { return v.tooltip; }
    var common = root.CodeXRCommonRuntime;
    v.tooltip = common?.createTooltip ? common.createTooltip({ width: 1.5, height: 0.6, accentColor: ACCENT, raycastClass: '' }) : null;
    if (v.tooltip) {
      v.tooltip.root.setAttribute('scale', '0.5 0.5 0.5');
      v.rootEl.appendChild(v.tooltip.root);
    }
    return v.tooltip;
  }

  function tooltipModel(v, fileIndex, fileState) {
    var file = v.files[fileIndex];
    var touches = fileState ? fileState.touches : { reads: 0, writes: 0, searches: 0 };
    return {
      title: file.name,
      subtitle: file.dir || v.dataset.rootName || '(root)',
      accentColor: state.toggles.heat ? heatColor(fileState, v.outside[fileIndex]) : ACCENT,
      rows: [
        { label: 'LOC', value: String(file.loc) },
        { label: 'Delta', value: file.delta ? formatSigned(file.delta.codeLines) + ' lines' : 'none' },
        { label: 'Reads', value: String(touches.reads) },
        { label: 'Writes', value: String(touches.writes) },
        { label: 'Searches', value: String(touches.searches) },
        { label: 'Turns', value: fileState?.turns.length ? fileState.turns.map(function (t) { return 'T' + (t + 1); }).join(' ') : '-' },
        { label: 'Dependents', value: file.dependents < 0 ? '?' : String(file.dependents) },
        { label: 'Scope', value: v.outside[fileIndex] ? 'outside' : (file.created ? 'created' : 'analysed') }
      ]
    };
  }

  function showTooltip(v, fileIndex) {
    var tooltip = ensureTooltip(v);
    if (!tooltip || v.hoverFile === fileIndex) { return; }
    v.hoverFile = fileIndex;
    if (fileIndex < 0) {
      root.CodeXRCommonRuntime.hideTooltip(tooltip);
      return;
    }
    var roof = roofPoint(v, fileIndex);
    root.CodeXRCommonRuntime.updateTooltip(
      tooltip,
      tooltipModel(v, fileIndex, v.cityState?.files[fileIndex]),
      { x: roof.x, y: roof.y + 0.32, z: roof.z },
      { width: 1.7, columns: 2, animationDuration: 120 }
    );
    tooltip.root.setAttribute('scale', '0.5 0.5 0.5');
  }

  /** Polls the active pointer: instanced buildings emit no per-instance mouseenter. */
  function pollHover(v, timeMs) {
    if (!v.buildingsEl || timeMs - (v.lastHoverPoll || 0) < 90) { return; }
    v.lastHoverPoll = timeMs;
    var hovered = -1;
    doc().querySelectorAll?.('[raycaster]').forEach(function (el) {
      var raycaster = el.components?.raycaster;
      if (hovered >= 0 || !raycaster || raycaster.data?.enabled === false) { return; }
      hovered = fileFromIntersection(raycaster.getIntersection?.(v.buildingsEl));
    });
    showTooltip(v, hovered);
  }
