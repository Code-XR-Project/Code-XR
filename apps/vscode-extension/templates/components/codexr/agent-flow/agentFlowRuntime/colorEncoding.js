// == agentFlowRuntime.js | colorEncoding (assembled per manifest.json; see COMPONENTS.md) ==
  // Pure colour functions: every hex the scene paints is chosen here, so the
  // encodings (verb hues, heat, turn ramp, delta caps) are unit-testable.

  function hexToRgb(hex) {
    var value = String(hex || '').replace('#', '');
    if (value.length === 3) { value = value.split('').map(function (c) { return c + c; }).join(''); }
    var parsed = parseInt(value, 16);
    if (!Number.isFinite(parsed) || value.length !== 6) { return { r: 0, g: 0, b: 0 }; }
    return { r: (parsed >> 16) & 255, g: (parsed >> 8) & 255, b: parsed & 255 };
  }

  function rgbToHex(rgb) {
    return '#' + [rgb.r, rgb.g, rgb.b].map(function (part) {
      var clamped = Math.max(0, Math.min(255, Math.round(part)));
      return clamped.toString(16).padStart(2, '0');
    }).join('');
  }

  /** Linear mix of two hexes, t = 0 gives a, t = 1 gives b. */
  function mixHex(a, b, t) {
    var from = hexToRgb(a);
    var to = hexToRgb(b);
    var k = Math.max(0, Math.min(1, Number(t) || 0));
    return rgbToHex({
      r: from.r + (to.r - from.r) * k,
      g: from.g + (to.g - from.g) * k,
      b: from.b + (to.b - from.b) * k
    });
  }

  function rampColor(stops, t) {
    if (!stops.length) { return '#ffffff'; }
    if (stops.length === 1) { return stops[0]; }
    var k = Math.max(0, Math.min(1, Number(t) || 0)) * (stops.length - 1);
    var index = Math.min(stops.length - 2, Math.floor(k));
    return mixHex(stops[index], stops[index + 1], k - index);
  }

  /** The colour of a step kind on ticks, pulses and the probe halo. */
  function kindColor(kind, failed) {
    if (failed) { return COLORS.failed; }
    if (kind === 'read') { return COLORS.read; }
    if (kind === 'search') { return COLORS.search; }
    if (kind === 'write') { return COLORS.write; }
    if (kind === 'execute') { return COLORS.executeOk; }
    if (kind === 'wait') { return COLORS.unread; }
    if (kind === 'delegate') { return '#e2e8f0'; }
    return COLORS.think;
  }

  /** A worker's colour: emerald for the main agent, then a fixed cycle. */
  function actorColor(actorIndex) {
    var index = Math.max(0, Math.floor(Number(actorIndex) || 0));
    return index === 0 ? ACCENT : ACTOR_PALETTE[(index - 1) % ACTOR_PALETTE.length];
  }

  /** Turn ring colour: a sequential ramp, the first turn coolest. */
  function turnColor(turnIndex, turnCount) {
    var count = Math.max(1, Number(turnCount) || 1);
    return rampColor(TURN_RAMP, count === 1 ? 0.5 : Math.max(0, Number(turnIndex) || 0) / (count - 1));
  }

  /**
   * What happened to a file so far, one word: the Heat view's category.
   * 'deleted' beats 'created' beats 'written' beats 'read' beats 'searched'.
   */
  function heatCategory(fileState) {
    if (!fileState) { return 'untouched'; }
    if (fileState.deleted) { return 'deleted'; }
    if (fileState.touches.writes > 0) { return fileState.created ? 'created' : 'written'; }
    if (fileState.touches.reads > 0) { return 'read'; }
    if (fileState.touches.searches > 0) { return 'searched'; }
    return 'untouched';
  }

  function baseColor(outside) {
    return outside ? COLORS.outside : COLORS.base;
  }

  /** Heat view: the end-of-session (or playhead) footprint. */
  function heatColor(fileState, outside) {
    var category = heatCategory(fileState);
    if (category === 'created') { return COLORS.created; }
    if (category === 'written') { return COLORS.write; }
    if (category === 'read') { return COLORS.heatRead; }
    if (category === 'searched') { return mixHex(baseColor(outside), COLORS.heatSearch, 0.45); }
    if (category === 'deleted') { return COLORS.baseDark; }
    return mixHex(baseColor(outside), COLORS.baseDark, 0.35);
  }

  /**
   * Replay view: untouched files stay neutral slate; a touched file keeps a
   * soft tint of what was done to it; the file under the probe glows in the
   * full verb colour (focus + context, research.md section 3.3).
   */
  function replayColor(fileState, outside, focusKind) {
    var neutral = baseColor(outside);
    if (focusKind) {
      return focusKind === 'write' && fileState?.created ? COLORS.created : kindColor(focusKind, false);
    }
    var category = heatCategory(fileState);
    if (category === 'created') { return mixHex(neutral, COLORS.created, 0.42); }
    if (category === 'written') { return mixHex(neutral, COLORS.write, 0.42); }
    if (category === 'read') { return mixHex(neutral, COLORS.read, 0.34); }
    if (category === 'searched') { return mixHex(neutral, COLORS.search, 0.16); }
    return neutral;
  }

  /** Delta cap on a written building: diverging hue by sign, thickness by magnitude. */
  function deltaCapStyle(codeLines, maxAbs) {
    var value = Number(codeLines) || 0;
    var magnitude = Math.min(1, Math.abs(value) / Math.max(1, Number(maxAbs) || 1));
    return {
      color: value < 0 ? COLORS.deltaDown : COLORS.deltaUp,
      thickness: 0.008 + magnitude * 0.034,
      sign: value < 0 ? -1 : (value > 0 ? 1 : 0)
    };
  }

  function districtTone(depth) {
    var index = Math.max(0, Math.min(DISTRICT_TONES.length - 1, (Number(depth) || 1) - 1));
    return DISTRICT_TONES[index];
  }
