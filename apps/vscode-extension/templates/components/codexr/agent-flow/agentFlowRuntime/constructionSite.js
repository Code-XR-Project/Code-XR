// == agentFlowRuntime.js | constructionSite (assembled per manifest.json; see COMPONENTS.md) ==
  // The construction site on top of the city: every agent is a worker on the
  // table (the main agent emerald, each subagent its own colour), working in
  // parallel. A worker's action lasts until that worker's next step, so
  // several stay busy at once: a scanning cone on a read, a radar ripple and
  // beacons on a search, scaffolding with a crane and new floors on a write,
  // the test tower on a run, a thought bubble, an amber "!" while waiting for
  // permission. Persistent site marks (scaffolds, foundations, hazard stripes,
  // tape) are recomputed from the playhead (syncSite), so seeking is exact.
  // Everything on the buildings goes through the codexr-city API (v.city).

  var WORKER_HOVER = 0.006;
  var MAIN_HOME = { x: -2.3, y: 0, z: 1.42 };

  // -- Test tower (the control station every run goes to) -----------------------

  function buildTestTower(v) {
    var T = three();
    var tower = new T.Group();
    var x = CONSOLE_PILLAR.x;
    var z = CONSOLE_PILLAR.z;
    var h = CONSOLE_PILLAR.height;
    var steel = track(v, new T.MeshStandardMaterial({ color: '#475569', roughness: 0.5, metalness: 0.4, flatShading: true }));
    var box = unitBoxGeometry(v);
    var leg = 0.07;
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (corner) {
      var post = new T.Mesh(box, steel);
      post.scale.set(0.008, h, 0.008);
      post.position.set(corner[0] * leg, h / 2, corner[1] * leg);
      tower.add(post);
    });
    // Cross bracing as lines (a lattice reads as "structure", not a block).
    var brace = [];
    for (var level = 0; level < 4; level += 1) {
      var y0 = (level / 4) * h;
      var y1 = ((level + 1) / 4) * h;
      [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]].forEach(function (s) {
        brace.push(s[0] * leg, y0, s[1] * leg, s[2] * leg, y1, s[3] * leg);
        brace.push(s[0] * leg, y1, s[1] * leg, s[2] * leg, y1, s[3] * leg);
      });
    }
    var braceGeometry = track(v, new T.BufferGeometry());
    braceGeometry.setAttribute('position', new T.Float32BufferAttribute(brace, 3));
    tower.add(new T.LineSegments(braceGeometry, track(v, new T.LineBasicMaterial({ color: '#64748b' }))));
    var cabinMaterial = track(v, new T.MeshStandardMaterial({
      color: '#1e293b', roughness: 0.45, metalness: 0.3, emissive: '#0f766e', emissiveIntensity: 0.22, flatShading: true
    }));
    var cabin = new T.Mesh(box, cabinMaterial);
    cabin.scale.set(0.12, 0.07, 0.12);
    cabin.position.set(0, h + 0.035, 0);
    tower.add(cabin);
    var deck = new T.Mesh(box, track(v, new T.MeshBasicMaterial({ color: '#64748b' })));
    deck.scale.set(0.2, 0.008, 0.2);
    deck.position.set(0, h + 0.074, 0);
    tower.add(deck);
    // The light stack on the front face: chases while a run is going.
    var lights = [];
    for (var i = 0; i < 6; i += 1) {
      var lamp = new T.Mesh(box, new T.MeshBasicMaterial({ color: '#1f2937' }));
      lamp.scale.set(0.03, 0.022, 0.006);
      lamp.position.set(0, 0.05 + i * 0.045, leg + 0.006);
      tower.add(lamp);
      lights.push(lamp);
    }
    var siren = new T.Group();
    siren.position.set(0, h + 0.1, 0);
    var sirenBody = new T.Mesh(track(v, new T.CylinderGeometry(0.014, 0.018, 0.026, 12)), new T.MeshBasicMaterial({ color: '#7f1d1d' }));
    var sirenGlow = new T.Sprite(new T.SpriteMaterial({ map: glowTexture(v), color: COLORS.executeFailed, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
    sirenGlow.scale.set(0.16, 0.16, 0.16);
    var sirenBeam = new T.Mesh(track(v, new T.ConeGeometry(0.05, 0.22, 16, 1, true)), new T.MeshBasicMaterial({
      color: COLORS.executeFailed, transparent: true, opacity: 0.3, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending
    }));
    sirenBeam.rotation.z = Math.PI / 2;
    sirenBeam.position.x = 0.11;
    var beamPivot = new T.Group();
    beamPivot.add(sirenBeam);
    siren.add(sirenBody, sirenGlow, beamPivot);
    siren.visible = false;
    tower.add(siren);
    var check = new T.Sprite(new T.SpriteMaterial({ map: badgeTexture(v, 'check'), transparent: true, depthWrite: false }));
    check.scale.set(0.1, 0.1, 0.1);
    check.position.set(0, h + 0.2, 0);
    check.visible = false;
    tower.add(check);
    tower.position.set(x, 0, z);
    v.group.add(tower);
    v.tower = { group: tower, lights: lights, siren: siren, sirenGlow: sirenGlow, beamPivot: beamPivot, check: check, mode: 'idle', since: 0, phase: 0 };
    v.pillar = { body: cabin, cap: deck, material: cabinMaterial, idleCap: '#64748b', flash: null, lastColor: null };
    // At the foot of the tower, so it never collides with a worker's name tag on the deck.
    var label = text('test tower', x + ' 0.03 ' + (z + 0.17), 0.9, '#94a3b8', 'center', 20);
    label.setAttribute('rotation', '-60 0 0');
    v.rootEl.appendChild(label);
    v.pillarLabel = label;
  }

  function towerDeck(v, actorIndex) {
    var angle = (actorIndex || 0) * 2.1;
    var radius = actorIndex ? 0.055 : 0;
    return { x: CONSOLE_PILLAR.x + Math.cos(angle) * radius, y: CONSOLE_PILLAR.height + 0.078, z: CONSOLE_PILLAR.z + Math.sin(angle) * radius };
  }

  function setTowerMode(v, mode) {
    if (!v.tower || v.tower.mode === mode) { return; }
    v.tower.mode = mode;
    v.tower.since = 0;
  }

  function tickTower(v, dt) {
    var tower = v.tower;
    if (!tower) { return; }
    tower.since += dt;
    tower.phase += dt / 1000;
    var mode = tower.mode;
    // A run shows its lights running first, then its result.
    var running = mode !== 'idle' && state.motion && tower.since < 900;
    tower.lights.forEach(function (lamp, i) {
      var color = '#1f2937';
      if (running) {
        color = Math.floor(tower.phase * 14) % tower.lights.length === i ? '#fde68a' : '#334155';
      } else if (mode === 'ok') {
        color = COLORS.executeOk;
      } else if (mode === 'failed') {
        color = Math.floor(tower.phase * 4) % 2 === i % 2 ? COLORS.executeFailed : '#450a0a';
      }
      lamp.material.color.set(color);
    });
    tower.siren.visible = mode === 'failed' && !running;
    if (tower.siren.visible) {
      tower.beamPivot.rotation.y = state.motion ? tower.phase * 5 : 0.6;
      var blink = state.motion ? 0.6 + 0.4 * Math.abs(Math.sin(tower.phase * 6)) : 1;
      tower.sirenGlow.scale.setScalar(0.16 * blink + 0.04);
    }
    tower.check.visible = mode === 'ok' && !running;
    if (tower.check.visible) {
      var pop = state.motion ? easeOutBack(Math.min(1, (tower.since - 900) / 300)) : 1;
      tower.check.scale.setScalar(0.1 * Math.max(0.01, pop));
    }
  }

  function flashPillar(v, failed, durationMs) {
    if (!v.pillar) { return; }
    v.pillar.flash = { color: failed ? COLORS.executeFailed : COLORS.executeOk, t: 0, dur: Math.max(300, durationMs * 1.6) };
    pulseRing(v, { x: CONSOLE_PILLAR.x, y: 0.004, z: CONSOLE_PILLAR.z }, failed ? COLORS.executeFailed : COLORS.executeOk, 0.1, 0.4, durationMs * 1.4);
  }

  function tickPillar(v, dt) {
    var pillar = v.pillar;
    if (!pillar?.flash) { return; }
    var flash = pillar.flash;
    flash.t = Math.min(1, flash.t + dt / flash.dur);
    pillar.material.emissive.set(flash.color);
    pillar.material.emissiveIntensity = 0.15 + 1.4 * (1 - flash.t);
    pillar.cap.material.color.set(mixHex(pillar.idleCap, flash.color, 1 - flash.t));
    if (flash.t >= 1) {
      pillar.flash = null;
      pillar.material.emissive.set(pillar.lastColor || '#0f766e');
      pillar.material.emissiveIntensity = 0.22;
      pillar.cap.material.color.set(pillar.lastColor || pillar.idleCap);
    }
  }

  // -- Canvas badges (no font dependence: drawn as shapes) ----------------------

  function badgeTexture(v, kind) {
    v.badges = v.badges || {};
    if (v.badges[kind]) { return v.badges[kind]; }
    var T = three();
    var canvas = doc().createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    var ctx = canvas.getContext?.('2d');
    if (ctx) {
      var fill = { check: COLORS.executeOk, wait: '#f59e0b', rejected: COLORS.failed, bubble: '#f8fafc' }[kind] || '#ffffff';
      ctx.beginPath();
      ctx.arc(64, 64, 56, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#0b1220';
      ctx.stroke();
      ctx.fillStyle = '#0b1220';
      ctx.strokeStyle = '#0b1220';
      if (kind === 'check') {
        ctx.lineWidth = 16;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(36, 66);
        ctx.lineTo(56, 86);
        ctx.lineTo(94, 44);
        ctx.stroke();
      } else if (kind === 'wait' || kind === 'rejected') {
        ctx.fillRect(54, 26, 20, 50);
        ctx.fillRect(54, 86, 20, 18);
      } else if (kind === 'bubble') {
        [40, 64, 88].forEach(function (cx) { ctx.beginPath(); ctx.arc(cx, 64, 10, 0, Math.PI * 2); ctx.fill(); });
      }
    }
    v.badges[kind] = track(v, new T.CanvasTexture(canvas));
    return v.badges[kind];
  }

  // -- Workers -----------------------------------------------------------------

  function workerGeometries(v) {
    if (v.workerGeometries) { return v.workerGeometries; }
    var T = three();
    var shared = function (geometry) { geometry.userData.shared = true; return track(v, geometry); };
    var ring = new T.TorusGeometry(0.024, 0.0035, 6, 24);
    ring.rotateX(Math.PI / 2);
    v.workerGeometries = {
      ring: shared(ring),
      body: shared(new T.CylinderGeometry(0.014, 0.02, 0.036, 8)),
      head: shared(new T.SphereGeometry(0.016, 12, 8)),
      visor: shared(new T.BoxGeometry(0.022, 0.008, 0.006)),
      antenna: shared(new T.BoxGeometry(0.0025, 0.016, 0.0025)),
      tip: shared(new T.SphereGeometry(0.0045, 8, 6)),
      dot: shared(new T.SphereGeometry(0.0055, 8, 6))
    };
    return v.workerGeometries;
  }

  function createWorker(v, lane) {
    var T = three();
    var g = workerGeometries(v);
    var group = new T.Group();
    group.name = 'agentFlowWorker-' + lane.index;
    var body = new T.Group();
    var paint = track(v, new T.MeshStandardMaterial({ color: lane.color, roughness: 0.5, metalness: 0.1, flatShading: true }));
    var shell = track(v, new T.MeshStandardMaterial({ color: mixHex(lane.color, '#ffffff', 0.6), roughness: 0.4, flatShading: true }));
    var ringMaterial = track(v, new T.MeshBasicMaterial({ color: lane.color, transparent: true, opacity: 0.9, depthWrite: false, blending: T.AdditiveBlending }));
    var ring = new T.Mesh(g.ring, ringMaterial);
    ring.position.y = 0.008;
    var torso = new T.Mesh(g.body, paint);
    torso.position.y = 0.032;
    var head = new T.Mesh(g.head, shell);
    head.position.y = 0.064;
    var visor = new T.Mesh(g.visor, track(v, new T.MeshBasicMaterial({ color: '#0b1220' })));
    visor.position.set(0, 0.066, 0.0135);
    var antenna = new T.Mesh(g.antenna, paint);
    antenna.position.y = 0.085;
    var tip = new T.Mesh(g.tip, track(v, new T.MeshBasicMaterial({ color: mixHex(lane.color, '#ffffff', 0.3) })));
    tip.position.y = 0.095;
    body.add(torso, head, visor, antenna, tip);
    var glow = new T.Sprite(track(v, new T.SpriteMaterial({ map: glowTexture(v), color: lane.color, transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0.55 })));
    glow.scale.set(0.12, 0.12, 0.12);
    glow.position.y = 0.04;
    group.add(ring, body, glow);
    var scale = lane.kind === 'main' ? 2.0 : 1.55;
    group.scale.setScalar(scale);
    group.visible = false;
    v.group.add(group);
    // Name tag: a small dark card with a colour stripe, turned to the viewer.
    var tag = entity('a-entity', { visible: 'false', scale: '1.9 1.9 1.9', 'data-codexr-role': 'agent-flow worker-tag' });
    var label = compact(lane.label, lane.kind === 'main' ? 22 : 26);
    var width = Math.max(0.16, Math.min(0.46, 0.05 + label.length * 0.0125));
    tag.appendChild(entity('a-plane', { width: width, height: 0.046, material: 'color: #0b1220; opacity: 0.88; transparent: true; shader: flat' }));
    tag.appendChild(entity('a-plane', { position: (-width / 2 + 0.004) + ' 0 0.001', width: 0.008, height: 0.046, material: 'color: ' + lane.color + '; shader: flat' }));
    tag.appendChild(text(label, (-width / 2 + 0.014) + ' 0 0.002', 0.36, '#f8fafc', 'left', 30));
    v.rootEl.appendChild(tag);
    return {
      actor: lane.index, lane: lane, color: lane.color, group: group, body: body, ring: ring, glow: glow, tag: tag,
      scale: scale, rest: null, hop: null, phase: lane.index * 1.7, present: false, pop: 1, dissolve: null,
      props: [], propKey: '', spot: null
    };
  }

  function ensureWorker(v, actorIndex) {
    v.workers = v.workers || [];
    if (v.workers[actorIndex]) { return v.workers[actorIndex]; }
    var lane = v.timeline.actors[actorIndex];
    if (!lane) { return null; }
    var shown = v.workers.filter(Boolean).length;
    if (shown >= WORKER_CAP && lane.kind !== 'main') { return null; }
    v.workers[actorIndex] = createWorker(v, lane);
    return v.workers[actorIndex];
  }

  function destroyWorkers(v) {
    (v.workers || []).forEach(function (worker) {
      if (!worker) { return; }
      clearWorkerProps(v, worker);
      v.group.remove(worker.group);
      worker.tag?.parentNode?.removeChild?.(worker.tag);
    });
    v.workers = [];
  }

  function slotOffset(actorIndex) {
    if (!actorIndex) { return { x: 0, z: 0 }; }
    var angle = actorIndex * 2.4;
    return { x: Math.cos(angle) * 0.03, z: Math.sin(angle) * 0.03 };
  }

  /** Where a step puts its worker (table-local feet position); deterministic, memoized per render. */
  function spotForStep(v, stepIndex, memo) {
    if (memo && memo[stepIndex]) { return memo[stepIndex]; }
    var step = v.timeline.steps[stepIndex];
    var spot = null;
    if (step) {
      var slot = slotOffset(step.actor);
      if (step.target.type === 'console') {
        spot = towerDeck(v, step.actor);
      } else if (step.target.type === 'files') {
        var centre = centroidOf(v, step.target.files);
        spot = { x: centre.x + slot.x, y: centre.y + 0.08, z: centre.z + slot.z };
      } else if (step.target.type === 'file') {
        var top = v.city.getBuildingTop(step.target.primary);
        var foot = v.city.getFootprint(step.target.primary);
        // A write stands on the corner away from the crane; a read in the middle.
        var dx = step.kind === 'write' ? -foot.w * 0.22 : 0;
        var dz = step.kind === 'write' ? foot.d * 0.22 : 0;
        spot = { x: top.x + dx + slot.x * 0.5, y: top.y, z: top.z + dz + slot.z * 0.5 };
      } else if (step.actorPrev !== null) {
        spot = spotForStep(v, step.actorPrev, memo);
      } else {
        spot = startSpot(v, step.actor, memo);
      }
      if (step.kind === 'wait' && step.failed && spot) {
        // Rejected: the worker steps back from what it wanted to do.
        spot = { x: spot.x, y: spot.y, z: spot.z + 0.07 };
      }
    }
    if (memo) { memo[stepIndex] = spot; }
    return spot;
  }

  /** Before its first step: the main agent waits at home, a subagent beside the worker that spawned it. */
  function startSpot(v, actorIndex, memo) {
    var lane = v.timeline.actors[actorIndex];
    if (!lane || lane.kind === 'main') { return MAIN_HOME; }
    var parentSpot = lane.spawnIndex >= 0 ? spotForStep(v, lane.spawnIndex, memo) : MAIN_HOME;
    var slot = slotOffset(actorIndex);
    return { x: (parentSpot || MAIN_HOME).x + slot.x * 2.2, y: (parentSpot || MAIN_HOME).y, z: (parentSpot || MAIN_HOME).z + slot.z * 2.2 };
  }

  function workerSpot(v, info, memo) {
    if (!info.present) { return null; }
    return info.step ? spotForStep(v, info.stepIndex, memo) : startSpot(v, info.actor, memo);
  }

  function setWorkerPosition(worker, point) {
    worker.group.position.set(point.x, point.y + WORKER_HOVER, point.z);
  }

  /** Seek: every worker straight to where the playhead puts it; trail rebuilt. */
  function placeWorkersAt(v, index, workers) {
    var memo = {};
    workers.forEach(function (info) {
      var worker = info.present ? ensureWorker(v, info.actor) : v.workers?.[info.actor];
      if (!worker) { return; }
      worker.hop = null;
      worker.dissolve = null;
      worker.pop = 1;
      worker.present = info.present;
      var spot = workerSpot(v, info, memo);
      if (spot) { worker.rest = spot; setWorkerPosition(worker, spot); }
      worker.group.scale.setScalar(worker.scale);
      worker.group.visible = info.present;
      setNodeVisible(worker.tag, info.present);
    });
    rebuildTrail(v, index, memo);
  }

  function rebuildTrail(v, index, memo) {
    var hops = [];
    var previous = {};
    var start = Math.max(0, index - TRAIL_HOPS * 2);
    for (var i = start; i <= index; i += 1) {
      var step = v.timeline.steps[i];
      if (!step || step.target.type === 'none') { continue; }
      var spot = spotForStep(v, i, memo);
      var from = previous[step.actor] || (step.actorPrev !== null ? spotForStep(v, step.actorPrev, memo) : startSpot(v, step.actor, memo));
      if (spot && from) { hops.push({ from: lift(from), to: lift(spot), color: actorColor(step.actor) }); }
      previous[step.actor] = spot;
    }
    v.trail.hops = hops.slice(-TRAIL_HOPS);
    refreshTrail(v);
  }

  function lift(point) { return { x: point.x, y: point.y + 0.04, z: point.z }; }

  /**
   * Forward single step: the stepping worker hops to its new spot (the
   * transport waits for that hop), a delegate pops the new worker out of the
   * main one, and a finished subagent flies back to the main worker and
   * dissolves. Other workers keep working where they are.
   */
  function animateWorkers(v, index, workers, step, durationMs, onDone) {
    var memo = {};
    var mainSpot = null;
    var main = workers[0];
    if (main) { mainSpot = workerSpot(v, main, memo); }
    var waited = false;
    workers.forEach(function (info) {
      var worker = info.present ? ensureWorker(v, info.actor) : v.workers?.[info.actor];
      if (!worker) { return; }
      var spot = workerSpot(v, info, memo);
      var stepping = step && info.actor === step.actor;
      if (!info.present) {
        if (worker.present && state.motion && mainSpot) {
          // Done: back to the main worker, then dissolve.
          startHop(v, worker, mainSpot, durationMs, null, true);
          worker.dissolve = { t: 0 };
        } else {
          worker.group.visible = false;
          setNodeVisible(worker.tag, false);
        }
        worker.present = false;
        return;
      }
      var appearing = !worker.present;
      worker.present = true;
      worker.dissolve = null;
      worker.group.visible = true;
      setNodeVisible(worker.tag, true);
      if (appearing) {
        // Born from the main worker (or, for the main agent, dropped in).
        var origin = info.actor === 0 ? { x: spot.x, y: spot.y + 0.3, z: spot.z } : (v.workers[0]?.rest || mainSpot || spot);
        worker.rest = origin;
        setWorkerPosition(worker, origin);
        worker.pop = state.motion ? 0 : 1;
        if (info.actor !== 0 && state.motion) { delegateBeam(v, origin, spot, worker.color, durationMs * 2.5); }
      }
      if (!spot) { return; }
      if (!state.motion || samePoint(worker.rest, spot)) {
        if (worker.rest && !samePoint(worker.rest, spot) && stepping) { pushTrailHop(v, lift(worker.rest), lift(spot), worker.color); }
        worker.rest = spot;
        setWorkerPosition(worker, spot);
        return;
      }
      if (stepping) {
        waited = true;
        startHop(v, worker, spot, durationMs, onDone, false);
      } else {
        startHop(v, worker, spot, durationMs * 1.4, null, false);
      }
    });
    refreshTrail(v);
    if (!waited) {
      spawnArrivalEffects(v, step, durationMs * 2, step ? workerSpot(v, workers[step.actor] || {}, memo) : null);
      onDone?.();
    }
  }

  function startHop(v, worker, to, durationMs, onDone, silent) {
    var from = worker.rest || to;
    worker.hop = { from: from, to: to, t: 0, eased: 0, dur: Math.max(140, durationMs), onDone: onDone, silent: !!silent, liftFrom: lift(from), liftTo: lift(to) };
  }

  function tickWorkers(v, dt, timeMs, camera) {
    var moved = false;
    (v.workers || []).forEach(function (worker) {
      if (!worker || !worker.group.visible) { return; }
      worker.phase += dt / 1000;
      if (worker.hop) {
        var hop = worker.hop;
        hop.t = Math.min(1, hop.t + dt / hop.dur);
        hop.eased = easeInOutCubic(hop.t);
        var point = bezierPoint(hop.from, hopControl(hop.from, hop.to), hop.to, hop.eased);
        var before = worker.group.position.clone();
        setWorkerPosition(worker, point);
        var dx = worker.group.position.x - before.x;
        var dz = worker.group.position.z - before.z;
        if (dx * dx + dz * dz > 1e-9) { worker.group.rotation.y = Math.atan2(dx, dz); }
        moved = true;
        if (hop.t >= 1) {
          worker.hop = null;
          worker.rest = hop.to;
          if (!hop.silent) {
            pushTrailHop(v, hop.liftFrom, hop.liftTo, worker.color);
          }
          if (hop.onDone) {
            var step = v.cityState?.current;
            spawnArrivalEffects(v, step, hop.dur * 2, hop.to);
            hop.onDone();
          }
        }
      } else if (state.motion && worker.rest) {
        worker.group.position.y = worker.rest.y + WORKER_HOVER + Math.sin(worker.phase * 2.6) * 0.004;
        // Ease back to facing the viewer when idle.
        worker.group.rotation.y *= Math.max(0, 1 - dt / 400);
      }
      if (state.motion) { worker.ring.rotation.y += dt / 500; }
      var size = worker.scale;
      if (worker.pop < 1) {
        worker.pop = Math.min(1, worker.pop + dt / 420);
        size *= Math.max(0.01, easeOutBack(worker.pop));
      }
      if (worker.dissolve) {
        if (!worker.hop) {
          worker.dissolve.t = Math.min(1, worker.dissolve.t + dt / 380);
          size *= Math.max(0.01, 1 - worker.dissolve.t);
          if (worker.dissolve.t >= 1) {
            worker.dissolve = null;
            worker.group.visible = false;
            setNodeVisible(worker.tag, false);
            if (worker.rest) { pulseRing(v, worker.rest, worker.color, 0.02, 0.12, 500); }
          }
        }
      }
      worker.group.scale.setScalar(size);
      if (worker.tag?.object3D) {
        var p = worker.group.position;
        worker.tag.object3D.position.set(p.x, p.y + 0.135 * worker.scale, p.z);
        faceYaw(worker.tag, camera);
      }
      tickWorkerProps(v, worker, dt, timeMs, camera);
    });
    if (moved) { refreshTrail(v); }
  }

  // -- Per-worker action props (what the worker is doing right now) ------------

  function clearWorkerProps(v, worker) {
    worker.props.forEach(function (prop) {
      prop.object.parent?.remove(prop.object);
      disposeObject(prop.object);
    });
    worker.props = [];
    worker.propKey = '';
  }

  function addProp(v, worker, object, tick, parent) {
    if (!canSpawn(v)) { disposeObject(object); return null; }
    (parent || v.group).add(object);
    var prop = { object: object, tick: tick || null, age: 0 };
    worker.props.push(prop);
    return prop;
  }

  function bandGeometryOf(v) {
    return sharedGeometry(v, 'band', function () {
      var geometry = new (three().CylinderGeometry)(0.7071, 0.7071, 1, 4, 1, true);
      geometry.rotateY(Math.PI / 4);
      return geometry;
    });
  }

  function glowMaterial(color, opacity) {
    var T = three();
    return new T.MeshBasicMaterial({ color: color, transparent: true, opacity: opacity, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending });
  }

  /** Height of a file before and after one write step (for the new-floor stack). */
  function writeHeights(v, step, fileIndex) {
    var file = v.files[fileIndex];
    var plan = v.timeline.writePlan[fileIndex];
    if (!plan) { return null; }
    var previousShare = 0;
    var hadPrevious = false;
    Object.keys(plan.shares).forEach(function (key) {
      if (Number(key) < step.index) { previousShare = Math.max(previousShare, plan.shares[key]); hadPrevious = true; }
    });
    var share = plan.shares[step.index] === undefined ? 1 : plan.shares[step.index];
    var before = file.created && !hadPrevious ? 0 : heightForLoc(file, plan.baseLoc + plan.totalDelta * previousShare);
    var after = heightForLoc(file, plan.baseLoc + plan.totalDelta * share);
    return { before: before, after: after };
  }

  function buildReadProps(v, worker, step) {
    var T = three();
    var fileIndex = step.files[0];
    if (fileIndex === undefined) { return; }
    var top = v.city.getBuildingTop(fileIndex);
    var base = v.city.getBuildingBase(fileIndex);
    var foot = v.city.getFootprint(fileIndex);
    var height = Math.max(0.03, top.y - base.y);
    var coneGeometry = sharedGeometry(v, 'cone', function () {
      var geometry = new T.ConeGeometry(1, 1, 24, 1, true);
      geometry.translate(0, -0.5, 0);
      return geometry;
    });
    // The scanning cone: from the worker's eye down over the facade.
    var cone = new T.Mesh(coneGeometry, glowMaterial(COLORS.read, 0.14));
    var radius = Math.max(foot.w, foot.d) * 0.78 + 0.01;
    var apex = top.y + 0.1 * worker.scale;
    cone.scale.set(radius, apex - base.y, radius);
    cone.position.set(top.x, apex, top.z);
    addProp(v, worker, cone, function (prop, dt, timeMs) {
      cone.rotation.y = state.motion ? timeMs / 700 : 0;
      cone.material.opacity = state.motion ? 0.1 + 0.06 * Math.sin(timeMs / 180) : 0.14;
    });
    // A bright band sweeping down the building, top to base, over and over.
    var sweep = new T.Mesh(bandGeometryOf(v), glowMaterial(COLORS.read, 0.95));
    sweep.scale.set(foot.w + 0.02, 0.006, foot.d + 0.02);
    sweep.position.set(top.x, top.y, top.z);
    addProp(v, worker, sweep, function (prop) {
      var k = state.motion ? (prop.age / 1300) % 1 : 0.5;
      sweep.position.y = top.y - height * k;
      sweep.material.opacity = 0.95 * (1 - k * 0.6);
    });
    if (Number(step.line) > 0) {
      var loc = Math.max(1, v.files[fileIndex].loc, Number(step.line));
      var share = Math.min(1, Math.max(0, Number(step.line) / loc));
      var band = new T.Mesh(bandGeometryOf(v), new T.MeshBasicMaterial({ color: '#a5f3fc', side: T.DoubleSide }));
      band.scale.set(foot.w + 0.016, Math.max(0.008, height * 0.06), foot.d + 0.016);
      band.position.set(top.x, top.y - height * share, top.z);
      addProp(v, worker, band, null);
    }
  }

  function buildSearchProps(v, worker, step) {
    var T = three();
    var origin = worker.rest || centroidOf(v, step.files);
    // Radar ripple across the table from under the worker.
    [0, 0.5].forEach(function (offset) {
      var ring = new T.Mesh(sharedRingGeometry(v), glowMaterial(COLORS.search, 0));
      ring.position.set(origin.x, 0.014, origin.z);
      addProp(v, worker, ring, function (prop) {
        var k = state.motion ? ((prop.age / 1600) + offset) % 1 : 0.6;
        ring.scale.setScalar(0.05 + 0.95 * k);
        ring.material.opacity = 0.8 * (1 - k);
      });
    });
    // Beacons pop up on every match, then fade.
    step.files.slice(0, 12).forEach(function (fileIndex, order) {
      var top = v.city.getBuildingTop(fileIndex);
      var beacon = new T.Group();
      var beam = new T.Mesh(unitBoxGeometry(v), glowMaterial(COLORS.search, 0.85));
      beam.scale.set(0.006, 0.16, 0.006);
      beam.position.y = 0.08;
      var bulb = new T.Sprite(new T.SpriteMaterial({ map: glowTexture(v), color: COLORS.search, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
      bulb.scale.set(0.07, 0.07, 0.07);
      bulb.position.y = 0.17;
      beacon.add(beam, bulb);
      beacon.position.set(top.x, top.y, top.z);
      var delay = order * 70;
      addProp(v, worker, beacon, function (prop) {
        if (!state.motion) { beacon.scale.set(1, 1, 1); return; }
        var t = Math.max(0, prop.age - delay);
        var rise = easeOutBack(Math.min(1, t / 320));
        var fade = t > 1800 ? Math.max(0, 1 - (t - 1800) / 700) : 1;
        beacon.scale.set(1, Math.max(0.01, rise), 1);
        beam.material.opacity = 0.85 * fade;
        bulb.material.opacity = fade;
        beacon.visible = fade > 0.01;
      });
    });
  }

  function buildWriteProps(v, worker, step) {
    var T = three();
    step.files.slice(0, 3).forEach(function (fileIndex) {
      var heights = writeHeights(v, step, fileIndex);
      if (!heights || heights.after <= heights.before + 0.004) { return; }
      var base = v.city.getBuildingBase(fileIndex);
      var foot = v.city.getFootprint(fileIndex);
      var grow = heights.after - heights.before;
      var floors = Math.max(1, Math.min(10, Math.round(grow / 0.016)));
      var pitch = grow / floors;
      var created = v.files[fileIndex].created && heights.before === 0;
      var stack = new T.Group();
      var material = new T.MeshStandardMaterial({ color: created ? COLORS.created : COLORS.write, roughness: 0.5, flatShading: true, emissive: created ? '#14532d' : '#7c2d12', emissiveIntensity: 0.35 });
      var slabs = [];
      for (var i = 0; i < floors; i += 1) {
        var slab = new T.Mesh(unitBoxGeometry(v), material);
        slab.scale.set(foot.w + 0.008, pitch * 0.78, foot.d + 0.008);
        slab.position.set(0, heights.before + pitch * (i + 0.5), 0);
        stack.add(slab);
        slabs.push(slab);
      }
      stack.position.set(base.x, base.y, base.z);
      addProp(v, worker, stack, function (prop) {
        // Floors stack up one by one while the building grows.
        slabs.forEach(function (slab, i) {
          var t = state.motion ? Math.min(1, Math.max(0, (prop.age - i * 90) / 220)) : 1;
          slab.scale.y = Math.max(0.0001, pitch * 0.78 * t);
        });
      });
    });
  }

  function buildBadgeProp(v, worker, kind, pulse) {
    var T = three();
    var sprite = new T.Sprite(new T.SpriteMaterial({ map: badgeTexture(v, kind), transparent: true, depthWrite: false }));
    var size = kind === 'bubble' ? 0.075 : 0.07;
    sprite.scale.set(size, kind === 'bubble' ? size * 0.75 : size, 1);
    // Above the name tag, never behind it.
    sprite.position.set(0, 0.25, 0);
    // A post holding the "!" sign up, like a placard.
    var holder = new T.Group();
    holder.add(sprite);
    if (kind !== 'bubble') {
      var post = new T.Mesh(unitBoxGeometry(v), new T.MeshBasicMaterial({ color: '#94a3b8' }));
      post.scale.set(0.003, 0.2, 0.003);
      post.position.set(0, 0.11, 0);
      holder.add(post);
    }
    addProp(v, worker, holder, function (prop, dt, timeMs) {
      var p = worker.group.position;
      holder.position.set(p.x + 0.055 * worker.scale, p.y, p.z);
      holder.scale.setScalar(worker.scale * 0.8);
      if (!state.motion) { return; }
      if (pulse) {
        var k = 1 + 0.18 * Math.abs(Math.sin(timeMs / 260));
        sprite.scale.set(size * k, size * k, 1);
      } else {
        sprite.position.y = 0.25 + Math.sin(timeMs / 400) * 0.006;
      }
    });
  }

  /** (Re)builds a worker's props when its current action changes. */
  function syncWorkerProps(v, worker, info) {
    var step = info.active ? info.step : null;
    var key = step ? step.index + ':' + step.status + ':' + (state.motion ? 1 : 0) : 'idle';
    if (worker.propKey === key) { return; }
    clearWorkerProps(v, worker);
    worker.propKey = key;
    if (!step || !worker.group.visible) { return; }
    if (step.kind === 'read') { buildReadProps(v, worker, step); }
    if (step.kind === 'search') { buildSearchProps(v, worker, step); }
    if (step.kind === 'write') { buildWriteProps(v, worker, step); }
    if (step.kind === 'think') { buildBadgeProp(v, worker, 'bubble', false); }
    if (step.kind === 'wait') { buildBadgeProp(v, worker, step.failed ? 'rejected' : 'wait', step.status === 'running' || !step.failed); }
  }

  function tickWorkerProps(v, worker, dt, timeMs, camera) {
    worker.props.forEach(function (prop) {
      prop.age += dt;
      prop.tick?.(prop, dt, timeMs, camera);
    });
  }

  // -- Site state from the playhead -------------------------------------------

  /** Files written in a turn up to (and including) a step. */
  function writtenInTurn(v, step) {
    var files = {};
    for (var i = step.index; i >= 0; i -= 1) {
      var other = v.timeline.steps[i];
      if (other.turn !== step.turn) { break; }
      if (other.kind === 'write') { other.files.forEach(function (fileIndex) { files[fileIndex] = true; }); }
    }
    return Object.keys(files).map(Number);
  }

  /**
   * Everything the playhead implies on the site: scaffolds on active writes,
   * foundations under created files, hazard stripes on blind writes, amber
   * tape round unread dependents, red tape after a failed run, the tower
   * state and each worker's props.
   */
  function syncSite(v, cityState, workers) {
    var scaffolds = {};
    var warning = {};
    var tower = 'idle';
    workers.forEach(function (info) {
      if (!info.active || !info.step) { return; }
      var step = info.step;
      if (step.kind === 'write') {
        step.files.forEach(function (fileIndex) {
          var created = v.files[fileIndex].created && cityState.files[fileIndex]?.touches.writes <= 1;
          scaffolds[fileIndex] = created ? COLORS.created : '#fdba74';
        });
      }
      if (step.kind === 'execute') {
        tower = step.failed ? 'failed' : 'ok';
        if (step.failed) { writtenInTurn(v, step).forEach(function (fileIndex) { warning[fileIndex] = true; }); }
      }
    });
    v.city.scaffoldIndexes().forEach(function (fileIndex) {
      if (!scaffolds[fileIndex]) { v.city.removeScaffold(fileIndex); }
    });
    Object.keys(scaffolds).forEach(function (key) {
      v.city.addScaffold(Number(key), { color: scaffolds[key], crane: true });
    });
    setTowerMode(v, tower);
    var unread = state.toggles.blast ? unreadDependentSet(v, cityState) : {};
    cityState.files.forEach(function (fileState, index) {
      var standing = fileState.visible && !fileState.deleted;
      v.city.setFoundation(index, standing && v.files[index].created);
      v.city.setHazard(index, standing && fileState.blind ? 'blind' : null, 'blind');
      v.city.setHazard(index, standing && unread[index] ? 'unread' : null, 'unread');
      v.city.setHazard(index, standing && warning[index] ? 'warning' : null, 'warning');
    });
    workers.forEach(function (info) {
      var worker = v.workers?.[info.actor];
      if (worker) { syncWorkerProps(v, worker, info); }
    });
  }

  /** The worker standing for a step's actor (for labels), or null. */
  function workerRest(v, actorIndex) {
    var worker = v.workers?.[actorIndex];
    return worker?.rest || null;
  }
