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
          obstacle.occluder = true;
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
    // out. Every spot tried is first clamped into the room shell, so a Bring
    // next to a wall can never put the screen through it; when nothing is
    // free the clamped target is kept, so a crowded room still places
    // (PANELS-3).
    const PLACEMENT_GAP = 0.25;
    const PLACEMENT_RINGS = 3;
    // Silhouettes closer than this (tangent units, ~1 degree) count as touching.
    const OCCLUSION_MARGIN = 0.02;
    const SILHOUETTE_NEAR = 0.05;

    function orientedBoxCorners(box) {
      const corners = [];
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            corners.push(box.center.clone()
              .addScaledVector(box.axes[0], sx * box.half[0])
              .addScaledVector(box.axes[1], sy * box.half[1])
              .addScaledVector(box.axes[2], sz * box.half[2]));
          }
        }
      }
      return corners;
    }

    // Angular extent of the points seen from the viewer; null when none is
    // in front of the viewer. A point beside or behind the viewer (a big
    // screen turned to face the user reaches past them) is pulled onto a
    // near plane, which widens the extent toward that side: conservative.
    function silhouetteFrom(points, viewer, frame) {
      const out = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      let inFront = false;
      for (const point of points) {
        const v = point.clone().sub(viewer);
        let depth = v.dot(frame.forward);
        if (depth > SILHOUETTE_NEAR) {
          inFront = true;
        } else {
          depth = SILHOUETTE_NEAR;
        }
        const sx = v.dot(frame.right) / depth;
        const sy = v.dot(frame.up) / depth;
        out.minX = Math.min(out.minX, sx);
        out.maxX = Math.max(out.maxX, sx);
        out.minY = Math.min(out.minY, sy);
        out.maxY = Math.max(out.maxY, sy);
      }
      return inFront ? out : null;
    }

    // Two screens facing the user 0.2 m apart in depth never intersect, yet
    // the front one hides the other completely (Bring default, then Bring
    // guide). So a placement is also blocked when its silhouette, seen from
    // the viewer, overlaps another screen's or a registered panel's; the
    // table and its charts are not occluders (screens float above them).
    function hidesAnotherPanel(box, viewer) {
      const forward = box.center.clone().sub(viewer);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) {
        return false;
      }
      forward.normalize();
      const up = new global.THREE.Vector3(0, 1, 0);
      const frame = { forward, up, right: new global.THREE.Vector3().crossVectors(forward, up).normalize() };
      const own = silhouetteFrom(orientedBoxCorners(box), viewer, frame);
      if (!own) {
        return false;
      }
      for (const obstacle of getScreenObstacles()) {
        if (!obstacle.occluder) {
          continue;
        }
        const other = silhouetteFrom(orientedBoxCorners(obstacle), viewer, frame);
        if (other
          && own.minX < other.maxX + OCCLUSION_MARGIN && other.minX < own.maxX + OCCLUSION_MARGIN
          && own.minY < other.maxY + OCCLUSION_MARGIN && other.minY < own.maxY + OCCLUSION_MARGIN) {
          return true;
        }
      }
      return false;
    }

    // Shift a pose so every corner of the screen is inside the room shell.
    function clampIntoRoom(position, orientation) {
      const bounds = getCollisionBounds();
      if (!bounds) {
        return position;
      }
      const clamped = position.clone();
      const points = collectScreenSamplePoints(position, orientation);
      for (const axis of ['x', 'y', 'z']) {
        const key = axis.toUpperCase();
        let lowest = Infinity;
        let highest = -Infinity;
        for (const point of points) {
          lowest = Math.min(lowest, point[axis]);
          highest = Math.max(highest, point[axis]);
        }
        const below = bounds[`min${key}`] - lowest;
        const above = bounds[`max${key}`] - highest;
        if (below > 0 && above < 0) {
          clamped[axis] += (below + above) / 2;
        } else if (below > 0) {
          clamped[axis] += below;
        } else if (above < 0) {
          clamped[axis] += above;
        }
      }
      return clamped;
    }

    function findFreePlacement(targetWorldPosition, worldQuaternion, viewerWorldPosition) {
      if (!global.THREE || !targetWorldPosition?.clone || !worldQuaternion?.clone) {
        return targetWorldPosition;
      }
      refs.obstacleCache = null;
      const viewer = viewerWorldPosition?.clone ? viewerWorldPosition : null;
      // The pose applyFollowTransform will give the spot: facing the viewer.
      const poseAt = (position) => (viewer && computeFaceUserQuaternion(position, viewer)) || worldQuaternion;
      // Clamping turns the screen a little (it faces the viewer from the new
      // spot), so it runs twice to settle.
      const inRoom = (position) => {
        const once = clampIntoRoom(position, poseAt(position));
        return clampIntoRoom(once, poseAt(once));
      };
      const isFree = (position) => {
        const points = collectScreenSamplePoints(position, poseAt(position));
        return !violatesCollision(points) && !(viewer && hidesAnotherPanel(points.box, viewer));
      };
      const start = inRoom(targetWorldPosition);
      if (isFree(start)) {
        return start;
      }
      const stepX = state.screenWidth + PLACEMENT_GAP;
      const stepY = (state.screenWidth / refs.config.aspectRatio) + PLACEMENT_GAP;
      const right = new global.THREE.Vector3(1, 0, 0).applyQuaternion(worldQuaternion);
      const up = new global.THREE.Vector3(0, 1, 0);
      for (let ring = 1; ring <= PLACEMENT_RINGS; ring += 1) {
        const offsets = [[ring, 0], [-ring, 0], [0, ring], [ring, ring], [-ring, ring], [0, -ring]];
        for (const [dx, dy] of offsets) {
          const candidate = inRoom(start.clone()
            .addScaledVector(right, dx * stepX)
            .addScaledVector(up, dy * stepY));
          if (isFree(candidate)) {
            return candidate;
          }
        }
      }
      return start;
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
