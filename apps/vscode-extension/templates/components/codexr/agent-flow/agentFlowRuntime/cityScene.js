// == agentFlowRuntime.js | cityScene (assembled per manifest.json; see COMPONENTS.md) ==
  // The `codexr-city` A-Frame component: the agent city chart.
  // City layout and look modeled on babia-boats from BabiaXR
  // (aframe-babia-components, GPL-3.0): folders are nested, elevated plates
  // ("quarters"), files are buildings standing on their deepest plate.
  //
  // One InstancedMesh for every building (per-instance colour and height),
  // one for the plates, one for roof tints. The buildings live on a child
  // entity that alone carries the raycaster class (hover tooltips); plates,
  // roofs, scaffolds and foundations are decoration.
  //
  // Everything else on the table (workers, effects, overlays) goes through the
  // API a city returns (createCity) and the component exposes:
  //   getBuildingTop(i) -> {x, y, z}   getBuildingEntity(i)   getFootprint(i)
  //   setBuildingHeight(i, h, animate) setBuildingColor(i, hex)
  //   addScaffold(i, options) / removeScaffold(i)   setRoofTint(i, hex|null)
  //   demolish(i)   raise(i, h)   setFoundation(i, on)   setHazard(i, kind|null)
  // Instanced buildings have no entity of their own: getBuildingEntity returns
  // the shared buildings entity, with the index as instanceId on intersections.

  var PLATE_STEP = 0.006;
  var FOOTPRINT_FILL = 0.86;
  var CITY_COMPONENT = 'codexr-city';
  var HAZARD_CAP = 80;

  function track(owner, resource) {
    if (resource) { owner.disposables.push(resource); }
    return resource;
  }

  function disposeTracked(owner) {
    (owner?.disposables || []).forEach(function (resource) {
      try { resource.dispose?.(); } catch { /* already gone */ }
    });
    if (owner) { owner.disposables = []; }
  }

  function containingDepth(file, districts) {
    var depth = 0;
    districts.forEach(function (district) {
      if (Math.abs(file.x - district.x) <= district.w / 2 + 1e-4
        && Math.abs(file.z - district.z) <= district.d / 2 + 1e-4) {
        depth = Math.max(depth, district.depth);
      }
    });
    return depth;
  }

  function outsideStripRect(files, outside) {
    var box = null;
    files.forEach(function (file, index) {
      if (!outside[index]) { return; }
      var x0 = file.x - file.w / 2;
      var x1 = file.x + file.w / 2;
      var z0 = file.z - file.d / 2;
      var z1 = file.z + file.d / 2;
      box = box
        ? { x0: Math.min(box.x0, x0), x1: Math.max(box.x1, x1), z0: Math.min(box.z0, z0), z1: Math.max(box.z1, z1) }
        : { x0: x0, x1: x1, z0: z0, z1: z1 };
    });
    if (!box) { return null; }
    var pad = 0.04;
    return { x: (box.x0 + box.x1) / 2, z: (box.z0 + box.z1) / 2, w: box.x1 - box.x0 + pad * 2, d: box.z1 - box.z0 + pad * 2 };
  }

  /**
   * Plate thickness. The babia-style layout states each district's `y` (the
   * plate's bottom, (depth - 1) * plateHeight) and each file's `baseY`;
   * older datasets state neither and get the thin terraces.
   */
  function plateHeightOf(districts, explicit) {
    if (Number(explicit) > 0) { return Number(explicit); }
    var ratios = districts.filter(function (district) { return Number.isFinite(district.y) && district.depth > 1 && district.y > 0; })
      .map(function (district) { return district.y / (district.depth - 1); }).sort(function (a, b) { return a - b; });
    return ratios.length ? ratios[Math.floor(ratios.length / 2)] : PLATE_STEP;
  }

  function buildPlates(c) {
    var T = three();
    var districts = c.districts.slice().sort(function (a, b) { return a.depth - b.depth; });
    var strip = outsideStripRect(c.files, c.outside);
    var step = c.plateHeight;
    var plates = [{ x: 0, z: 0, w: CITY.width + 0.06, d: CITY.depth + 0.06, y0: -step, y1: 0, color: '#172131' }];
    districts.forEach(function (district) {
      // Explicit y: the plate spans [y, y + plateHeight]; else the top of a
      // depth-d terrace is at d * PLATE_STEP.
      var y0 = Number.isFinite(district.y) ? district.y : (district.depth - 1) * step;
      plates.push({ x: district.x, z: district.z, w: district.w, d: district.d, y0: y0, y1: y0 + step, color: districtTone(district.depth) });
    });
    if (strip) {
      plates.push({ x: strip.x, z: strip.z, w: strip.w, d: strip.d, y0: 0, y1: step, color: '#2f2a3d' });
    }
    var geometry = track(c, new T.BoxGeometry(1, 1, 1));
    geometry.translate(0, 0.5, 0);
    var material = track(c, new T.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0.02, flatShading: true }));
    var mesh = new T.InstancedMesh(geometry, material, plates.length);
    plates.forEach(function (plate, index) {
      c.matrix.makeScale(Math.max(0.001, plate.w), Math.max(0.0005, plate.y1 - plate.y0), Math.max(0.001, plate.d));
      c.matrix.setPosition(plate.x, plate.y0, plate.z);
      mesh.setMatrixAt(index, c.matrix);
      mesh.setColorAt(index, c.color.set(plate.color));
    });
    mesh.name = 'agentFlowPlates';
    c.group.add(mesh);
    c.plates = mesh;
    c.strip = strip;
  }

  function buildBuildings(c) {
    var T = three();
    var count = Math.max(1, c.files.length);
    var geometry = track(c, new T.BoxGeometry(1, 1, 1));
    geometry.translate(0, 0.5, 0);
    var material = track(c, new T.MeshStandardMaterial({ color: '#ffffff', roughness: 0.58, metalness: 0.06, flatShading: true }));
    var mesh = new T.InstancedMesh(geometry, material, count);
    mesh.name = 'agentFlowBuildings';
    mesh.instanceMatrix.setUsage?.(T.DynamicDrawUsage);
    c.files.forEach(function (file, index) {
      if (Number.isFinite(file.baseY)) {
        c.baseY[index] = file.baseY;
      } else {
        c.baseY[index] = (c.outside[index] ? 1 : containingDepth(file, c.districts)) * PLATE_STEP;
      }
    });
    if (!c.files.length) { mesh.count = 0; }
    c.buildings = mesh;
    // Roof tints: a thin cap per building, hidden (zero scale) until tinted.
    var roofs = new T.InstancedMesh(track(c, new T.BoxGeometry(1, 1, 1)), track(c, new T.MeshBasicMaterial({ color: '#ffffff' })), count);
    roofs.name = 'agentFlowRoofs';
    roofs.instanceMatrix.setUsage?.(T.DynamicDrawUsage);
    c.zero = new T.Matrix4().makeScale(0.00001, 0.00001, 0.00001);
    for (var i = 0; i < count; i += 1) { roofs.setMatrixAt(i, c.zero); roofs.setColorAt(i, c.color.set('#ffffff')); }
    c.group.add(roofs);
    c.roofs = roofs;
    var el = entity('a-entity', {
      id: 'codexrAgentFlowBuildings',
      class: RAYCAST_CLASS,
      'data-codexr-interactive': 'true',
      'data-codexr-role': 'agent-flow buildings'
    });
    var attach = function () { el.setObject3D('mesh', mesh); };
    c.el.appendChild(el);
    if (el.hasLoaded || typeof el.setObject3D === 'function') { attach(); } else { el.addEventListener('loaded', attach, { once: true }); }
    c.buildingsEl = el;
  }

  function writeBuildingMatrix(c, index) {
    var file = c.files[index];
    var height = c.heights[index];
    var shown = height > 0.0005;
    var sink = c.demolitions[index];
    var w = file.w * FOOTPRINT_FILL;
    var d = file.d * FOOTPRINT_FILL;
    if (sink && shown) {
      // Crumbling: the block shrinks, leans and shakes while it sinks.
      var k = 1 - sink.t * 0.35;
      c.matrix.makeRotationZ(sink.lean * sink.t);
      c.matrix.scale(c.scratch.set(w * k, height, d * k));
      c.matrix.setPosition(file.x + Math.sin(sink.t * 60) * 0.004 * (1 - sink.t), c.baseY[index], file.z);
    } else {
      c.matrix.makeScale(shown ? w : 0.00001, shown ? height : 0.00001, shown ? d : 0.00001);
      c.matrix.setPosition(file.x, c.baseY[index], file.z);
    }
    c.buildings.setMatrixAt(index, c.matrix);
    writeRoofMatrix(c, index);
  }

  function writeRoofMatrix(c, index) {
    var file = c.files[index];
    var tint = c.tints[index];
    var height = c.heights[index];
    if (!tint || height <= 0.0005) {
      c.roofs.setMatrixAt(index, c.zero);
    } else {
      c.matrix.makeScale(file.w * FOOTPRINT_FILL + 0.004, 0.006, file.d * FOOTPRINT_FILL + 0.004);
      c.matrix.setPosition(file.x, c.baseY[index] + height - 0.004, file.z);
      c.roofs.setMatrixAt(index, c.matrix);
    }
    c.roofsDirty = true;
  }

  function markBuildingsDirty(c) {
    c.buildings.instanceMatrix.needsUpdate = true;
    // three caches the bounds the raycaster tests first.
    c.buildings.boundingSphere = null;
    c.buildings.boundingBox = null;
    flushRoofs(c);
  }

  function flushRoofs(c) {
    if (!c.roofsDirty) { return; }
    c.roofsDirty = false;
    c.roofs.instanceMatrix.needsUpdate = true;
    if (c.roofs.instanceColor) { c.roofs.instanceColor.needsUpdate = true; }
    c.roofs.boundingSphere = null;
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOutBack(t) { var s = 1.4; return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2); }

  // -- Scaffolds (wireframe lattice + a tiny crane), foundations, hazard bands --

  /** A unit lattice: poles, floor rings and face braces in [-0.5,0.5]x[0,1]x[-0.5,0.5]. */
  function latticeGeometry(c) {
    if (c.latticeGeometry) { return c.latticeGeometry; }
    var T = three();
    var p = [];
    var corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    var levels = 6;
    corners.forEach(function (corner, i) {
      var next = corners[(i + 1) % 4];
      p.push(corner[0], 0, corner[1], corner[0], 1, corner[1]);
      p.push((corner[0] + next[0]) / 2, 0, (corner[1] + next[1]) / 2, (corner[0] + next[0]) / 2, 1, (corner[1] + next[1]) / 2);
      for (var level = 0; level <= levels; level += 1) {
        var y = level / levels;
        p.push(corner[0], y, corner[1], next[0], y, next[1]);
        if (level < levels) {
          var y2 = (level + 1) / levels;
          // Zig-zag braces, alternating per floor.
          if (level % 2 === 0) { p.push(corner[0], y, corner[1], (corner[0] + next[0]) / 2, y2, (corner[1] + next[1]) / 2); } else { p.push((corner[0] + next[0]) / 2, y, (corner[1] + next[1]) / 2, next[0], y2, next[1]); }
        }
      }
    });
    var geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.Float32BufferAttribute(p, 3));
    c.latticeGeometry = track(c, geometry);
    return geometry;
  }

  function sharedBox(c) {
    if (!c.unitBox) {
      var T = three();
      c.unitBox = track(c, new T.BoxGeometry(1, 1, 1));
    }
    return c.unitBox;
  }

  function cachedMaterial(c, key, make) {
    c.materials = c.materials || {};
    if (!c.materials[key]) { c.materials[key] = track(c, make()); }
    return c.materials[key];
  }

  function buildCrane(c, color) {
    var T = three();
    var crane = new T.Group();
    var steel = cachedMaterial(c, 'crane:' + color, function () { return new T.MeshBasicMaterial({ color: color }); });
    var mast = new T.Mesh(sharedBox(c), steel);
    mast.scale.set(0.006, 0.09, 0.006);
    mast.position.y = 0.045;
    var jib = new T.Group();
    jib.position.y = 0.09;
    var arm = new T.Mesh(sharedBox(c), steel);
    arm.scale.set(0.11, 0.005, 0.006);
    arm.position.x = 0.03;
    var counter = new T.Mesh(sharedBox(c), cachedMaterial(c, 'crane:counter', function () { return new T.MeshBasicMaterial({ color: '#475569' }); }));
    counter.scale.set(0.018, 0.012, 0.012);
    counter.position.x = -0.022;
    var cableGeometry = new T.BufferGeometry();
    cableGeometry.setAttribute('position', new T.Float32BufferAttribute([0.075, 0, 0, 0.075, -0.05, 0], 3));
    var cable = new T.Line(track(c, cableGeometry), cachedMaterial(c, 'crane:cable', function () { return new T.LineBasicMaterial({ color: '#e2e8f0' }); }));
    var hook = new T.Mesh(sharedBox(c), steel);
    hook.scale.set(0.012, 0.008, 0.012);
    hook.position.set(0.075, -0.054, 0);
    jib.add(arm, counter, cable, hook);
    crane.add(mast, jib);
    crane.userData.jib = jib;
    crane.userData.hook = hook;
    return crane;
  }

  function addScaffold(c, index, options) {
    if (!c.files[index] || c.scaffolds[index]) { return c.scaffolds[index] || null; }
    var T = three();
    var color = options?.color || COLORS.write;
    var file = c.files[index];
    var group = new T.Group();
    var lattice = new T.LineSegments(latticeGeometry(c), cachedMaterial(c, 'lattice:' + color, function () {
      return new T.LineBasicMaterial({ color: color, transparent: true, opacity: 0.95, depthWrite: false });
    }));
    group.add(lattice);
    var crane = options?.crane === false ? null : buildCrane(c, '#facc15');
    if (crane) { group.add(crane); }
    group.position.set(file.x, c.baseY[index], file.z);
    c.group.add(group);
    var scaffold = { group: group, lattice: lattice, crane: crane, phase: Math.random() * 6, index: index };
    c.scaffolds[index] = scaffold;
    fitScaffold(c, scaffold);
    return scaffold;
  }

  function fitScaffold(c, scaffold) {
    var file = c.files[scaffold.index];
    var target = Math.max(c.heights[scaffold.index], c.heightAnims[scaffold.index]?.to || 0);
    var height = Math.max(0.05, target) * 1.08 + 0.02;
    scaffold.lattice.scale.set(file.w * FOOTPRINT_FILL + 0.03, height, file.d * FOOTPRINT_FILL + 0.03);
    if (scaffold.crane) {
      scaffold.crane.position.set(file.w * FOOTPRINT_FILL / 2 + 0.006, height, -file.d * FOOTPRINT_FILL / 2 - 0.006);
    }
  }

  function removeScaffold(c, index) {
    var scaffold = c.scaffolds[index];
    if (!scaffold) { return; }
    c.group.remove(scaffold.group);
    delete c.scaffolds[index];
  }

  function tickScaffolds(c, dt) {
    Object.keys(c.scaffolds).forEach(function (key) {
      var scaffold = c.scaffolds[key];
      fitScaffold(c, scaffold);
      if (scaffold.crane && state.motion) {
        scaffold.phase += dt / 1000;
        scaffold.crane.userData.jib.rotation.y = Math.sin(scaffold.phase * 0.9) * 1.1 - 0.6;
        scaffold.crane.userData.hook.position.y = -0.04 - Math.abs(Math.sin(scaffold.phase * 1.7)) * 0.03;
      }
    });
  }

  function setFoundation(c, index, on) {
    var file = c.files[index];
    if (!file) { return; }
    if (!on) {
      if (c.foundations[index]) { c.group.remove(c.foundations[index]); delete c.foundations[index]; }
      return;
    }
    if (c.foundations[index]) { return; }
    var T = three();
    var slab = new T.Mesh(sharedBox(c), cachedMaterial(c, 'foundation', function () {
      return new T.MeshStandardMaterial({ color: '#94a3b8', roughness: 0.95, flatShading: true });
    }));
    slab.scale.set(file.w * FOOTPRINT_FILL + 0.026, 0.008, file.d * FOOTPRINT_FILL + 0.026);
    slab.position.set(file.x, c.baseY[index] + 0.004, file.z);
    c.group.add(slab);
    c.foundations[index] = slab;
  }

  /** A striped band texture: yellow/black hazard, amber/black tape, red/white warning. */
  function stripeTexture(c, key, a, b) {
    c.stripes = c.stripes || {};
    if (c.stripes[key]) { return c.stripes[key]; }
    var T = three();
    var canvas = doc().createElement('canvas');
    canvas.width = 64;
    canvas.height = 16;
    var ctx = canvas.getContext?.('2d');
    if (ctx) {
      ctx.fillStyle = a;
      ctx.fillRect(0, 0, 64, 16);
      ctx.fillStyle = b;
      for (var x = -16; x < 64; x += 16) {
        ctx.beginPath();
        ctx.moveTo(x, 16);
        ctx.lineTo(x + 8, 16);
        ctx.lineTo(x + 16, 0);
        ctx.lineTo(x + 8, 0);
        ctx.closePath();
        ctx.fill();
      }
    }
    var texture = track(c, new T.CanvasTexture(canvas));
    texture.wrapS = T.RepeatWrapping;
    texture.wrapT = T.ClampToEdgeWrapping;
    c.stripes[key] = texture;
    return texture;
  }

  var HAZARD_STYLES = {
    blind: { a: '#facc15', b: '#111827', height: 0.022, lift: 0.0, pad: 0.006 },
    unread: { a: '#f59e0b', b: '#111827', height: 0.012, lift: 0.03, pad: 0.03 },
    warning: { a: '#ef4444', b: '#f8fafc', height: 0.014, lift: 0.05, pad: 0.04 }
  };

  /** An open box band (four faces, no lid) around a building base. */
  function bandGeometry(c) {
    if (c.bandGeometry) { return c.bandGeometry; }
    var T = three();
    var geometry = new T.CylinderGeometry(0.7071, 0.7071, 1, 4, 1, true);
    geometry.rotateY(Math.PI / 4);
    geometry.translate(0, 0.5, 0);
    c.bandGeometry = track(c, geometry);
    return geometry;
  }

  function setHazard(c, index, kind, slot) {
    var key = (slot || kind || 'blind') + ':' + index;
    var existing = c.hazards[key];
    if (!kind) {
      if (existing) { c.group.remove(existing); delete c.hazards[key]; }
      return;
    }
    if (existing || Object.keys(c.hazards).length >= HAZARD_CAP || !c.files[index]) { return; }
    var T = three();
    var style = HAZARD_STYLES[kind] || HAZARD_STYLES.blind;
    var file = c.files[index];
    var material = cachedMaterial(c, 'hazard:' + kind, function () {
      var texture = stripeTexture(c, kind, style.a, style.b);
      return new T.MeshBasicMaterial({ map: texture, side: T.DoubleSide, transparent: true, opacity: 1 });
    });
    var band = new T.Mesh(bandGeometry(c), material);
    band.scale.set(file.w * FOOTPRINT_FILL + style.pad, style.height, file.d * FOOTPRINT_FILL + style.pad);
    band.position.set(file.x, c.baseY[index] + style.lift, file.z);
    band.userData.kind = kind;
    c.group.add(band);
    c.hazards[key] = band;
  }

  function clearHazards(c, slot) {
    Object.keys(c.hazards).forEach(function (key) {
      if (key.indexOf(slot + ':') === 0) { c.group.remove(c.hazards[key]); delete c.hazards[key]; }
    });
  }

  function hazardIndexes(c, slot) {
    return Object.keys(c.hazards).filter(function (key) { return key.indexOf(slot + ':') === 0; }).map(function (key) { return Number(key.split(':')[1]); });
  }

  function tickHazards(c, timeMs) {
    var pulse = state.motion ? 0.55 + 0.45 * Math.abs(Math.sin(timeMs / 300)) : 1;
    var materials = c.materials || {};
    if (materials['hazard:unread']) { materials['hazard:unread'].opacity = pulse; }
    if (materials['hazard:warning']) { materials['hazard:warning'].opacity = pulse; }
    // The stripes crawl round the band, like tape in the wind.
    if (state.motion && c.stripes) {
      ['unread', 'warning'].forEach(function (key) { if (c.stripes[key]) { c.stripes[key].offset.x = (timeMs / 2500) % 1; } });
    }
  }

  // -- The city object ----------------------------------------------------------

  /**
   * Builds the city on `el` (an a-entity) from {files, districts, outside,
   * plateHeight}. Synchronous, so the view can use it at once; the component
   * reuses the city when it initializes later.
   */
  function createCity(el, data) {
    var T = three();
    var files = data.files || [];
    var count = Math.max(1, files.length);
    var group = new T.Group();
    group.name = 'agentFlowCityChart';
    var c = {
      el: el, group: group, files: files, districts: data.districts || [], outside: data.outside || [],
      disposables: [], matrix: new T.Matrix4(), color: new T.Color(), scratch: new T.Vector3(),
      baseY: new Float32Array(count), heights: new Float32Array(count), heightAnims: {},
      colorKeys: new Array(count).fill(''), tints: new Array(count).fill(null),
      demolitions: {}, scaffolds: {}, foundations: {}, hazards: {}
    };
    c.plateHeight = plateHeightOf(c.districts, data.plateHeight);
    buildPlates(c);
    buildBuildings(c);
    el.object3D.add(group);
    el.codexrCity = c;
    return c;
  }

  var cityApi = {
    getBuildingTop: function (c, index) {
      var file = c.files[index];
      if (!file) { return { x: 0, y: 0.2, z: 0 }; }
      var height = Math.max(c.heights[index], c.heightAnims[index]?.to || 0);
      return { x: file.x, y: c.baseY[index] + height, z: file.z };
    },
    getBuildingBase: function (c, index) {
      var file = c.files[index];
      return file ? { x: file.x, y: c.baseY[index], z: file.z } : { x: 0, y: 0, z: 0 };
    },
    getFootprint: function (c, index) {
      var file = c.files[index];
      return file ? { w: file.w * FOOTPRINT_FILL, d: file.d * FOOTPRINT_FILL } : { w: 0, d: 0 };
    },
    getHeight: function (c, index) { return c.heights[index] || 0; },
    getBuildingEntity: function (c) { return c.buildingsEl; },
    setBuildingHeight: function (c, index, height, animate, durationMs) {
      if (!c.files[index]) { return false; }
      var target = Math.max(0, Number(height) || 0);
      if (Math.abs(target - c.heights[index]) < 1e-5 && !c.heightAnims[index]) { return false; }
      if (animate && state.motion) {
        c.heightAnims[index] = { from: c.heights[index], to: target, t: 0, dur: Math.max(120, durationMs || 600), ease: easeOutCubic };
        return false;
      }
      delete c.heightAnims[index];
      delete c.demolitions[index];
      c.heights[index] = target;
      writeBuildingMatrix(c, index);
      return true;
    },
    setBuildingColor: function (c, index, hex) {
      if (c.colorKeys[index] === hex) { return false; }
      c.colorKeys[index] = hex;
      c.buildings.setColorAt(index, c.color.set(hex));
      c.colorsDirty = true;
      return true;
    },
    setRoofTint: function (c, index, hex) {
      if (!c.files[index] || c.tints[index] === (hex || null)) { return; }
      c.tints[index] = hex || null;
      if (hex) { c.roofs.setColorAt(index, c.color.set(hex)); }
      writeRoofMatrix(c, index);
    },
    addScaffold: addScaffold,
    removeScaffold: removeScaffold,
    hasScaffold: function (c, index) { return !!c.scaffolds[index]; },
    scaffoldIndexes: function (c) { return Object.keys(c.scaffolds).map(Number); },
    /** Crumbles a building: it leans, shrinks and sinks to nothing. */
    demolish: function (c, index, durationMs) {
      if (!c.files[index] || c.heights[index] <= 0.0005) { return; }
      if (!state.motion) { cityApi.setBuildingHeight(c, index, 0, false); return; }
      c.demolitions[index] = { t: 0, lean: (index % 2 ? 1 : -1) * 0.25 };
      c.heightAnims[index] = { from: c.heights[index], to: 0, t: 0, dur: Math.max(300, durationMs || 900), ease: function (t) { return t * t; }, demolish: true };
    },
    /** Raises a new building from its foundation to `height`. */
    raise: function (c, index, height, durationMs) {
      if (!c.files[index]) { return; }
      cityApi.setFoundation(c, index, true);
      if (!state.motion) { cityApi.setBuildingHeight(c, index, height, false); return; }
      c.heights[index] = Math.min(c.heights[index], 0.001);
      writeBuildingMatrix(c, index);
      c.heightAnims[index] = { from: c.heights[index], to: Math.max(0, height), t: 0, dur: Math.max(300, durationMs || 900), ease: easeOutBack };
    },
    setFoundation: setFoundation,
    setHazard: setHazard,
    clearHazards: clearHazards,
    hazardIndexes: hazardIndexes,
    isAnimating: function (c) { return Object.keys(c.heightAnims).length > 0; },
    /** Per-frame: height tweens, crumbling, crane swing, tape pulse. Returns true while heights move. */
    tick: function (c, dt, timeMs) {
      var keys = Object.keys(c.heightAnims);
      keys.forEach(function (key) {
        var anim = c.heightAnims[key];
        anim.t = Math.min(1, anim.t + dt / anim.dur);
        var eased = (anim.ease || easeOutCubic)(anim.t);
        c.heights[key] = Math.max(0, anim.from + (anim.to - anim.from) * eased);
        if (c.demolitions[key]) { c.demolitions[key].t = anim.t; }
        writeBuildingMatrix(c, Number(key));
        if (anim.t >= 1) {
          delete c.heightAnims[key];
          if (anim.demolish) { delete c.demolitions[key]; c.heights[key] = 0; writeBuildingMatrix(c, Number(key)); }
        }
      });
      if (keys.length) { markBuildingsDirty(c); }
      tickScaffolds(c, dt);
      tickHazards(c, timeMs || 0);
      flushRoofs(c);
      return keys.length > 0;
    },
    /** Pushes pending colour and matrix writes to the GPU. */
    flush: function (c) {
      markBuildingsDirty(c);
      if (c.colorsDirty && c.buildings.instanceColor) { c.buildings.instanceColor.needsUpdate = true; }
      c.colorsDirty = false;
    },
    dispose: function (c) {
      c.group.parent?.remove(c.group);
      c.buildingsEl?.parentNode?.removeChild?.(c.buildingsEl);
      disposeTracked(c);
      if (c.el) { c.el.codexrCity = null; }
    }
  };

  /** Binds the API to one city: city.getBuildingTop(i) and so on. */
  function bindCityApi(c) {
    var bound = {};
    Object.keys(cityApi).forEach(function (name) {
      bound[name] = function () { return cityApi[name].apply(null, [c].concat(Array.prototype.slice.call(arguments))); };
    });
    bound.state = c;
    return bound;
  }

  function registerCityComponent() {
    var aframe = root.AFRAME;
    if (!aframe?.registerComponent || aframe.components?.[CITY_COMPONENT]) { return; }
    aframe.registerComponent(CITY_COMPONENT, {
      init: function () {
        var c = this.el.codexrCity || (this.el.codexrCityData ? createCity(this.el, this.el.codexrCityData) : null);
        if (!c) { return; }
        var api = c.api || (c.api = bindCityApi(c));
        var component = this;
        Object.keys(api).forEach(function (name) { component[name] = api[name]; });
      },
      remove: function () {
        if (this.el.codexrCity && !this.el.codexrCity.external) { cityApi.dispose(this.el.codexrCity); }
      }
    });
  }

  /** Mounts a city entity under the view's root and returns its bound API. */
  function mountCity(v) {
    var el = entity('a-entity', { id: 'codexrAgentFlowCity', 'data-codexr-role': 'agent-flow city' });
    el.codexrCityData = { files: v.files, districts: v.dataset.districts, outside: v.outside, plateHeight: v.dataset.plateHeight };
    var c = createCity(el, el.codexrCityData);
    // The view owns the lifecycle (destroyView disposes it), not the component.
    c.external = true;
    c.api = bindCityApi(c);
    el.setAttribute(CITY_COMPONENT, '');
    v.rootEl.appendChild(el);
    v.cityEl = el;
    v.city = c.api;
    // Shared read-only views the overlays (turn rings, delta caps) draw from.
    v.baseY = c.baseY;
    v.heights = c.heights;
    v.heightAnims = c.heightAnims;
    v.matrix = new (three().Matrix4)();
    v.color = new (three().Color)();
    v.buildingsEl = c.buildingsEl;
    return v.city;
  }

  /** Heights straight to the state (seek, static mode) or tweened (forward step). */
  function applyHeights(v, cityState, animate, durationMs) {
    var changed = false;
    cityState.files.forEach(function (fileState, index) {
      var target = fileState.visible && !fileState.deleted ? fileState.height : 0;
      var current = v.heights[index];
      if (animate && state.motion) {
        if (fileState.deleted && current > 0.0005 && !v.heightAnims[index]) { v.city.demolish(index, durationMs * 1.3); return; }
        if (current <= 0.0005 && target > 0.0005 && v.files[index].created) { v.city.raise(index, target, durationMs * 1.4); return; }
      }
      if (v.city.setBuildingHeight(index, target, animate, durationMs)) { changed = true; }
    });
    if (changed) { v.city.flush(); }
  }

  /** Per-instance colours for the current view (replay tint or heat), plus roof tints. */
  function applyColors(v, cityState) {
    var focus = {};
    var current = cityState.current;
    if (current && !state.toggles.heat && current.kind !== 'execute') {
      current.files.forEach(function (fileIndex) { focus[fileIndex] = current.failed ? 'failed' : current.kind; });
    }
    var unread = state.toggles.blast ? unreadDependentSet(v, cityState) : {};
    var involved = state.toggles.blast ? blastInvolvedSet(v, cityState) : null;
    var dirty = false;
    cityState.files.forEach(function (fileState, index) {
      var hex;
      if (unread[index]) {
        hex = COLORS.unread;
      } else if (focus[index] === 'failed') {
        hex = COLORS.failed;
      } else if (state.toggles.heat) {
        hex = heatColor(fileState, v.outside[index]);
      } else {
        hex = replayColor(fileState, v.outside[index], focus[index]);
      }
      // Blast radius: everything outside the written files and their
      // dependents steps back so the amber oversight signal carries.
      if (involved && !involved[index] && !unread[index]) { hex = mixHex(hex, '#0b1220', 0.6); }
      if (v.city.setBuildingColor(index, hex)) { dirty = true; }
      v.city.setRoofTint(index, state.toggles.heat ? null : roofTintFor(fileState));
    });
    if (dirty) { v.city.flush(); }
  }

  /** Roofs keep what happened to them: cyan read, orange written, green created. */
  function roofTintFor(fileState) {
    if (fileState.deleted) { return null; }
    if (fileState.created && fileState.touches.writes > 0) { return COLORS.created; }
    if (fileState.touches.writes > 0) { return COLORS.write; }
    if (fileState.touches.reads > 0) { return COLORS.read; }
    return null;
  }

  /** Dependents of files written so far that the agent never touched (the oversight signal). */
  function unreadDependentSet(v, cityState) {
    var result = {};
    v.dataset.blastRadius.forEach(function (entry) {
      if (!(cityState.files[entry.file]?.touches.writes > 0)) { return; }
      entry.dependents.forEach(function (dependent) {
        if (cityState.files[dependent] && cityState.files[dependent].lastIndex < 0) { result[dependent] = true; }
      });
    });
    return result;
  }

  /** Written files with a blast radius, plus every dependent of theirs. */
  function blastInvolvedSet(v, cityState) {
    var result = {};
    v.dataset.blastRadius.forEach(function (entry) {
      if (!(cityState.files[entry.file]?.touches.writes > 0)) { return; }
      result[entry.file] = true;
      entry.dependents.forEach(function (dependent) { result[dependent] = true; });
    });
    return result;
  }

  function roofPoint(v, fileIndex) { return v.city.getBuildingTop(fileIndex); }

  function centroidOf(v, fileIndexes) {
    if (!fileIndexes.length) { return { x: 0, y: 0.3, z: 0 }; }
    var sum = { x: 0, y: 0, z: 0 };
    fileIndexes.forEach(function (index) {
      var roof = roofPoint(v, index);
      sum.x += roof.x;
      sum.z += roof.z;
      sum.y = Math.max(sum.y, roof.y);
    });
    return { x: sum.x / fileIndexes.length, y: sum.y, z: sum.z / fileIndexes.length };
  }

  /** The building under a raycaster intersection, or -1. */
  function fileFromIntersection(intersection) {
    if (intersection?.object && intersection.object.name && intersection.object.name !== 'agentFlowBuildings') { return -1; }
    var id = intersection?.instanceId;
    return Number.isInteger(id) ? id : -1;
  }
