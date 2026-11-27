// == analysisTableRuntime.js | diagnosticsAndPid (assembled per manifest.json; see COMPONENTS.md) ==
  function buildAxisDiagnostics(target) {
    if (!target) {
      return null;
    }
    return {
      ratio: Number.isFinite(target.ratio) ? toFixedNumber(target.ratio) : null,
      height: Number.isFinite(target.currentHeight) ? toFixedNumber(target.currentHeight) : null,
      targetScale: Number.isFinite(target.targetScale) ? toFixedNumber(target.targetScale) : null,
      setpoint: Number.isFinite(target.setpointRatio)
        ? toFixedNumber(target.setpointRatio)
        : (Number.isFinite(target.setpointHeight) ? toFixedNumber(target.setpointHeight) : null),
      withinBand: !!target.withinBand,
      underflowing: !!target.underflowing,
      underflowAllowed: !!target.underflowAllowed,
      overflowing: !!target.overflowing,
      compromised: !!target.compromised,
      reason: target.reason || ''
    };
  }

  function shouldAnimateContainmentTransform(reason, previousTransform, nextTransform, data) {
    if (!previousTransform || !nextTransform || !transformsDiffer(previousTransform, nextTransform)) {
      return false;
    }
    if (!data || !(data.transformTransitionMs > 0)) {
      return false;
    }
    var text = String(reason || '');
    if (!text || text === 'init' || text === 'bootstrap-visible' || text.indexOf('hard-height-guard') !== -1) {
      return false;
    }
    return text.indexOf('mapping') !== -1
      || text.indexOf('componentchanged') !== -1
      || text.indexOf('chart-rendered') !== -1
      || text.indexOf('analysis-updated') !== -1
      || text.indexOf('dataRefresh') !== -1
      || text.indexOf('manual-renormalize') !== -1
      || text.indexOf('update') !== -1;
  }

  function buildContainmentCorrectionState(measurements, object3D, data, fitMode) {
    if (!hasUsableMeasurements(measurements) || !object3D || !object3D.scale || !data) {
      return null;
    }

    var steadyRange = resolveSteadyPlanarRange(data);
    var containmentLimits = computeContainmentLimits(data);
    var xTarget = computePlanarAxisTargetScale(
      measurements.primary.size.x,
      measurements.containment.size.x,
      object3D.scale.x,
      containmentLimits.containmentWidthLimit,
      steadyRange,
      data.containmentToleranceRatio,
      data.planarUnderflowCorrectionEnabled !== false
    );
    var zTarget = computePlanarAxisTargetScale(
      measurements.primary.size.z,
      measurements.containment.size.z,
      object3D.scale.z,
      containmentLimits.containmentDepthLimit,
      steadyRange,
      data.containmentToleranceRatio,
      data.planarUnderflowCorrectionEnabled !== false
    );
    var heightTargets = resolveHeightBandTargets(data);
    var hardHeightGuard = computeHardHeightGuardTarget(
      measurements.peakHeight,
      object3D.scale.y,
      heightTargets,
      Math.max(0.001, data.yScaleMin),
      Math.max(data.yScaleMin + 0.001, data.yScaleMax),
      data.hardHeightGuardEnabled !== false,
      data.containmentToleranceRatio
    );
    var yTarget = computeHeightBandTargetScale(
      measurements.peakHeight,
      object3D.scale.y,
      heightTargets,
      Math.max(0.001, data.yScaleMin),
      Math.max(data.yScaleMin + 0.001, data.yScaleMax),
      data.heightUnderflowCorrectionEnabled !== false,
      data.containmentToleranceRatio
    ) || createNeutralHeightBandTarget(object3D.scale.y, 'height-unavailable');

    if (!xTarget || !zTarget) {
      return null;
    }

    xTarget = constrainPlanarTargetForHeightCompromise(xTarget, object3D.scale.x, yTarget, measurements.peakHeight, heightTargets.maxHeight);
    zTarget = constrainPlanarTargetForHeightCompromise(zTarget, object3D.scale.z, yTarget, measurements.peakHeight, heightTargets.maxHeight);

    if (fitMode === 'planar-uniform') {
      // Mirror the steady controller: both planar axes aim at the same scale
      // value, so the non-binding axis's under-occupancy is by design and
      // must not keep the chart "correcting" forever.
      var unified = unifyPlanarTargets(xTarget, zTarget);
      xTarget = unified.x;
      zTarget = unified.z;
    }

    var xNeedsCorrection = targetNeedsCorrection(xTarget, object3D.scale.x);
    var yNeedsCorrection = targetNeedsCorrection(yTarget, object3D.scale.y) || !!hardHeightGuard.overflowing;
    var zNeedsCorrection = targetNeedsCorrection(zTarget, object3D.scale.z);

    return {
      x: xTarget,
      y: yTarget,
      z: zTarget,
      axes: {
        x: buildAxisDiagnostics(xTarget),
        y: buildAxisDiagnostics(Object.assign({ currentHeight: measurements.peakHeight }, yTarget)),
        z: buildAxisDiagnostics(zTarget)
      },
      needsCorrection: xNeedsCorrection || yNeedsCorrection || zNeedsCorrection,
      compromised: xTarget.compromised || yTarget.compromised || zTarget.compromised,
      outOfBand: !xTarget.withinBand || !yTarget.withinBand || !zTarget.withinBand,
      containmentWidthLimit: containmentLimits.containmentWidthLimit,
      containmentDepthLimit: containmentLimits.containmentDepthLimit,
      minHeight: heightTargets.minHeight,
      maxHeight: heightTargets.maxHeight,
      heightOverflow: !!hardHeightGuard.overflowing,
      heightRatio: hardHeightGuard.heightRatio,
      hardHeightGuardTargetY: hardHeightGuard.targetY,
      hardHeightGuardCompromised: !!hardHeightGuard.compromised
    };
  }

  // Signature of "the fit currently on screen". It deliberately mirrors what the
  // fit actually uses: the filtered primary/containment bounds, the peak height
  // and the transform.
  //
  // `full` bounds are NOT part of it. They are measured without the auxiliary
  // filter (legends, tooltips, troika labels), so a legend that follows the
  // camera or a label that loads late kept changing the signature forever: the
  // stabilization loop never saw three identical passes, never reached
  // 'steady-fit', and the maintenance tick kept re-fitting the chart every
  // 700 ms — charts that resized forever even once correctly contained.
  function buildMeasurementSignature(measurements, object3D) {
    if (!measurements || !measurements.primary || !object3D) {
      return null;
    }

    var primary = measurements.primary;
    var containment = measurements.containment || primary;
    var peakHeight = Number.isFinite(measurements.peakHeight) ? measurements.peakHeight : null;

    return [
      toFixedNumber(primary.size.x),
      toFixedNumber(primary.size.y),
      toFixedNumber(primary.size.z),
      toFixedNumber(containment.size.x),
      toFixedNumber(containment.size.y),
      toFixedNumber(containment.size.z),
      toFixedNumber(peakHeight),
      toFixedNumber(object3D.scale.x),
      toFixedNumber(object3D.scale.y),
      toFixedNumber(object3D.scale.z),
      toFixedNumber(object3D.position.x),
      toFixedNumber(object3D.position.y),
      toFixedNumber(object3D.position.z)
    ].join('|');
  }

  function createPidAxisState() {
    return {
      integral: 0,
      lastError: 0,
      initialized: false
    };
  }

  function createPidControllerState() {
    return {
      active: false,
      stableTicks: 0,
      axes: {
        x: createPidAxisState(),
        y: createPidAxisState(),
        z: createPidAxisState()
      }
    };
  }

  function resetPidAxisState(axisState) {
    if (!axisState) {
      return;
    }
    axisState.integral = 0;
    axisState.lastError = 0;
    axisState.initialized = false;
  }

  function stepPidAxis(axisState, currentValue, targetValue, dtSeconds, profile) {
    if (!axisState || !Number.isFinite(currentValue) || !Number.isFinite(targetValue) || !Number.isFinite(dtSeconds) || dtSeconds <= 0 || !profile) {
      return {
        nextValue: currentValue,
        changed: false,
        stable: true,
        error: 0
      };
    }

    var error = targetValue - currentValue;
    // The dead zone is RELATIVE to the current scale (with the absolute value
    // as a floor): a fixed epsilon meant 0.1 % of a flat chart's scale (hyper
    // sensitive) but 15 % of boats' 0.01 X scale (numb) — same knob, opposite
    // behaviour per chart.
    var epsilon = Math.max(profile.epsilon, Math.abs(currentValue) * PID_PROFILE.relativeEpsilonRatio);
    if (Math.abs(error) <= epsilon) {
      resetPidAxisState(axisState);
      return {
        nextValue: currentValue,
        changed: false,
        stable: true,
        error: error
      };
    }

    axisState.integral = clamp(
      axisState.integral + (error * dtSeconds),
      -profile.integralLimit,
      profile.integralLimit
    );
    var derivative = axisState.initialized
      ? ((error - axisState.lastError) / Math.max(dtSeconds, 0.0001))
      : 0;
    axisState.lastError = error;
    axisState.initialized = true;

    var velocity = (profile.kp * error) + (profile.ki * axisState.integral) + (profile.kd * derivative);
    velocity = clamp(velocity, -profile.maxVelocity, profile.maxVelocity);

    var nextValue = currentValue + (velocity * dtSeconds);
    if ((error > 0 && nextValue > targetValue) || (error < 0 && nextValue < targetValue)) {
      nextValue = targetValue;
    }

    return {
      nextValue: nextValue,
      changed: Math.abs(nextValue - currentValue) > 0.0001,
      stable: false,
      error: error
    };
  }

  function computeAnchorOffset(measurements, data, surfaceLift) {
    if (!measurements || !isFiniteBoundsInfo(measurements.full) || !isFiniteBoundsInfo(measurements.primary) || !data) {
      return null;
    }
    var lift = Number.isFinite(surfaceLift) ? Math.max(0, surfaceLift) : 0;
    var tableTopY = getTableTopY(data) + lift;

    var deltaX = data.anchorX - measurements.primary.center.x;
    var deltaZ = data.anchorZ - measurements.primary.center.z;
    // Centring the PRIMARY bounds (bars, sectors) can push the axes, which
    // belong to the containment bounds, past the tabletop: a 3-bar chart has
    // its axis running out to one side. Shift just enough to keep the whole
    // containment box on the usable top (the region the size fit targets).
    if (isFiniteBoundsInfo(measurements.containment)) {
      var limits = computeContainmentLimits(data);
      deltaX = keepSpanInsideRegion(deltaX, measurements.containment.bounds.min.x, measurements.containment.bounds.max.x, data.anchorX, limits.containmentWidthLimit);
      deltaZ = keepSpanInsideRegion(deltaZ, measurements.containment.bounds.min.z, measurements.containment.bounds.max.z, data.anchorZ, limits.containmentDepthLimit);
    }

    return {
      deltaX: deltaX,
      deltaY: tableTopY - resolveAnchorMinY(measurements),
      deltaZ: deltaZ
    };
  }

  // The lowest point that must rest on the tabletop. Usually the primary
  // bounds (bars, sectors), but a scatter chart's axes start below its lowest
  // bubble: anchoring on the bubbles alone sank the axes into the table
  // (CHARTS-14). Taking the lower of the two keeps both on or above it.
  function resolveAnchorMinY(measurements) {
    var primaryMinY = measurements.primary.bounds.min.y;
    if (!isFiniteBoundsInfo(measurements.containment)) {
      return primaryMinY;
    }
    var containmentMinY = measurements.containment.bounds.min.y;
    return Number.isFinite(containmentMinY) ? Math.min(primaryMinY, containmentMinY) : primaryMinY;
  }

  // Adjusts a planar shift so that [min, max] + delta lies inside
  // [center - size/2, center + size/2]. A span wider than the region is
  // centred on it instead (the size fit is what shrinks it).
  function keepSpanInsideRegion(delta, min, max, center, size) {
    if (!Number.isFinite(delta) || !Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(center) || !(size > 0)) {
      return delta;
    }
    var regionMin = center - (size / 2);
    var regionMax = center + (size / 2);
    if ((max - min) >= size) {
      return center - ((min + max) / 2);
    }
    if (min + delta < regionMin) {
      return regionMin - min;
    }
    if (max + delta > regionMax) {
      return regionMax - max;
    }
    return delta;
  }

  var CONTAINMENT_OVERHANG_TOLERANCE = 0.02;

  // Distance (metres) by which the containment bounds stick out of the
  // usable tabletop on each planar axis; 0 when inside.
  function computeContainmentOverhang(measurements, data) {
    if (!measurements || !isFiniteBoundsInfo(measurements.containment) || !data) {
      return null;
    }
    var limits = computeContainmentLimits(data);
    var bounds = measurements.containment.bounds;
    function overhang(min, max, center, size) {
      return Math.max(0, (center - (size / 2)) - min, max - (center + (size / 2)));
    }
    return {
      x: overhang(bounds.min.x, bounds.max.x, data.anchorX, limits.containmentWidthLimit),
      z: overhang(bounds.min.z, bounds.max.z, data.anchorZ, limits.containmentDepthLimit)
    };
  }

  function buildTabletopAnchorDiagnostics(measurements, data, surfaceLift) {
    if (!measurements || !isFiniteBoundsInfo(measurements.primary) || !data) {
      return null;
    }
    var lift = Number.isFinite(surfaceLift) ? Math.max(0, surfaceLift) : 0;
    // Report against the chart's OWN anchor target: a chart that declares a
    // surface lift is correctly placed above the plane, not misaligned.
    var tableTopY = getTableTopY(data) + lift;
    var primaryMinY = resolveAnchorMinY(measurements);
    return {
      tableTopY: toFixedNumber(tableTopY),
      surfaceLift: toFixedNumber(lift),
      primaryMinY: toFixedNumber(primaryMinY),
      deltaY: toFixedNumber(tableTopY - primaryMinY),
      epsilon: toFixedNumber(Number.isFinite(data.tabletopAnchorEpsilon) ? data.tabletopAnchorEpsilon : DEFAULTS.tabletopAnchorEpsilon),
      deadbandY: toFixedNumber(Number.isFinite(data.tabletopAnchorDeadbandY) ? data.tabletopAnchorDeadbandY : DEFAULTS.tabletopAnchorDeadbandY),
      surfaceOffsetY: toFixedNumber(Number.isFinite(data.tableTopSurfaceOffsetY) ? data.tableTopSurfaceOffsetY : DEFAULTS.tableTopSurfaceOffsetY)
    };
  }
