// == virtualScreenRuntime.js | signalingAndRemote (assembled per manifest.json; see COMPONENTS.md) ==
    function handleSignalMessage(message) {
      switch (message?.type) {
        case 'registered':
          refs.broadcastRegistered = true;
          state.clientId = message.clientId || state.clientId;
          if (state.streamSourceType === 'local') {
            announceBroadcastStart();
          } else if (
            (state.streamSourceType === 'remote' || state.broadcastRole === 'viewer')
            && refs.broadcastState.active
            && !state.viewerOptOut
          ) {
            // A fresh registration means the server forgot this viewer (the
            // socket reconnected): join again, even while the old receiver
            // still shows the last frame (COLLAB-SCREEN-7).
            refs.joinAttemptSocket = null;
            void startViewerConnection(refs.broadcastState.broadcasterPeerId || '', { force: true });
          } else if (refs.broadcastState.active) {
            ensureRemoteBroadcastSubscription(refs.broadcastState);
          }
          return;
        case 'broadcast-live':
          setBroadcastState('sender', 'live');
          setSharedBroadcastState({
            active: true,
            broadcasterPeerId: getCollaborationClient()?.getPeerId?.() || getOwnerPeerId(),
            hasAudio: state.hasAudio,
            sourceKind: state.lastIntent || 'screen',
          });
          updateStatus(refs.config.labels.broadcasting);
          publishSharedScreenState();
          return;
        case 'broadcast-available':
          if (state.streamSourceType === 'local') {
            return;
          }
          setSharedBroadcastState({
            active: true,
            broadcasterPeerId: refs.broadcastState?.broadcasterPeerId || '',
            hasAudio: message.hasAudio === true,
            sourceKind: refs.broadcastState?.sourceKind || 'screen',
          });
          if (!state.viewerOptOut) {
            void startViewerConnection(message.broadcasterId || '');
          }
          return;
        case 'broadcast-stopped':
          // Ownership invariant: the room's screen entity belongs to the
          // sender. A viewer updates only itself — publishing active:false
          // from here once poisoned the whole room out of a live broadcast.
          if (state.streamSourceType !== 'local') {
            // Every viewer state, "connecting" included: a viewer still
            // waiting kept its stale receiver and, deduped, never re-joined
            // the next broadcast (COLLAB-SCREEN-10).
            detachRemoteBroadcast(refs.config.labels.broadcastStopped, {
              notifyServer: false,
              skipSharedPublish: true,
            });
            setSharedBroadcastState({
              active: false,
              broadcasterPeerId: '',
              hasAudio: false,
              sourceKind: refs.broadcastState?.sourceKind || '',
            });
          } else if (state.streamSourceType === 'local') {
            setBroadcastState('sender', 'idle');
            setSharedBroadcastState({
              active: false,
              broadcasterPeerId: '',
              hasAudio: false,
              sourceKind: refs.broadcastState?.sourceKind || '',
            });
            publishSharedScreenState();
          }
          return;
        case 'viewer-waiting':
          // Parked by the server until the broadcast starts: still connecting.
          if (state.streamSourceType !== 'local') {
            updateStatus(refs.config.labels.connecting);
          }
          return;
        case 'broadcast-denied':
          // Server-side guarantee of one broadcaster per screen: roll the
          // refused share back and return to being a viewer. The room entity
          // is not touched — it belongs to the broadcaster that holds the
          // screen.
          if (state.streamSourceType === 'local') {
            releaseStream(true);
            state.hasAudio = false;
            state.currentSourceLabel = '';
            setBroadcastState('none', 'idle');
            setMode('idle', `${getBroadcasterDisplayName()} ${refs.config.labels.screenBusy}`);
            if (refs.broadcastState?.active && !state.viewerOptOut) {
              void startViewerConnection(refs.broadcastState.broadcasterPeerId || '');
            }
          }
          return;
        case 'viewer-join':
          void handleViewerJoin(message.viewerId || '');
          return;
        // Relay control: the server routes viewers it knows peer-to-peer
        // cannot reach (see relayTransport.js).
        case 'relay-start':
          startRelaySender(message);
          return;
        case 'relay-keyframe':
          requestRelayKeyframe();
          return;
        case 'relay-audience':
          updateRelayAudience(message);
          return;
        case 'relay-stop':
          stopRelaySender();
          return;
        case 'relay-ready':
          startRelayReceiver(message);
          return;
        case 'signal-offer':
          void applyRemoteOffer(message.clientId || '', message.description);
          return;
        case 'signal-answer':
          void applyRemoteAnswer(message.clientId || '', message.description);
          return;
        case 'signal-ice':
          void applyRemoteIce(message.clientId || '', message.candidate);
          return;
        default:
          return;
      }
    }

    // The broadcast server files a client under the room it names in
    // `register`, for good. Through the tunnel the room id (from the session
    // info) routinely arrives after this socket opens; registering without it
    // filed guests under the default room, where no broadcast ever exists, so
    // they never saw the host's screen. Wait for the room before registering.
    async function registerWhenRoomKnown(socket) {
      let roomId = getResolvedRoomId();
      if (!roomId) {
        try {
          const info = await getCollaborationClient()?.getSessionInfoAsync?.();
          roomId = getResolvedRoomId() || String(info?.roomId || '').trim();
        } catch (_error) {
          roomId = getResolvedRoomId();
        }
      }
      if (refs.signalingSocket !== socket || socket.readyState !== win.WebSocket.OPEN) {
        return;
      }
      sendSignaling({
        type: 'register',
        clientId: getOrCreateClientId(),
        ...(roomId ? { roomId } : {}),
      });
    }

    function connectSignaling() {
      if (refs.destroyed || !refs.config.broadcastEnabled || !canUseBroadcastTransport()) {
        return;
      }
      if (refs.signalingSocket && [win.WebSocket.OPEN, win.WebSocket.CONNECTING].includes(refs.signalingSocket.readyState)) {
        return;
      }

      const signalingUrl = buildSignalingUrl();
      if (!signalingUrl) {
        return;
      }

      const socket = new win.WebSocket(signalingUrl);
      // Relayed media arrives on this same socket as binary frames.
      socket.binaryType = 'arraybuffer';
      refs.signalingSocket = socket;
      refs.broadcastRegistered = false;

      socket.onopen = function () {
        refs.broadcastRegistered = false;
        setBroadcastState(state.broadcastRole, state.streamSourceType === 'local' ? 'connecting' : state.broadcastStatus);
        void registerWhenRoomKnown(socket);
      };

      socket.onmessage = function (event) {
        if (event.data instanceof win.ArrayBuffer) {
          handleRelayFrame(event.data);
          return;
        }
        try {
          handleSignalMessage(JSON.parse(event.data));
        } catch (_error) {
          updateStatus(refs.config.labels.broadcastError);
        }
      };

      socket.onerror = function () {
        if (state.streamSourceType === 'local') {
          setBroadcastState('none', 'error');
          updateStatus(refs.config.labels.broadcastError);
        }
      };

      socket.onclose = function () {
        refs.broadcastRegistered = false;
        refs.signalingSocket = null;
        if (refs.destroyed) {
          return;
        }
        if (state.streamSourceType === 'local') {
          setBroadcastState('sender', 'connecting');
        }
        scheduleSignalingReconnect();
      };
    }

    function detachRemoteBroadcast(message, options) {
      const broadcasterId = refs.activeBroadcasterId;
      if (options?.notifyServer !== false && broadcasterId) {
        sendSignaling({
          type: 'viewer-leave',
          clientId: getOrCreateClientId(),
        });
      }

      refs.activeBroadcasterId = '';
      refs.joinedBroadcastKey = '';
      refs.relayFallbackRequested = false;
      closeAllPeerConnections();
      stopRelayReceiver();
      refs.remoteStream = null;
      refs.joinAttemptSocket = null;
      if (refs.viewerJoinWatchdogTimer) {
        win.clearTimeout(refs.viewerJoinWatchdogTimer);
        refs.viewerJoinWatchdogTimer = null;
      }
      if (refs.remoteFrameWatchTimer) {
        win.clearTimeout(refs.remoteFrameWatchTimer);
        refs.remoteFrameWatchTimer = null;
      }

      if (state.streamSourceType === 'remote') {
        releaseStream(false);
      }

      state.hasAudio = false;
      state.currentSourceLabel = '';

      if (!options?.preserveStatus) {
        setBroadcastState('none', 'idle');
        setMode('idle', message || refs.config.labels.noSignal);
      }

      if (options?.clearSharedBroadcast === true) {
        setSharedBroadcastState({
          active: false,
          broadcasterPeerId: '',
          hasAudio: false,
          sourceKind: refs.broadcastState?.sourceKind || '',
        });
      }

      if (options?.skipSharedPublish !== true) {
        publishSharedScreenState();
      }
    }

    function stopCapture(message, options) {
      if (state.streamSourceType !== 'local') {
        // A viewer — watching or still connecting — leaves locally only: the
        // opt-out sticks until they press Join, and the room entity is never
        // touched (it belongs to the broadcaster).
        state.viewerOptOut = true;
        detachRemoteBroadcast(message || refs.config.labels.broadcastStopped, {
          notifyServer: true,
          skipSharedPublish: true,
        });
        if (options?.minimizeAfterStop === true) {
          state.presentationMode = 'minimized';
          layout();
          refreshUi();
        }
        return;
      }

      sendSignaling({
        type: 'broadcast-stop',
        clientId: getOrCreateClientId(),
        reason: message || refs.config.labels.broadcastStopped,
      });
      closeAllPeerConnections();
      stopRelaySender();
      const shouldMinimize = options?.minimizeAfterStop === true;
      releaseStream(true);
      state.hasAudio = false;
      state.currentSourceLabel = '';
      refs.activeBroadcasterId = '';
      setBroadcastState('none', 'idle');
      setSharedBroadcastState({
        active: false,
        broadcasterPeerId: '',
        hasAudio: false,
        sourceKind: refs.broadcastState?.sourceKind || '',
      });
      state.presentationMode = shouldMinimize ? 'minimized' : 'expanded';
      if (shouldMinimize) {
        setMode('idle', message || refs.config.labels.minimized);
      } else {
        setMode('idle', message || refs.config.labels.idle);
      }
      publishSharedScreenState();
    }

    function attachTrackEndedListener(stream) {
      const tracks = typeof stream?.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
      const track = tracks[0];
      if (!track) {
        return;
      }
      track.addEventListener('ended', function () {
        stopCapture(refs.config.labels.sourceEnded, { minimizeAfterStop: false });
      }, { once: true });
    }

    async function startCapture(intent) {
      if (!refs.config.virtualScreenSupportsLocalCapture) {
        setMode('idle', 'Local screen capture is disabled for this scene.');
        return;
      }
      // One screen, one broadcaster. While somebody else's broadcast is live
      // here, sharing is refused up front — the old behavior detached the
      // viewer from the stream they were watching before even opening the
      // picker, so a stray click cost them the content.
      if (isForeignBroadcastActive()) {
        showChrome();
        updateStatus(`${getBroadcasterDisplayName()} ${refs.config.labels.screenBusy}`);
        return;
      }
      const previousStream = state.stream;
      const previousLabel = state.currentSourceLabel;
      state.lastIntent = intent;
      showChrome();
      setMode('idle', SOURCE_MESSAGES[intent].pending);

      try {
        const stream = await requestCapture(intent);
        // The relay encoder reads the previous tracks: switching source left
        // it pumping an ended track and relay viewers frozen on the last
        // frame (COLLAB-SCREEN-3). Restart it on the new stream below.
        const relayAudience = refs.relaySender ? refs.relaySender.audience : 0;
        if (relayAudience) {
          stopRelaySender();
        }
        if (previousStream && previousStream !== stream) {
          releaseStream(true);
        }
        state.stream = stream;
        state.streamSourceType = 'local';
        state.hasAudio = typeof stream.getAudioTracks === 'function' && stream.getAudioTracks().length > 0;
        updateVideoSource(stream);
        attachTrackEndedListener(stream);
        state.currentSourceLabel = SOURCE_MESSAGES[intent].active;
        state.presentationMode = 'expanded';
        setMode('broadcasting', SOURCE_MESSAGES[intent].active);
        setSharedBroadcastState({
          active: true,
          broadcasterPeerId: getCollaborationClient()?.getPeerId?.() || getOwnerPeerId(),
          hasAudio: state.hasAudio,
          sourceKind: intent || 'screen',
        });
        if (canUseBroadcastTransport()) {
          setBroadcastState('sender', 'connecting');
          connectSignaling();
          announceBroadcastStart();
          if (relayAudience) {
            startRelaySender({ relayViewerCount: relayAudience });
          }
        } else if (refs.config.broadcastEnabled) {
          setBroadcastState('none', 'error');
          updateStatus(refs.config.labels.broadcastUnavailable);
        } else {
          setBroadcastState('none', 'idle');
        }
        publishSharedScreenState();
      } catch (error) {
        if (previousStream) {
          state.stream = previousStream;
          state.currentSourceLabel = previousLabel;
          setMode('broadcasting', previousLabel || refs.config.labels.idle);
          publishSharedScreenState();
          return;
        }
        state.currentSourceLabel = '';
        state.hasAudio = false;
        setSharedBroadcastState({
          active: false,
          broadcasterPeerId: '',
          hasAudio: false,
          sourceKind: intent || refs.broadcastState?.sourceKind || 'screen',
        });
        setMode('idle', classifyCaptureError(error));
        publishSharedScreenState();
      }
    }

    function switchSource() {
      void startCapture('screen');
    }

    /** Explicitly (re)join this screen's live broadcast as a viewer. */
    function joinBroadcast() {
      state.viewerOptOut = false;
      void startViewerConnection(refs.broadcastState?.broadcasterPeerId || '');
    }