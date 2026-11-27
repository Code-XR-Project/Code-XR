(function registerCodeXRDependencyVisualBudgetRuntime(root) {
  'use strict';

  if (root.CodeXRDependencyVisualBudgetRuntime) { return; }

  const PROFILES = ['sparse', 'balanced', 'dense'];
  const WIDTH_RANGES = {
    sparse: [.006, .024],
    balanced: [.004, .018],
    dense: [.0025, .010]
  };
  const OPACITY_MULTIPLIERS = {
    sparse: 1,
    balanced: .32,
    dense: .08
  };
  const CONFIDENCE_OPACITY = {
    exact: .76,
    probable: .5,
    ambiguous: .26
  };
  const FLOW_LIMITS = {
    sparse: 300,
    balanced: 80,
    dense: 40
  };
  const subscribers = new Set();
  let override = 'auto';
  let snapshot = createSnapshot({}, 'full', override);

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, Number(value) || 0));
  }

  function profileRank(profile) {
    return Math.max(0, PROFILES.indexOf(profile));
  }

  function profileAt(rank) {
    return PROFILES[clamp(rank, 0, PROFILES.length - 1)];
  }

  function calculateDensity(stats) {
    const nodes = Math.max(0, Number(stats?.nodeCount || 0));
    const edges = Math.max(0, Number(stats?.edgeCount || 0));
    const ratio = nodes > 0 ? edges / nodes : edges;
    const maxDegree = Math.max(0, Number(stats?.maxDegree || 0));
    const pressure = Math.max(
      edges / 800,
      ratio / 5,
      maxDegree / 100,
      nodes / 600
    );
    const profile = edges <= 150 && ratio <= 2 && maxDegree <= 20 && nodes <= 120
      ? 'sparse'
      : pressure >= 1
        ? 'dense'
        : 'balanced';
    return {
      profile: profile,
      score: Math.round(pressure * 100) / 100,
      nodeCount: nodes,
      edgeCount: edges,
      edgeNodeRatio: Math.round(ratio * 100) / 100,
      maxDegree: maxDegree
    };
  }

  function effectiveProfile(densityProfile, renderQuality, detailOverride) {
    const densityRank = profileRank(densityProfile);
    const performanceRank = renderQuality === 'static' ? 2 : renderQuality === 'interactive' ? 1 : 0;
    const requestedRank = detailOverride === 'focus'
      ? 2
      : detailOverride === 'full'
        ? Math.max(0, densityRank - 1)
        : densityRank;
    return profileAt(Math.max(requestedRank, performanceRank));
  }

  function widthsForProfile(profile) {
    const range = WIDTH_RANGES[profile] || WIDTH_RANGES.balanced;
    const factors = [0, .22, .46, .7, 1];
    return factors.map(function (factor) {
      return range[0] + ((range[1] - range[0]) * factor);
    });
  }

  function opacityFor(profile, confidence, focused) {
    if (focused) { return confidence === 'ambiguous' ? .72 : .96; }
    const base = CONFIDENCE_OPACITY[confidence] || CONFIDENCE_OPACITY.probable;
    return Math.max(.015, base * (OPACITY_MULTIPLIERS[profile] || OPACITY_MULTIPLIERS.balanced));
  }

  function createSnapshot(stats, renderQuality, detailOverride) {
    const density = calculateDensity(stats);
    const effective = effectiveProfile(density.profile, renderQuality, detailOverride);
    return Object.assign({}, density, {
      override: detailOverride,
      renderQuality: renderQuality,
      effectiveProfile: effective,
      widths: widthsForProfile(effective),
      flowLimit: FLOW_LIMITS[effective],
      arrowsForAll: effective === 'sparse'
    });
  }

  function publish(next) {
    snapshot = next;
    subscribers.forEach(function (subscriber) {
      try { subscriber(getSnapshot()); } catch {}
    });
  }

  function update(stats, renderQuality) {
    publish(createSnapshot(stats, renderQuality || snapshot.renderQuality || 'full', override));
    return getSnapshot();
  }

  function setOverride(nextOverride) {
    if (!['auto', 'full', 'focus'].includes(nextOverride)) { return getSnapshot(); }
    override = nextOverride;
    publish(createSnapshot(snapshot, snapshot.renderQuality, override));
    return getSnapshot();
  }

  function getSnapshot() {
    return Object.assign({}, snapshot, { widths: snapshot.widths.slice() });
  }

  function subscribe(subscriber) {
    if (typeof subscriber !== 'function') { return function () {}; }
    subscribers.add(subscriber);
    subscriber(getSnapshot());
    return function () { subscribers.delete(subscriber); };
  }

  root.CodeXRDependencyVisualBudgetRuntime = {
    update: update,
    setOverride: setOverride,
    getSnapshot: getSnapshot,
    subscribe: subscribe,
    opacityFor: opacityFor,
    __testing: {
      calculateDensity: calculateDensity,
      effectiveProfile: effectiveProfile,
      widthsForProfile: widthsForProfile,
      opacityFor: opacityFor,
      createSnapshot: createSnapshot
    }
  };
})(typeof window !== 'undefined' ? window : this);
