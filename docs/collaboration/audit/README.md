# Multi-user collaboration audit (local, LAN and tunnel)

Date: 2026-11-28. Base: `v1.3.0` at `cdb07d05` (plugin) and `ide` at `eb9f4243` (IDE). Epic: see the tracking issue linked from the kanban (`stream: collab-sync`).

The question: with two or more people in one XR scene, does everything stay in sync, on the same machine, on the LAN and through the Cloudflare tunnel? That covers the virtual screen (picture and audio), avatars and poses, interactions with panels and charts, the analysis modes (Agent Flow, drill-down, dependency graph, historical comparison, project evolution), live reloads after a re-analysis, and the host role.

It takes into account the recent changes: the live channel moved from SSE to WebSocket (`/codexr-live`, PRs #350/#351), the same-device identity merge (story #352, PRs #353/#354), drill-down (#348/#349) and Agent Flow (#329-#332).

## How it was checked

1. **Code reading**, in four parallel passes: screen sharing and audio; room, presence and host role; interaction sync per component; IDE parity.
2. **Real multi-client runs.** A real directory XR analysis served by the core (no VS Code, a stub host, the same `AnalysisOrchestrator` the IDE uses), with several Chromium instances joining it:
   - the **host** on `https://localhost:3000`;
   - a **LAN guest** on the machine's network address;
   - **tunnel guests** through a local reverse proxy that behaves like a Cloudflare quick tunnel. It terminates TLS for a `*.trycloudflare.com` host name, reaches the origin from `127.0.0.1` the way `cloudflared` does, adds `cf-connecting-ip` / `x-forwarded-for`, can add latency (80 ms one way was used) and closes WebSockets idle for 100 s like Cloudflare. Guests go through the real pairing page (`/join`, identity, six-digit code, cookie).
   - The real `trycloudflare.com` service could not be reached from the audit machine (its API is blocked there), so the proxy stands in for it. What the proxy cannot reproduce (two different NATs, a real headset) is in the manual guide.
   - The host shares a synthetic screen (an animated canvas plus a tone, through a `getDisplayMedia` stub) and every client counts the encoders, decoders and decoded frames, plus every message on `/codexr-broadcast`.

The scripts are in `apps/vscode-extension/test/manual/collaboration-e2e/` (see its README).

## Results in one table

| Area | Local (same machine) | LAN | Tunnel |
|---|---|---|---|
| Join, presence, avatars, late-joiner snapshot | works | works | works |
| Screen picture | works | **fails**: direct WebRTC fails and never falls back (COLLAB-SCREEN-6) | **fails for most guests**: they register in the wrong room (COLLAB-SCREEN-0) |
| Screen audio | works | as picture | **only the first relay viewer hears it** (COLLAB-SCREEN-1) |
| Live reload after a re-analysis | works | works | works |
| Survives idle sockets and reconnects | no heartbeat: ghosts and duplicates (COLLAB-ROOM-1) | same | Cloudflare drops idle sockets after 100 s; identity and host role are lost (COLLAB-ROOM-2) |
| Shared interactions | mostly; see the SYNC table | same | same |

## Findings confirmed at runtime

| ID | Severity | Finding |
|---|---|---|
| COLLAB-SCREEN-0 | blocker | **Tunnel guests do not see the shared screen.** The virtual screen registers on `/codexr-broadcast` as soon as the socket opens, with the room id read from the collaboration client. Through the tunnel the session info (which carries the room id) arrives later, so the guest registers with an empty room id, the server files it under `codexr-session:default`, and it waits forever for a broadcast that exists in another room. Reproduced on 2 of 2 tunnel guests in the same run; local and LAN guests resolve the room first. (`signalingAndRemote.js` `register`, `screenBroadcastSignalingServer.ts` `registerClient`.) |
| COLLAB-SCREEN-1 | blocker | **Only the first relay viewer hears the audio.** `audioConfig` is sent once, when the encoder starts. A second tunnel guest received 4 audio packets and no config, so it never built a decoder: silent video. A reconnecting viewer goes silent the same way. |
| COLLAB-SCREEN-6 | major | **A LAN viewer whose direct WebRTC connection fails stays on "Connecting" forever.** The offer/answer went through, ICE failed, and the ICE handler detached the viewer and cleared the timer that would have asked for the relay. Reproduced in every run. |
| COLLAB-SCREEN-8 | blocker | **A share stays "active" after the sharer's tab closes.** The screen entity outlives the broadcaster. Every later client, the next host included, waits on "Connecting live share..." and the host cannot start a new share on that screen until the server restarts. Reproduced across runs on one server. |
| COLLAB-ROOM-12 | major | **Every page opens about 15 room sockets.** `ensureSocket` checks for a socket, then awaits the session info; every runtime that calls it during start-up passes the check, so each creates its own socket. All of them stay open, only the last one is used, and `room-join` is sent 15 times over it. Through the tunnel that is 15 WebSockets per guest. |

## Findings from the code

### Screen sharing and audio

| ID | Severity | Finding |
|---|---|---|
| COLLAB-SCREEN-2 | major | The relay `AudioContext` is created without a user gesture and nothing ever calls `resume()`; the unlock button only calls `audio.play()`. The playhead (`max(currentTime+0.06, playhead)`) never shrinks, so a suspended context or a burst builds latency that never recovers. |
| COLLAB-SCREEN-3 | major | "Switch source" never stops the relay sender, so relay viewers freeze on the last frame. |
| COLLAB-SCREEN-4 | major | `activeBroadcasterId` mixes the room peer id and the broadcast client id; the dedupe never matches, so every screen move tears down a waiting relay receiver. |
| COLLAB-SCREEN-5 | major | A participant who is not the broadcaster publishes `broadcast.active=false` with any resize, minimize or follow, which stops the share for everyone. |
| COLLAB-SCREEN-7 | major | A relay viewer whose broadcast socket reconnects is never re-added; no socket has a keepalive. |
| COLLAB-SCREEN-9 | major | Browsers without WebCodecs get a black screen and no message. |
| COLLAB-SCREEN-10 | minor | `broadcast-stopped` is ignored while a viewer is still connecting. |
| COLLAB-SCREEN-11 | minor | `relay-request` leaves the broadcaster's peer connection alive. |
| COLLAB-SCREEN-12 | minor | A second `register` on one socket leaves stale bookkeeping. |

ICE uses only `stun:stun.cloudflare.com:3478`; there is no TURN server. That is why the relay exists, and why the fallbacks above matter.

**There is no voice chat.** No code captures a microphone; the only audio is the shared source's own audio (`getDisplayMedia` with `systemAudio`). Talking to each other needs a new feature (a story in the epic).

### Room, presence, identity and host role

| ID | Severity | Finding |
|---|---|---|
| COLLAB-ROOM-1 | major | No heartbeat on `/codexr-room` or `/codexr-broadcast` (only the live channel has one). A half-open socket leaves a frozen avatar for minutes, and the reconnect joins as a second person. |
| COLLAB-ROOM-2 | major | A reconnect loses the name (LAN and local views) and the host role: the oldest guest is promoted, and the returning host comes back as a guest. |
| COLLAB-ROOM-3 | major | A kick from inside the room closes the room socket only. The session is not revoked, and the guest's broadcast and live sockets stay open (also SYNC-10). |
| COLLAB-ROOM-4 | major | Kicking the local person with two views (#352) closes one view and leaves the person in the room. |
| COLLAB-ROOM-5 | major | Any participant can overwrite or delete any entity, server-owned ones included; no payload limit (ws default 100 MiB), no rate limit, entity count unbounded (also SYNC-1). |
| COLLAB-ROOM-6 | major | WebSocket upgrades do not check `Origin`: a web page in the host's browser can join as the host. |
| COLLAB-ROOM-7 | major | Every linked view of the local person sends presence; a headset view plus a desktop view make the avatar flicker. |
| COLLAB-ROOM-8 | minor | Presence dedupe never works (`lastSeenAt` is in the signature); the avatar yaw is lerped through ±180°. |
| COLLAB-ROOM-9 | minor | "Local" means loopback and not Cloudflare; any other loopback proxy (ssh -L, devtunnels, ngrok) is treated as the host, unauthenticated. |
| COLLAB-ROOM-10 | minor | After a tunnel restart (new URL) a guest retries forever with no explanation. |
| COLLAB-ROOM-11 | minor | A reconnect snapshot does not remove what disappeared while offline (also SYNC-9). |

### Interactions with components

| Component | Verdict |
|---|---|
| Analysis mode switch | shared (server entity with a revision floor), spoofable (SYNC-1) |
| Chart mapping panel | shared, but SYNC-3 and SYNC-5 |
| Dependency graph settings | shared, but SYNC-4; selection and tooltips are per person by design |
| Historical comparison | shared jobs; picker per person; SYNC-7 |
| Project evolution | half shared: SYNC-2 |
| Agent Flow | shared entity; open/close host machine only (correct); playhead per person by design |
| Drill-down | shared; SYNC-8 |
| Live reload | shared for every client, tunnel guests and reconnects included |
| Guide screen, pointer policy, debug | per person by design |

| ID | Severity | Finding |
|---|---|---|
| COLLAB-SYNC-1 | major | Peers can write server-owned entities (`analysis-view`, `agent-flow`, `drill-down`, ...): a guest can switch everyone's mode while the server believes another, or point everyone's Agent Flow at an arbitrary dataset URL. |
| COLLAB-SYNC-2 | major | Project evolution playback is half shared: frames are broadcast, play/pause is not, a client drops other people's frames while its own request is pending, and the frame is not in the snapshot. |
| COLLAB-SYNC-3 | major | A mapping change that arrives while this client plays the movie is dropped for good. |
| COLLAB-SYNC-4 | minor | Dependency graph settings are sent whole and echoed back to the sender with no revision, so concurrent changes overwrite each other and fast clicks flicker. |
| COLLAB-SYNC-5 | minor | One `mapping` entity serves every mapping context. |
| COLLAB-SYNC-6 | major | Destructive actions accept any guest: `project-evolution-clear` deletes the movie on disk, a guest can cancel the host's comparison. |
| COLLAB-SYNC-7 | minor | A late joiner does not see a job that is already running. |
| COLLAB-SYNC-8 | minor | Drill-down history is pushed before the result exists; concurrent Analyze clicks leave entries that were never shown. |
| COLLAB-SYNC-9 | minor | A reconnect does not clear entities removed while offline. |
| COLLAB-SYNC-10 | minor | A removed tunnel guest keeps its live and broadcast sockets. |

### IDE parity

| ID | Severity | Finding |
|---|---|---|
| COLLAB-IDE-1 | major | Screen sharing cannot work from the IDE scene pane: Electron needs a display-media handler and the pane's permission handler denies everything but armed XR. |
| COLLAB-IDE-2 | major | The IDE serves every scene over HTTP on `0.0.0.0`: reachable from the LAN without pairing, and never a secure context for a LAN guest (no WebXR, screen sharing or WebCodecs there). |
| COLLAB-IDE-3 | minor | The IDE opens the raw scene URL instead of the authenticated one, so the host appears to guests under a random name. |
| COLLAB-IDE-4 | minor | No participant list, kick, pending requests or new pairing code in the IDE. |
| COLLAB-IDE-5 | minor | The IDE cannot join someone else's session as a guest. |

Works in the IDE as in the plugin: same-device merge, drill-down, reveal, Agent Flow, the live channel, Cloudflare share and teardown, pairing dialog.

## What was fixed

Plugin and core, on `v1.3.0`. Each fix has an automated test; the multi-client run was repeated afterwards (below).

| Finding | Status | Where |
|---|---|---|
| COLLAB-SCREEN-0 | fixed: the screen registers once the room is known, and the server adopts the room from `viewer-join` | `signalingAndRemote.js`, `screenBroadcastSignalingServer.ts` |
| COLLAB-SCREEN-1 | fixed: `audioConfig` is resent with every keyframe request and on encoder start | `relayTransport.js` |
| COLLAB-SCREEN-2 | fixed: suspended context resumed on the first gesture and by the unlock button; playhead capped at 0.3 s ahead | `relayTransport.js` |
| COLLAB-SCREEN-3 | fixed: Switch source restarts the relay sender on the new track | `signalingAndRemote.js`, `relayTransport.js` |
| COLLAB-SCREEN-4 | fixed: one comparison for the current broadcaster (`isCurrentBroadcaster`) | `webrtcPeers.js` |
| COLLAB-SCREEN-5 | fixed on both sides: a non-broadcaster's update never carries broadcast fields, and the server keeps them | `sharedState.js`, `roomSharedState.ts` |
| COLLAB-SCREEN-6 | fixed: ICE failure and the join watchdog fall back to the relay once | `webrtcPeers.js` |
| COLLAB-SCREEN-7 | fixed: a re-registered socket rejoins the broadcast; every socket has a server heartbeat | `signalingAndRemote.js`, `webSocketEndpoint.ts` |
| COLLAB-SCREEN-8 | fixed: the room ends a broadcaster's shares when they leave | `roomSharedState.ts` (`endBroadcastsOf`) |
| COLLAB-SCREEN-9 | fixed: a message instead of a black screen | `relayTransport.js` |
| COLLAB-SCREEN-10, -11, -12 | fixed | `signalingAndRemote.js`, `relayPolicy.ts`, `screenBroadcastSignalingServer.ts` |
| COLLAB-ROOM-1 | fixed: 25 s ping on every endpoint, dead sockets terminated | `webSocketEndpoint.ts` |
| COLLAB-ROOM-2 | fixed: per-tab resume token; name, colour and host role kept for 2 min; interim host hands the role back | `roomResume.ts`, `roomRejoin.ts`, `clientCore.js` |
| COLLAB-ROOM-3, SYNC-10 | fixed: removal closes the broadcast and live sockets of the session and revokes it; those pages stop reconnecting on 4001 | `httpServer.ts`, `liveChannel.js`, `signalingAndRemote.js` |
| COLLAB-ROOM-4 | fixed: removal closes every view of the person | `collaborationRoomServer.ts` |
| COLLAB-ROOM-5, SYNC-1 | fixed: server-owned kinds refused from peers, locks honoured on update and remove, 256 entities per room, 256 KiB room messages, 5 MiB elsewhere. No rate limit yet. | `roomSharedState.ts` |
| COLLAB-ROOM-6 | fixed: same-origin `Origin` (or none, or a VS Code webview) | `remoteAccessPolicy.ts` |
| COLLAB-ROOM-7 | fixed: only the focused local view publishes presence | `presenceAvatars.js` |
| COLLAB-ROOM-8 | fixed: dedupe without `lastSeenAt`, keepalive every 5 s, shortest-arc yaw, timer loop | `presenceAvatars.js`, `codexrAvatarRuntime.js` |
| COLLAB-ROOM-9 | fixed: any forwarding header means "not the local person" | `remoteAccessPolicy.ts` |
| COLLAB-ROOM-10 | fixed: a notice after six failed reconnects | `clientCore.js`, `disconnectScreen.js` |
| COLLAB-ROOM-11, SYNC-9 | fixed: a snapshot removes what is not in it | `entitySync.js` |
| COLLAB-ROOM-12 | fixed: one socket attempt shared by every caller | `clientCore.js` |
| COLLAB-SYNC-2 | partly: other people's frames are no longer dropped. Play/pause is still per person and the frame is not in the snapshot. | `frameApplication.js` |
| COLLAB-SYNC-3 | fixed: kept and applied on pause | `xrChartMappingUiRuntime` |
| COLLAB-SYNC-6 | fixed: clear and cancel are host (or local) only | `analysisMessageRouter.ts` |
| COLLAB-SYNC-4, -5, -7, -8 | open (minor) | |
| COLLAB-IDE-1 to -5 | in the IDE change | `ide` branch |
| Voice chat | not built: a new feature, waiting for a decision | |

### The multi-client run after the fixes

| Check | Result |
|---|---|
| Host shares; two tunnel guests and a LAN guest join | 4 of 4 live with picture and sound (decoders, audio config and decoded frames on every guest) |
| 60 s with nobody touching anything, tunnel closing sockets idle for 40 s | 0 sockets closed, nobody left |
| Host reloads | same name, still host |
| Tunnel drops every socket at once | the guest comes back with the same name, still one person |
| Host removes the tunnel guest | room, broadcast and live sockets closed, removal screen shown, no reconnect attempt in the next 8 s, session revoked |
| Room sockets per page | 1 (was about 15) |

## What only people can verify

Two real people on different networks, a headset, and real audio: `docs/collaboration/audit/manual-test-guide.md`.
