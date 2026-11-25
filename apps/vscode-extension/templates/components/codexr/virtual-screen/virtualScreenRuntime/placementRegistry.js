// == virtualScreenRuntime.js | placementRegistry (assembled per manifest.json; see COMPONENTS.md) ==
    // The shared placement registry (PANELS-3/5/9): besides other screens,
    // a screen keeps clear of every shown entity tagged
    // data-codexr-panel-obstacle (mode overlays, boards) and of the analysis
    // table plus the volume its charts stand in. A panel registers by
    // carrying the attribute and releases by being hidden or removed, so a
    // mode's panels leave the registry with the mode.
    const TABLE_GEOMETRY_SELECTOR = '#codexr-analysis-table-geometry';
    const DEFAULT_TABLE_CHART_HEADROOM = 2.2;

    function isShown(object3D) {
      for (let node = object3D; node; node = node.parent) {
        if (node.visible === false) {
          return false;
        }
      }
      return true;
    }

    function worldBoxObstacle(object3D, extraHeight) {
      object3D.updateMatrixWorld?.(true);
      const box = new global.THREE.Box3().setFromObject(object3D);
      if (box.isEmpty?.()) {
        return null;
      }
      box.max.y += Number(extraHeight) || 0;
      const center = new global.THREE.Vector3();
      const size = new global.THREE.Vector3();
      box.getCenter(center);
      box.getSize(size);
      return orientedBox(center, new global.THREE.Quaternion(), size.x / 2, size.y / 2, size.z / 2);
    }

    // Obstacles and the moving screen are oriented boxes compared with the
    // separating-axis test: sampling a few points of the screen missed two
    // screens crossing at an angle (look-at turns them), which then
    // interpenetrated (PANELS-3).
    function orientedBox(center, quaternion, halfX, halfY, halfZ) {
      return {
        center,
        axes: [
          new global.THREE.Vector3(1, 0, 0).applyQuaternion(quaternion),
          new global.THREE.Vector3(0, 1, 0).applyQuaternion(quaternion),
          new global.THREE.Vector3(0, 0, 1).applyQuaternion(quaternion),
        ],
        half: [halfX, halfY, halfZ],
      };
    }

    function projectedRadius(box, axis) {
      return (box.half[0] * Math.abs(box.axes[0].dot(axis)))
        + (box.half[1] * Math.abs(box.axes[1].dot(axis)))
        + (box.half[2] * Math.abs(box.axes[2].dot(axis)));
    }

    function orientedBoxesOverlap(a, b) {
      const between = b.center.clone().sub(a.center);
      const candidates = [...a.axes, ...b.axes];
      for (const axisA of a.axes) {
        for (const axisB of b.axes) {
          const cross = new global.THREE.Vector3().crossVectors(axisA, axisB);
          if (cross.lengthSq() > 1e-8) {
            candidates.push(cross.normalize());
          }
        }
      }
      for (const axis of candidates) {
        if (Math.abs(between.dot(axis)) > projectedRadius(a, axis) + projectedRadius(b, axis)) {
          return false;
        }
      }
      return true;
    }

    function collectPanelObstacles(obstacles) {
      if (!global.THREE?.Box3) {
        return;
      }
      const document = getDocument();
      document?.querySelectorAll?.('[data-codexr-panel-obstacle]').forEach((el) => {
        if (!el.object3D || refs.root?.contains?.(el) || !isShown(el.object3D)) {
          return;
        }
        const obstacle = worldBoxObstacle(el.object3D, 0);
        if (obstacle) {
          obstacles.push(obstacle);
        }
      });
      const table = document?.querySelector?.(TABLE_GEOMETRY_SELECTOR);
      if (table?.object3D && isShown(table.object3D)) {
        const headroom = Number(refs.config.tableChartHeadroom) >= 0
          ? Number(refs.config.tableChartHeadroom)
          : DEFAULT_TABLE_CHART_HEADROOM;
        const obstacle = worldBoxObstacle(table.object3D, headroom);
        if (obstacle) {
          obstacles.push(obstacle);
        }
      }
    }

    // A placement (add, Bring, recenter) lands on the nearest free spot
    // beside its target instead of on top of whatever is there: one screen
    // width (or height) plus a gap at a time, right, left, up, then further
    // out. Nothing free keeps the target, so a crowded room still places.
    const PLACEMENT_GAP = 0.25;
    const PLACEMENT_RINGS = 3;

    function findFreePlacement(targetWorldPosition, worldQuaternion) {
      if (!global.THREE || !targetWorldPosition?.clone || !worldQuaternion?.clone) {
        return targetWorldPosition;
      }
      refs.obstacleCache = null;
      if (!violatesCollision(collectScreenSamplePoints(targetWorldPosition, worldQuaternion))) {
        return targetWorldPosition;
      }
      const stepX = state.screenWidth + PLACEMENT_GAP;
      const stepY = (state.screenWidth / refs.config.aspectRatio) + PLACEMENT_GAP;
      const right = new global.THREE.Vector3(1, 0, 0).applyQuaternion(worldQuaternion);
      const up = new global.THREE.Vector3(0, 1, 0);
      for (let ring = 1; ring <= PLACEMENT_RINGS; ring += 1) {
        const offsets = [[ring, 0], [-ring, 0], [0, ring], [ring, ring], [-ring, ring], [0, -ring]];
        for (const [dx, dy] of offsets) {
          const candidate = targetWorldPosition.clone()
            .addScaledVector(right, dx * stepX)
            .addScaledVector(up, dy * stepY);
          if (!violatesCollision(collectScreenSamplePoints(candidate, worldQuaternion))) {
            return candidate;
          }
        }
      }
      return targetWorldPosition;
    }

    // A screen that already sits inside an obstacle (a scene anchored it
    // there, a panel appeared over it) must still move and turn freely, or
    // the bumpers would freeze it in place.
    function isCurrentPoseBlocked() {
      const position = getWorldPosition(refs.root);
      const orientation = getWorldQuaternion(refs.root);
      if (!position?.clone || !orientation?.clone) {
        return false;
      }
      return violatesCollision(collectScreenSamplePoints(position, orientation));
    }
