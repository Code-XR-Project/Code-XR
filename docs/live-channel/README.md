# Live channel: one WebSocket layer for realtime updates

Epic [#341](https://github.com/Code-XR-Project/Code-XR/issues/341), stories #342 to #347. Since 1.3.0.

Every realtime channel of a Code-XR analysis server is a WebSocket. Until 1.2.1 the server had two transports: the collaboration room on WebSocket and a Server-Sent Events stream (`/events`) for live reload and LivePanel updates. The SSE stream, its manager and its clients are gone.

| Path | What travels on it | Server | Browser |
|---|---|---|---|
| `/codexr-room` | Collaboration: presence, profiles, analysis entities and mode switches, Agent Flow, drill-down, dependency graph, historical comparison, project evolution | `core/server/collaboration/collaborationRoomServer.ts` | `templates/components/codexr/collaboration/` |
| `/codexr-live` | Live updates: XR and DOM live reload, LivePanel data, dependency and comparison updates | `core/server/live/` | `templates/components/live/liveChannel.js` |

The two stay separate on purpose. The room has membership, identity and authority rules; the live channel is a broadcast with no identity. They share the endpoint helper (`core/server/ws/webSocketEndpoint.ts`) and the authorisation policy (`RemoteAccessPolicy.isWebSocketAuthorized`: always on loopback, a paired session cookie through a tunnel).

## Who uses it

Both hosts run the same code. The VS Code extension and the Code-XR IDE import the core (`@codexr/core` is `apps/vscode-extension/src/core` in the IDE build), so every analysis server either of them starts serves `/codexr-live`, and the generated pages ship the same browser runtime.

## Protocol (`core/server/live/liveChannelProtocol.ts`)

Every message is one JSON object:

```json
{ "v": 1, "type": "dataRefresh", "channel": "<session id>", "revision": 7, "epoch": "9f2c...", "timestamp": "...", "...payload": "..." }
```

| Type | Sent when | Consumed by |
|---|---|---|
| `connected` | first message of every socket | runtime (status, resync) and LivePanel |
| `heartbeat` | every 15 s | runtime watchdog only, never reaches the page |
| `analysis-updated` | non-XR re-analysis finished | LivePanel, XR scenes |
| `dataRefresh` | XR re-analysis finished | XR scenes |
| `htmlUpdated` | DOM visualisation regenerated (`htmlContent`) | DOM pages |
| `dependency-updated` | dependency dataset rewritten | LivePanel |
| `historical-progress` / `historical-updated` | comparison progress / result | LivePanel |

Close codes: `1000` normal, `1001` analysis stopped, `4404` the server serves no analysis (the old route answered 404). The client reconnects after any of them.

## What SSE gave for free, now explicit

- **Heartbeat.** The hub pings every socket every 15 s and terminates one that did not answer the previous ping. It also sends an application `heartbeat`, because browsers cannot see WebSocket pings.
- **Auto-reconnect with back-off.** The runtime reconnects after any close: 1 s, doubling to 30 s, plus up to 20% jitter so a room of headsets does not reconnect in lockstep. A greeting resets the delay.
- **Half-open detection.** A socket silent for three heartbeats (45 s), typically after the laptop slept or the Wi-Fi changed, is closed and replaced.
- **Resync.** Every non-heartbeat publish bumps the channel's revision, and each hub has a random epoch. The greeting carries both. When a reconnect sees a different revision or epoch than the last message the page received, the page catches up once:
  - XR scene: one data refresh;
  - DOM page: one reload;
  - LivePanel: reload data and dependency summary, re-read the comparison status.

## Files

| File | Role |
|---|---|
| `src/core/server/live/liveChannelProtocol.ts` | Pure contract: path, types, envelope, timings, back-off and resync rules |
| `src/core/server/live/liveChannelHub.ts` | Process-wide hub: channels, fan-out, revision/epoch, heartbeat, cleanup |
| `src/core/server/live/liveChannelEndpoint.ts` | `/codexr-live` on one server, bound to the channel of its analysis |
| `src/platform/liveReloadScripts.ts` | Assembles runtime + page script into a scene's `main.js` |
| `templates/components/live/liveChannel.js` | Browser runtime `window.CodeXRLiveChannel` |
| `templates/xr/live/liveReloadXR.js`, `liveReloadDOM.js` | Page scripts of XR scenes and DOM pages |
| `templates/components/livepanel/panelShell.js` | `createLivePanelLiveChannel`, the LivePanel client |

Publishers: `core/analysis/watchers/reAnalysisManager.ts`, `directoryReAnalyzer.ts` (live reload) and `core/server/analysis/analysisFeatureHost.ts` (LivePanel features). Stopping a server closes its channel (`serverControl.ts`); deactivation disposes the hub.

## Tests

- `test/servers/liveChannelHub.test.cjs`: protocol, hub, endpoint over a real `ws` client, and the runtime constants against the protocol.
- `test/analysis/liveChannelRuntime.test.cjs`: the runtime alone (dispatch, watchdog, resync, close, disabled).
- `test/analysis/liveReloadClient.test.cjs`, `test/analysis/livePanelLiveChannel.test.cjs`: XR, DOM and LivePanel pages wired to it.

Manual checks: [test-guide.md](test-guide.md).

## Out of scope

The IDE's MCP client transports and the LLM providers' streaming speak SSE to external servers because their protocols say so. They are not part of the analysis server.
