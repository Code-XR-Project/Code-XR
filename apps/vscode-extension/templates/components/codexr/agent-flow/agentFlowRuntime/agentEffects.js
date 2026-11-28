// == agentFlowRuntime.js | agentEffects (assembled per manifest.json; see COMPONENTS.md) ==
  // Shared effect plumbing for the construction site: the fading trail every
  // worker leaves (one tube, broken between workers), the one-shot effect
  // list (pulses, dust, beams, falling slices) and the arrival effects of a
  // step. Static render budget: no one-shot effect is spawned.

  function glowTexture(v) {
    if (v.glowTexture) { return v.glowTexture; }
    var T = three();
    var canvas = doc().createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    var ctx = canvas.getContext?.('2d');
    if (ctx) {
      var gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(0.25, 'rgba(255,255,255,0.65)');
      gradient.addColorStop(0.6, 'rgba(255,255,255,0.12)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
    }
    v.glowTexture = track(v, new T.CanvasTexture(canvas));
    return v.glowTexture;
  }

  // The trail is a tapered tube (a comet tail), not a GL line: WebGL draws
  // lines one pixel wide whatever the width, which vanished on a headset.
  var TRAIL_SIDES = 6;

  function buildTrail(v) {
    var T = three();
    // Each hop may add two invisible break points (a jump between workers).
    var capacity = TRAIL_HOPS * (HOP_SAMPLES + 3) + HOP_SAMPLES * WORKER_CAP + 2;
    var vertices = capacity * TRAIL_SIDES;
    var geometry = track(v, new T.BufferGeometry());
    geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(vertices * 3), 3));
    geometry.setAttribute('color', new T.BufferAttribute(new Float32Array(vertices * 4), 4));
    var indices = [];
    for (var ring = 0; ring < capacity - 1; ring += 1) {
      for (var side = 0; side < TRAIL_SIDES; side += 1) {
        var a = ring * TRAIL_SIDES + side;
        var b = ring * TRAIL_SIDES + ((side + 1) % TRAIL_SIDES);
        var c = a + TRAIL_SIDES;
        var d = b + TRAIL_SIDES;
        indices.push(a, c, b, b, c, d);
      }
    }
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);
    var mesh = new T.Mesh(geometry, track(v, new T.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: T.DoubleSide
    })));
    mesh.frustumCulled = false;
    mesh.name = 'agentFlowTrail';
    v.group.add(mesh);
    v.trail = { mesh: mesh, geometry: geometry, capacity: capacity, hops: [], points: 0 };
  }

  /** Writes the tube rings around `points`; thicker and brighter toward the head. A null colour is a gap. */
  function writeTrailTube(v, points, colors) {
    var T = three();
    var count = points.length;
    var position = v.trail.geometry.attributes.position;
    var colorAttr = v.trail.geometry.attributes.color;
    var color = new T.Color();
    var tangent = new T.Vector3();
    var normal = new T.Vector3();
    var binormal = new T.Vector3();
    var up = new T.Vector3(0, 1, 0);
    for (var i = 0; i < count; i += 1) {
      var previous = points[Math.max(0, i - 1)];
      var next = points[Math.min(count - 1, i + 1)];
      tangent.set(next.x - previous.x, next.y - previous.y, next.z - previous.z);
      if (tangent.lengthSq() < 1e-10) { tangent.set(1, 0, 0); }
      tangent.normalize();
      normal.crossVectors(tangent, up);
      if (normal.lengthSq() < 1e-8) { normal.set(1, 0, 0); }
      normal.normalize();
      binormal.crossVectors(tangent, normal).normalize();
      var share = (i + 1) / count;
      var radius = 0.0022 + 0.0058 * Math.pow(share, 1.2);
      var alpha = colors[i] ? 0.12 + 0.8 * Math.pow(share, 1.3) : 0;
      color.set(colors[i] || '#000000');
      for (var side = 0; side < TRAIL_SIDES; side += 1) {
        var angle = (side / TRAIL_SIDES) * Math.PI * 2;
        var cos = Math.cos(angle) * radius;
        var sin = Math.sin(angle) * radius;
        var vertex = i * TRAIL_SIDES + side;
        position.setXYZ(vertex,
          points[i].x + normal.x * cos + binormal.x * sin,
          points[i].y + normal.y * cos + binormal.y * sin,
          points[i].z + normal.z * cos + binormal.z * sin);
        colorAttr.setXYZW(vertex, color.r, color.g, color.b, alpha);
      }
    }
    position.needsUpdate = true;
    colorAttr.needsUpdate = true;
    v.trail.geometry.setDrawRange(0, Math.max(0, count - 1) * TRAIL_SIDES * 6);
  }

  function bezierPoint(from, control, to, t) {
    var a = (1 - t) * (1 - t);
    var b = 2 * (1 - t) * t;
    var c = t * t;
    return {
      x: a * from.x + b * control.x + c * to.x,
      y: a * from.y + b * control.y + c * to.y,
      z: a * from.z + b * control.z + c * to.z
    };
  }

  function hopControl(from, to) {
    var distance = Math.hypot(to.x - from.x, to.z - from.z);
    return { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + 0.1 + distance * 0.2, z: (from.z + to.z) / 2 };
  }

  function samplesOf(from, to, upTo) {
    var control = hopControl(from, to);
    var points = [];
    for (var i = 1; i <= HOP_SAMPLES; i += 1) {
      var t = i / HOP_SAMPLES;
      if (t > upTo + 1e-6) { break; }
      points.push(bezierPoint(from, control, to, t));
    }
    return points;
  }

  function samePoint(a, b) {
    return !!a && !!b && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
  }

  /** Rewrites the trail buffer: completed hops of every worker plus the hops in flight. */
  function refreshTrail(v) {
    if (!v.trail) { return; }
    var points = [];
    var colors = [];
    var live = (v.workers || []).filter(function (worker) { return worker?.hop && !worker.hop.silent; }).map(function (worker) {
      return { from: worker.hop.from, to: worker.hop.to, color: worker.color, upTo: worker.hop.eased };
    });
    v.trail.hops.slice(-TRAIL_HOPS).concat(live).forEach(function (hop) {
      var last = points[points.length - 1];
      if (!samePoint(last, hop.from)) {
        // A jump to another worker's path: a transparent gap, no bridge.
        if (last) { points.push(last); colors.push(null); points.push(hop.from); colors.push(null); }
        points.push(hop.from);
        colors.push(hop.color);
      }
      samplesOf(hop.from, hop.to, hop.upTo === undefined ? 1 : hop.upTo).forEach(function (point) {
        points.push(point);
        colors.push(hop.color);
      });
      if (hop.upTo !== undefined && hop.upTo < 1) {
        points.push(bezierPoint(hop.from, hopControl(hop.from, hop.to), hop.to, hop.upTo));
        colors.push(hop.color);
      }
    });
    var count = Math.min(points.length, v.trail.capacity);
    var offset = points.length - count;
    writeTrailTube(v, points.slice(offset), colors.slice(offset));
    v.trail.points = count;
    syncTrailVisibility(v);
  }

  /**
   * The comet tail hides while the whole-session path arcs or the blast radius
   * are drawn: it would repaint the same moves on top of them.
   */
  function syncTrailVisibility(v) {
    if (!v.trail) { return; }
    v.trail.mesh.visible = state.toggles.trail && v.trail.points > 1 && !v.pathLines && !state.toggles.blast;
  }

  function pushTrailHop(v, from, to, color) {
    if (!from || !to || samePoint(from, to)) { return; }
    v.trail.hops.push({ from: from, to: to, color: color });
    if (v.trail.hops.length > TRAIL_HOPS) { v.trail.hops.shift(); }
  }

  // -- One-shot effects --------------------------------------------------------

  function liveEffectCount(v) {
    return v.effects.length + (v.workers || []).reduce(function (sum, worker) { return sum + (worker?.props?.length || 0); }, 0);
  }

  function canSpawn(v) { return liveEffectCount(v) < EFFECT_CAP; }

  function addEffect(v, object, durationMs, update) {
    if (!canSpawn(v)) { disposeObject(object); return false; }
    v.group.add(object);
    v.effects.push({ object: object, t: 0, dur: Math.max(60, durationMs), update: update });
    return true;
  }

  function disposeObject(object) {
    object.traverse?.(function (node) {
      if (node.material && !node.material.userData?.shared) { node.material.dispose?.(); }
      if (node.geometry && !node.geometry.userData?.shared) { node.geometry.dispose?.(); }
    });
  }

  function disposeEffect(v, effect) {
    v.group.remove(effect.object);
    disposeObject(effect.object);
  }

  function tickEffects(v, dt) {
    if (!v.effects.length) { return; }
    v.effects = v.effects.filter(function (effect) {
      effect.t = Math.min(1, effect.t + dt / effect.dur);
      effect.update(effect.t);
      if (effect.t >= 1) {
        disposeEffect(v, effect);
        return false;
      }
      return true;
    });
  }

  function clearEffects(v) {
    (v?.effects || []).forEach(function (effect) { disposeEffect(v, effect); });
    if (v) { v.effects = []; }
  }

  function sharedGeometry(v, key, make) {
    v.sharedGeometries = v.sharedGeometries || {};
    if (!v.sharedGeometries[key]) {
      var geometry = track(v, make());
      geometry.userData.shared = true;
      v.sharedGeometries[key] = geometry;
    }
    return v.sharedGeometries[key];
  }

  function sharedRingGeometry(v) {
    return sharedGeometry(v, 'ring', function () {
      var geometry = new (three().RingGeometry)(0.82, 1, 48);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    });
  }

  function unitBoxGeometry(v) {
    return sharedGeometry(v, 'box', function () { return new (three().BoxGeometry)(1, 1, 1); });
  }

  function pulseRing(v, point, color, fromRadius, toRadius, durationMs, delayShare) {
    var T = three();
    var ring = new T.Mesh(sharedRingGeometry(v), new T.MeshBasicMaterial({
      color: color, transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide, blending: T.AdditiveBlending
    }));
    ring.position.set(point.x, point.y + 0.004, point.z);
    ring.scale.setScalar(fromRadius);
    var delay = delayShare || 0;
    addEffect(v, ring, durationMs, function (t) {
      var local = Math.max(0, (t - delay) / (1 - delay));
      ring.scale.setScalar(fromRadius + (toRadius - fromRadius) * easeOutCubic(local));
      ring.material.opacity = local <= 0 ? 0 : 0.95 * (1 - local);
    });
  }

  /** A grey dust cloud puffing out of a crumbling building. */
  function dustPuff(v, fileIndex, durationMs) {
    var T = three();
    var base = v.city.getBuildingBase(fileIndex);
    var foot = v.city.getFootprint(fileIndex);
    var cloud = new T.Group();
    var puffs = [];
    for (var i = 0; i < 7; i += 1) {
      var sprite = new T.Sprite(new T.SpriteMaterial({ map: glowTexture(v), color: '#cbd5e1', transparent: true, depthWrite: false, opacity: 0 }));
      var angle = (i / 7) * Math.PI * 2;
      sprite.userData.dir = { x: Math.cos(angle), z: Math.sin(angle), lift: 0.02 + (i % 3) * 0.02 };
      cloud.add(sprite);
      puffs.push(sprite);
    }
    cloud.position.set(base.x, base.y + 0.02, base.z);
    var spread = Math.max(foot.w, foot.d) * 0.6 + 0.05;
    addEffect(v, cloud, durationMs, function (t) {
      var eased = easeOutCubic(t);
      puffs.forEach(function (sprite) {
        var dir = sprite.userData.dir;
        sprite.position.set(dir.x * spread * eased, dir.lift * eased + 0.01, dir.z * spread * eased);
        sprite.scale.setScalar(0.06 + 0.12 * eased);
        sprite.material.opacity = 0.75 * (1 - t);
      });
    });
  }

  /** Removed lines: a red slice drops off the top of the building and fades. */
  function droppingSlice(v, fileIndex, durationMs) {
    var T = three();
    var top = v.city.getBuildingTop(fileIndex);
    var foot = v.city.getFootprint(fileIndex);
    var slice = new T.Mesh(unitBoxGeometry(v), new T.MeshBasicMaterial({ color: COLORS.deltaUp, transparent: true, opacity: 0.95 }));
    slice.scale.set(foot.w * 1.02, 0.014, foot.d * 1.02);
    slice.position.set(top.x, top.y + 0.01, top.z);
    addEffect(v, slice, durationMs, function (t) {
      slice.position.set(top.x + t * foot.w * 0.6, top.y + 0.01 - t * t * 0.25, top.z);
      slice.rotation.z = -t * 0.9;
      slice.material.opacity = 0.95 * (1 - t);
    });
  }

  /** The main worker hands work over: a bright beam to the newborn worker. */
  function delegateBeam(v, from, to, color, durationMs) {
    var T = three();
    var curve = new T.QuadraticBezierCurve3(
      new T.Vector3(from.x, from.y + 0.05, from.z),
      new T.Vector3((from.x + to.x) / 2, Math.max(from.y, to.y) + 0.18, (from.z + to.z) / 2),
      new T.Vector3(to.x, to.y + 0.05, to.z)
    );
    var beam = new T.Mesh(new T.TubeGeometry(curve, 20, 0.004, 6, false),
      new T.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.95, depthWrite: false, blending: T.AdditiveBlending }));
    addEffect(v, beam, durationMs, function (t) { beam.material.opacity = 0.95 * (1 - t * t); });
  }

  /** One-shot effects when a worker arrives for a step (motion only). */
  function spawnArrivalEffects(v, step, durationMs, spot) {
    if (!step || !state.motion) { return; }
    var dur = Math.max(260, durationMs);
    if (step.kind === 'read') {
      step.files.forEach(function (fileIndex) {
        var roof = roofPoint(v, fileIndex);
        var foot = v.city.getFootprint(fileIndex);
        var radius = Math.max(foot.w, foot.d) * 0.7;
        pulseRing(v, roof, COLORS.read, radius, radius * 2.4, dur);
      });
    } else if (step.kind === 'write') {
      step.files.forEach(function (fileIndex) {
        if (Number(step.removed) > 0) { droppingSlice(v, fileIndex, dur * 2); }
      });
    } else if (step.kind === 'execute') {
      flashPillar(v, step.failed, dur);
    }
    step.deletes?.forEach(function (fileIndex) { dustPuff(v, fileIndex, dur * 2.6); });
    if (step.failed && step.kind !== 'execute' && step.kind !== 'wait' && spot) {
      pulseRing(v, { x: spot.x, y: spot.y, z: spot.z }, COLORS.failed, 0.06, 0.4, dur);
    }
  }
