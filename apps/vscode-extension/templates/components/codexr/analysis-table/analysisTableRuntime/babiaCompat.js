// == analysisTableRuntime.js | babiaCompat (assembled per manifest.json; see COMPONENTS.md) ==
  // BabiaXR 1.3.4 resizes an axis by animating `line__<axis>axis.end` with
  // A-Frame's `animation` component. Under A-Frame 1.7.1 that animation never
  // changes the multi-property `line.end`, so an axis keeps the length of its
  // FIRST build forever: a chart that shrinks (20-row slice after an all-rows
  // build, a re-analysis, a remap, an evolution frame) leaves its axis hanging
  // off the table. Every axis line is therefore written directly; the labels
  // keep Babia's fade, which animates a plain number and works.
  var BABIA_AXIS_COMPONENT_NAMES = ['babia-axis-x', 'babia-axis-y', 'babia-axis-z'];
  var BABIA_COMPAT_PATCH_FLAG = '__codexrDirectLine';

  // A resized axis changes the chart's footprint without any event the
  // containment listens to, so a chart first built over more rows kept the
  // scale fitted to the long axis (a sliver for ~15 s on 400 rows). Ask the
  // enclosing containment for a re-fit once the burst of axis updates (x, y,
  // labels) is over; the delay clears requestRenormalize's debounce window.
  var AXIS_RESIZE_REFIT_DELAY_MS = 320;
  var AXIS_RESIZE_TIMER_KEY = '__codexrAxisResizeRefitTimer';

  function findContainmentComponent(el) {
    var node = el;
    while (node) {
      var component = node.components && node.components[COMPONENT_NAME];
      if (component) {
        return component;
      }
      node = node.parentNode;
    }
    return null;
  }

  function notifyContainmentOfAxisResize(el) {
    var component = findContainmentComponent(el);
    if (!component || typeof component.requestRenormalize !== 'function' || typeof setTimeout !== 'function') {
      return false;
    }
    if (component[AXIS_RESIZE_TIMER_KEY]) {
      clearTimeout(component[AXIS_RESIZE_TIMER_KEY]);
    }
    component[AXIS_RESIZE_TIMER_KEY] = setTimeout(function () {
      component[AXIS_RESIZE_TIMER_KEY] = null;
      component.requestRenormalize('babia-axis-resized');
    }, AXIS_RESIZE_REFIT_DELAY_MS);
    return true;
  }

  function patchBabiaAxisPrototype(axis) {
    var proto = axis ? Object.getPrototypeOf(axis) : null;
    if (!proto || typeof proto.updateLine !== 'function' || proto.updateLine[BABIA_COMPAT_PATCH_FLAG]) {
      return false;
    }
    var originalUpdateLine = proto.updateLine;
    var directUpdateLine = function (length, color) {
      var anim = this.anim;
      this.anim = false;
      try {
        return originalUpdateLine.call(this, length, color);
      } finally {
        this.anim = anim;
        notifyContainmentOfAxisResize(this.el);
      }
    };
    directUpdateLine[BABIA_COMPAT_PATCH_FLAG] = true;
    proto.updateLine = directUpdateLine;
    return true;
  }

  function installBabiaAxisLineCompat(aframe) {
    var patched = [];
    if (!aframe || !aframe.components) {
      return patched;
    }
    BABIA_AXIS_COMPONENT_NAMES.forEach(function (name) {
      var registered = aframe.components[name];
      var Component = registered && registered.Component;
      var proto = Component && Component.prototype;
      if (!proto || typeof proto.init !== 'function' || proto.init[BABIA_COMPAT_PATCH_FLAG]) {
        return;
      }
      var originalInit = proto.init;
      var patchedInit = function () {
        var result = originalInit.apply(this, arguments);
        // The Axis class is private to the Babia bundle; its prototype is
        // reachable only through an instance, so the first one patches it.
        patchBabiaAxisPrototype(this.axis);
        return result;
      };
      patchedInit[BABIA_COMPAT_PATCH_FLAG] = true;
      proto.init = patchedInit;
      patched.push(name);
    });
    return patched;
  }

  // `babia-queryjson` with neither `data` nor `url` fetches the empty URL,
  // i.e. the scene page itself, and fails parsing it as JSON. Generated
  // scenes declare the row slice that way on purpose: an EMPTY producer, so
  // the chart reading it waits for the first real slice instead of building
  // over all rows (or over an empty array, which yields -Infinity axes).
  function installBabiaQueryJsonCompat(aframe) {
    var registered = aframe && aframe.components && aframe.components['babia-queryjson'];
    var proto = registered && registered.Component && registered.Component.prototype;
    if (!proto || typeof proto.update !== 'function' || proto.update[BABIA_COMPAT_PATCH_FLAG]) {
      return false;
    }
    var originalUpdate = proto.update;
    var patchedUpdate = function () {
      var data = this.data || {};
      if (!data.data && !data.url) {
        return undefined;
      }
      return originalUpdate.apply(this, arguments);
    };
    patchedUpdate[BABIA_COMPAT_PATCH_FLAG] = true;
    proto.update = patchedUpdate;
    return true;
  }

  installBabiaAxisLineCompat(AFRAME);
  installBabiaQueryJsonCompat(AFRAME);

