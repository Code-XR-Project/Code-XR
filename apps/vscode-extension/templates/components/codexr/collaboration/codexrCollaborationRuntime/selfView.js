// == codexrCollaborationRuntime.js | selfView (assembled per manifest.json; see COMPONENTS.md) ==
    // One person, many views (#352). Every view opened on the machine that
    // runs Code-XR (the IDE's scene pane, a localhost browser tab) is the same
    // participant, and they share one camera: the view the person moves in
    // sends `self-view`, the server relays it to the person's other local
    // views (and keeps it for one opened later), and those views jump there.
    // A view never re-sends a camera it was given, so two views cannot
    // ping-pong, and a view in a headset neither follows nor leads.
    const SELF_VIEW_INTERVAL_MS = 50;
    const SELF_VIEW_PRECISION = 1000;

    function roundSelfView(value) {
      return Math.round(Number(value || 0) * SELF_VIEW_PRECISION) / SELF_VIEW_PRECISION;
    }

    function getLookControls() {
      return getHeadEntity()?.components?.['look-controls'] || null;
    }

    function isImmersiveView() {
      const scene = getScene();
      return scene?.is?.('vr-mode') === true || scene?.is?.('ar-mode') === true;
    }

    function readSelfView() {
      const rig = getBodyEntity();
      const look = getLookControls();
      if (!rig?.object3D || rig === getHeadEntity() || !look?.pitchObject || !look?.yawObject) {
        return null;
      }
      const position = rig.object3D.position;
      const quaternion = rig.object3D.quaternion;
      return {
        rig: {
          position: { x: roundSelfView(position.x), y: roundSelfView(position.y), z: roundSelfView(position.z) },
          quaternion: {
            x: roundSelfView(quaternion.x),
            y: roundSelfView(quaternion.y),
            z: roundSelfView(quaternion.z),
            w: roundSelfView(quaternion.w),
          },
        },
        look: { pitch: roundSelfView(look.pitchObject.rotation.x), yaw: roundSelfView(look.yawObject.rotation.y) },
      };
    }

    function isFiniteNumbers(values) {
      return values.every(function (value) { return typeof value === 'number' && Number.isFinite(value); });
    }

    function isValidSelfView(view) {
      const position = view?.rig?.position;
      const quaternion = view?.rig?.quaternion;
      const look = view?.look;
      return !!(position && quaternion && look) && isFiniteNumbers([
        position.x, position.y, position.z,
        quaternion.x, quaternion.y, quaternion.z, quaternion.w,
        look.pitch, look.yaw,
      ]);
    }

    function applySelfView(view) {
      if (!isValidSelfView(view) || isImmersiveView()) {
        return;
      }
      const rig = getBodyEntity();
      const look = getLookControls();
      if (!rig?.object3D || rig === getHeadEntity() || !look?.pitchObject || !look?.yawObject) {
        // The scene is still loading: apply it as soon as there is a camera.
        shared.pendingSelfView = view;
        return;
      }
      shared.pendingSelfView = null;
      rig.object3D.position.set(view.rig.position.x, view.rig.position.y, view.rig.position.z);
      rig.object3D.quaternion.set(view.rig.quaternion.x, view.rig.quaternion.y, view.rig.quaternion.z, view.rig.quaternion.w);
      look.pitchObject.rotation.x = view.look.pitch;
      look.yawObject.rotation.y = view.look.yaw;
      // What this view now shows was given to it: it is not a move to send back.
      shared.selfViewSignature = JSON.stringify(readSelfView());
      shared.selfViewBaselinePending = false;
    }

    /** Called from the presence loop: sends the camera when the person moved it here. */
    function syncSelfView() {
      if (!shared.joinedRoom || !shared.localView || isImmersiveView()) {
        return;
      }
      if (shared.pendingSelfView) {
        applySelfView(shared.pendingSelfView);
        return;
      }
      const now = Date.now();
      if (now - shared.lastSelfViewSentAt < SELF_VIEW_INTERVAL_MS) {
        return;
      }
      const view = readSelfView();
      if (!view) {
        return;
      }
      const signature = JSON.stringify(view);
      if (shared.selfViewBaselinePending) {
        // Where a view starts is not a move: only what the person does after counts.
        shared.selfViewBaselinePending = false;
        shared.selfViewSignature = signature;
        return;
      }
      if (signature === shared.selfViewSignature) {
        return;
      }
      shared.selfViewSignature = signature;
      shared.lastSelfViewSentAt = now;
      send({ type: 'self-view', roomId: shared.roomId, payload: view });
    }

    function resetSelfView(localView) {
      shared.localView = localView === true;
      shared.selfViewBaselinePending = true;
      shared.selfViewSignature = '';
      shared.pendingSelfView = null;
    }

