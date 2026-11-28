// == agentFlowRuntime.js | playbackMachine (assembled per manifest.json; see COMPONENTS.md) ==
  // The transport as a small state machine with an injected clock, so tests
  // drive it with a fake scheduler. It never touches the scene: it reports a
  // new playhead through onPosition(index, { animate, reason }) and the view
  // decides how to draw it. Play advances one step every BASE_STEP_MS / speed
  // and never outruns the hop animation (hopStarted / hopFinished).

  function createPlayback(options) {
    var o = options || {};
    var schedule = o.schedule || function (fn, ms) { return root.setTimeout(fn, ms); };
    var cancel = o.cancel || function (handle) { root.clearTimeout(handle); };
    var p = {
      index: -1, playing: false, speed: 1, followLive: true, live: false,
      hopBusy: false, waitingForHop: false, timer: null, generation: 0
    };

    function count() { return Math.max(0, Math.floor(Number(o.getCount?.()) || 0)); }
    function changed() { o.onChange?.(snapshot()); }
    function interval() { return BASE_STEP_MS / p.speed; }
    function emit(index, animate, reason) {
      p.index = index;
      o.onPosition?.(index, { animate: !!animate, reason: reason });
    }
    function clearTimer() {
      if (p.timer !== null) { cancel(p.timer); p.timer = null; }
    }
    function scheduleNext(delay) {
      clearTimer();
      var generation = p.generation;
      p.timer = schedule(function () {
        p.timer = null;
        if (generation !== p.generation || !p.playing) { return; }
        advance();
      }, delay === undefined ? interval() : delay);
    }
    function advance() {
      if (p.hopBusy) {
        p.waitingForHop = true;
        return;
      }
      if (p.index >= count() - 1) {
        // A live session keeps "playing" at the end, waiting for the agent;
        // a finished replay stops.
        if (!(p.followLive && p.live)) { p.playing = false; }
        changed();
        return;
      }
      emit(p.index + 1, true, 'play');
      scheduleNext();
      changed();
    }
    function play() {
      var total = count();
      if (!total) { return false; }
      p.playing = true;
      p.generation += 1;
      // Play on the last step of a finished replay starts it over.
      if (p.index >= total - 1 && !(p.followLive && p.live)) { emit(-1, false, 'restart'); }
      scheduleNext(Math.min(260, interval()));
      changed();
      return true;
    }
    function pause() {
      p.playing = false;
      p.generation += 1;
      p.waitingForHop = false;
      clearTimer();
      changed();
    }
    function clampIndex(index) {
      return Math.max(-1, Math.min(count() - 1, Math.floor(Number(index))));
    }
    function seek(index) {
      if (!Number.isFinite(Number(index))) { return p.index; }
      pause();
      emit(clampIndex(index), false, 'seek');
      changed();
      return p.index;
    }
    function stepForward() {
      pause();
      if (p.index < count() - 1) { emit(p.index + 1, true, 'step'); changed(); }
      return p.index;
    }
    function stepBack() {
      pause();
      if (p.index > -1) { emit(p.index - 1, false, 'step'); changed(); }
      return p.index;
    }
    function turnStarts() { return (o.getTurnStarts?.() || []).slice().sort(function (a, b) { return a - b; }); }
    function nextTurn() {
      var target = turnStarts().find(function (start) { return start > p.index; });
      return seek(target === undefined ? count() - 1 : target);
    }
    function previousTurn() {
      var earlier = turnStarts().filter(function (start) { return start < p.index; });
      return seek(earlier.length ? earlier[earlier.length - 1] : -1);
    }
    function setSpeed(speed) {
      var value = Number(speed);
      p.speed = Number.isFinite(value) && value > 0 ? Math.max(0.25, Math.min(8, value)) : 1;
      if (p.playing && p.timer !== null) { scheduleNext(); }
      changed();
      return p.speed;
    }
    function setFollowLive(enabled) {
      p.followLive = !!enabled;
      changed();
    }
    function setLive(live) {
      p.live = !!live;
      if (!p.live && p.playing && p.index >= count() - 1 && p.timer === null && !p.hopBusy) {
        p.playing = false;
      }
    }
    function hopStarted() { p.hopBusy = true; }
    function hopFinished() {
      p.hopBusy = false;
      if (p.waitingForHop && p.playing) {
        p.waitingForHop = false;
        advance();
      }
    }
    /** A live dataset grew: animate the new steps from the current playhead. */
    function datasetGrew(animateFrom) {
      if (animateFrom === null || animateFrom === undefined) { return false; }
      if (!(p.followLive && p.live)) { return false; }
      p.index = clampIndex(animateFrom - 1);
      p.playing = true;
      p.generation += 1;
      scheduleNext(Math.min(200, interval()));
      changed();
      return true;
    }
    /** Place the playhead without animating or notifying (a new dataset). */
    function reset(index) {
      p.playing = false;
      p.generation += 1;
      p.waitingForHop = false;
      p.hopBusy = false;
      clearTimer();
      p.index = clampIndex(index === undefined ? -1 : index);
    }
    function snapshot() {
      return {
        index: p.index, playing: p.playing, speed: p.speed, followLive: p.followLive,
        live: p.live, hopBusy: p.hopBusy, count: count()
      };
    }
    function dispose() { reset(-1); }
    return {
      play: play, pause: pause,
      toggle: function () { return p.playing ? (pause(), false) : play(); },
      seek: seek, stepForward: stepForward, stepBack: stepBack,
      nextTurn: nextTurn, previousTurn: previousTurn,
      setSpeed: setSpeed, setFollowLive: setFollowLive, setLive: setLive,
      hopStarted: hopStarted, hopFinished: hopFinished,
      datasetGrew: datasetGrew, reset: reset, dispose: dispose,
      getState: snapshot
    };
  }
