// == codexrCollaborationRuntime.js | entitySync (assembled per manifest.json; see COMPONENTS.md) ==
    function handleServerMessage(message) {
      if (!message || typeof message !== 'object' || !message.type) {
        return;
      }
      if (typeof message.revision === 'number') {
        shared.revision = Math.max(shared.revision, message.revision);
      }

      switch (message.type) {
        case 'room-joined':
          win.console?.log?.('[Code-XR Fix][Collab] room joined:', message.roomId, 'as', message.peerId);
          shared.peerId = String(message.peerId || '').trim();
          shared.roomId = String(message.roomId || shared.roomId).trim();
          shared.joinedRoom = true;
          resetSelfView(message.payload?.localView === true);
          if (message.payload?.participant) {
            upsertParticipant(message.payload.participant);
          }
          setConnectionStatus('connected');
          ensurePresenceLoop();
          return;
        case 'room-snapshot':
          shared.snapshotReady = true;
          handleSnapshotEntities(message.payload?.entities || []);
          replaceParticipants(message.payload?.participants || []);
          shared.presenterPeerId = message.payload?.presenterPeerId || null;
          handleSnapshotPresence(message.payload?.presence || []);
          emitStateChanged();
          return;
        case 'participant-updated':
        case 'role-updated':
          upsertParticipant(message.payload);
          return;
        case 'participant-kick':
          shared.kicked = true;
          shared.socket?.close();
          setError({ code: 'removed', message: 'The room host removed this connection.' });
          showDisconnectScreen('removed');
          return;
        case 'session-ended':
          shared.sessionEnded = true;
          shared.socket?.close();
          setConnectionStatus('ended');
          showDisconnectScreen('host-closed');
          return;
        case 'presenter-started':
          upsertParticipant(message.payload);
          shared.presenterPeerId = message.payload?.peerId || null;
          emitStateChanged();
          return;
        case 'presenter-stopped':
          upsertParticipant(message.payload);
          if (shared.presenterPeerId === message.payload?.peerId) {
            shared.presenterPeerId = null;
          }
          emitStateChanged();
          return;
        case 'error':
          setError(message.payload || { code: 'server-error', message: 'Collaboration operation failed.' });
          return;
        case 'entity-added':
        case 'entity-updated':
        case 'entity-transform':
        case 'entity-lock':
        case 'entity-unlock':
          handleEntityMessage(message);
          return;
        case 'entity-removed':
          handleEntityRemoved(message);
          return;
        case 'entity-lock-denied':
          handleEntityLockDenied(message);
          return;
        case 'self-view':
          applySelfView(message.payload);
          return;
        case 'presence-joined':
        case 'presence-updated':
          if (message.payload?.peerId && message.payload.peerId !== shared.peerId) {
            applyPresenceState(message.payload);
          }
          return;
        case 'presence-left':
          removeParticipant(message.payload?.peerId);
          removeRemotePresence(message.payload?.peerId);
          return;
        default:
          emitMessage(message.type, message);
          return;
      }
    }

    function emitMessage(type, message) {
      const listeners = shared.messageListeners.get(String(type || ''));
      if (!listeners) {
        return;
      }
      listeners.forEach(function (listener) {
        try {
          listener(message);
        } catch (error) {
          console.error('[CodeXR][Collaboration] Message listener failed:', error);
        }
      });
    }

    function replaceParticipants(participants) {
      shared.participants.clear();
      (Array.isArray(participants) ? participants : []).forEach(upsertParticipant);
    }

    function upsertParticipant(participant) {
      if (!participant?.peerId) {
        return;
      }
      shared.participants.set(participant.peerId, { ...participant });
      if (participant.peerId === shared.peerId) {
        shared.profile.avatarId = participant.avatarId || shared.profile.avatarId;
        if (participant.identityMode === 'custom') {
          shared.profile.identityMode = 'custom';
          shared.profile.customName = participant.displayName || shared.profile.customName;
        } else {
          shared.profile.identityMode = 'anonymous';
        }
      }
      const remotePresence = shared.remotePresence.get(participant.peerId);
      if (remotePresence) {
        applyPresenceState({ ...remotePresence, ...participant });
      }
      emitStateChanged();
    }

    function removeParticipant(peerId) {
      if (!peerId) {
        return;
      }
      shared.participants.delete(peerId);
      shared.remotePresence.delete(peerId);
      if (shared.presenterPeerId === peerId) {
        shared.presenterPeerId = null;
      }
      emitStateChanged();
    }

    function handleSnapshotEntities(entities) {
      // A reconnect snapshot is the whole room: whatever this client knew
      // from the room that is not in it was removed while it was offline,
      // and used to linger here forever (COLLAB-ROOM-11, COLLAB-SYNC-9).
      const incoming = new Set((Array.isArray(entities) ? entities : []).map(function (entity) {
        return entity?.entityKind && entity?.entityId ? getEntityKey(entity.entityKind, entity.entityId) : '';
      }));
      Array.from(shared.roomEntities.values()).forEach(function (known) {
        if (known?.entityKind && known?.entityId && !incoming.has(getEntityKey(known.entityKind, known.entityId))) {
          handleEntityRemoved({
            type: 'entity-removed',
            roomId: shared.roomId,
            payload: { entityKind: known.entityKind, entityId: known.entityId },
          });
        }
      });
      shared.roomEntities.clear();
      // The analysis view goes last, so a mode activates with its data
      // entities (dependency graph, comparison, evolution) already applied.
      const ordered = (Array.isArray(entities) ? entities : []).slice().sort(function (left, right) {
        return Number(left?.entityKind === 'analysis-view') - Number(right?.entityKind === 'analysis-view');
      });
      ordered.forEach(function (entity) {
        if (!entity?.entityKind || !entity?.entityId) {
          return;
        }
        shared.roomEntities.set(getEntityKey(entity.entityKind, entity.entityId), entity);
        applyEntityStateToRuntime(entity, { source: 'snapshot', type: 'room-snapshot' });
      });
      shared.manager?.applyCollaborationSnapshot?.(entities);
      publishMissingInitialStates();
    }

    function handleSnapshotPresence(presenceStates) {
      clearRemotePresence();
      (Array.isArray(presenceStates) ? presenceStates : []).forEach(function (presenceState) {
        if (presenceState?.peerId && presenceState.peerId !== shared.peerId) {
          applyPresenceState(presenceState);
        }
      });
    }

    function handleEntityMessage(message) {
      const entity = message.payload;
      if (!entity?.entityKind || !entity?.entityId) {
        return;
      }
      shared.roomEntities.set(getEntityKey(entity.entityKind, entity.entityId), entity);
      applyEntityStateToRuntime(entity, {
        source: 'room',
        type: message.type,
        peerId: message.peerId || '',
      });
    }

    function handleEntityRemoved(message) {
      const entityKind = String(message.payload?.entityKind || '').trim();
      const entityId = String(message.payload?.entityId || '').trim();
      if (!entityKind || !entityId) {
        return;
      }
      const key = getEntityKey(entityKind, entityId);
      shared.roomEntities.delete(key);
      shared.entityRuntimes.get(key)?.handleCollaborationMessage?.(message);
      if (entityKind === 'screen') {
        shared.manager?.removeRemoteScreen?.(entityId);
      }
    }

    function handleEntityLockDenied(message) {
      const key = getEntityKey(message.payload?.entityKind, message.payload?.entityId);
      shared.entityRuntimes.get(key)?.handleCollaborationMessage?.({
        ...message,
        type: 'entity-lock-denied',
      });
    }

    function applyEntityStateToRuntime(entity, meta) {
      const key = getEntityKey(entity.entityKind, entity.entityId);
      const runtime = shared.entityRuntimes.get(key);
      if (runtime?.applySharedState) {
        // One runtime that throws must not stop the rest of a room snapshot
        // (the analysis view behind it, the participants, the presence), and
        // the failure must reach the console (LIFECYCLE-9).
        try {
          const applied = runtime.applySharedState(entity, meta || { source: 'room' });
          if (applied && typeof applied.catch === 'function') {
            applied.catch(function (error) {
              win.console?.error?.('[CodeXR][Collab] Runtime "' + key + '" failed to apply the shared state:', error);
            });
          }
        } catch (error) {
          win.console?.error?.('[CodeXR][Collab] Runtime "' + key + '" failed to apply the shared state:', error);
        }
        return;
      }
      shared.pendingEntities.set(key, entity);
      if (entity.entityKind === 'screen') {
        shared.manager?.ensureRemoteScreen?.(entity);
      }
    }

    function publishMissingInitialStates() {
      shared.entityRuntimes.forEach(function (runtime, key) {
        if (!shared.roomEntities.has(key)) {
          runtime.publishInitialSharedState?.();
        }
      });
    }
