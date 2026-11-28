# Multi-client collaboration harness

Real browsers joining one real XR analysis, the way two or more people do: the host on this machine, a guest on the LAN, and guests through a stand-in for the Cloudflare tunnel. Written for the collaboration audit (`docs/collaboration/audit/README.md`); run it again after any change to the room, the screen broadcast or the live channel.

It is manual on purpose: it needs Chromium, a Python venv and about five minutes, so it is not part of `npm test`. What it checks is also covered by unit tests (`test/servers/collaborationRoom*.test.cjs`, `screenBroadcastSignalingServer`, `webSocketEndpoints`, `webSocketOrigin`, `hostOnlyMessages`); this harness is the end-to-end proof.

## Run

From `apps/vscode-extension`:

```bash
npm run compile-tests
CHROMIUM_PATH=/path/to/chromium LAN_HOST=<this machine's LAN address> \
  bash test/manual/collaboration-e2e/run.sh [folder-to-analyse]
```

- `CHROMIUM_PATH`: only when the installed Playwright has no browser of its own.
- `LAN_HOST`: defaults to the first non-internal IPv4 address.
- `CODEXR_VENV`: a venv with `backend/requirements.txt` (default `backend/artifacts/analysis-test-venv`, the one `npm run test:analysis` creates).
- The folder defaults to `backend/manual_test`.

Logs go to `$TMPDIR` (`codexr-e2e-server.log`, `codexr-e2e-proxy.log`, `codexr-e2e-screen-share.log`).

## The pieces

| File | What it does |
|---|---|
| `launch-server.cjs` | Runs a directory XR analysis through the core with a stub host (no VS Code), on `https://localhost:3000`, with a control API on `127.0.0.1:3999`: `/invite`, `/code` (last pairing code), `/participants`, `/kick?id=`, `/touch` (edit a file to trigger a re-analysis), `/info`. |
| `tunnel-proxy.cjs` | Behaves like a Cloudflare quick tunnel: TLS for `test-abc.trycloudflare.com:4443`, reaches the origin from `127.0.0.1`, adds `cf-connecting-ip` / `x-forwarded-for`, optional one-way latency (`LATENCY_MS`, 80 by default) and closes WebSockets idle for `WS_IDLE_MS` (Cloudflare: 100 s). The certificate is made on first run in `$TMPDIR`. |
| `restart-proxy.sh` | Restarts the proxy, which drops every tunnel socket at once (a cut connection). |
| `lib.cjs` | Launches one Chromium per participant (a shared browser hits the per-host WebSocket limit and hides bugs), serves the A-Frame libraries from `test/vendor/scene-libraries`, and logs every socket and broadcast message. `tunnelGuest` goes through the real pairing page. |
| `probes.js` | Injected into every page: counts encoders, decoders and frames, and replaces `getDisplayMedia` with an animated canvas plus a tone. |
| `screen-share.cjs` | Host shares a screen; a tunnel guest, a LAN guest and a second tunnel guest join. Prints every screen's state and the frames each client sent or received. |
| `reconnect-and-kick.cjs` | Host and a tunnel guest: a minute of silence through a tunnel that closes idle sockets at 40 s, a host reload, a tunnel drop, then the host removes the guest. |

## Expected output

`screen-share.cjs`: every client `"status":"live"` with `"audio":true`; the guests show `videoDecoders: 1`, `audioDecoders: 1`, `audioCfg: 1` and growing `videoOut`/`audioOut`. Low frame counts on a small machine are CPU, not a fault.

`reconnect-and-kick.cjs`:

```
START Anakin:host, Anakin 2:guest
IDLE-CLOSES after 60 s quiet (tunnel closes at 40 s idle): 0
AFTER-IDLE Anakin:host, Anakin 2:guest
AFTER-HOST-RELOAD Anakin:host, Anakin 2:guest
AFTER-TUNNEL-DROP Anakin:host, Anakin 2:guest
KICK {"removed":true,"sessionRevoked":true}
AFTER-KICK Anakin:host
GUEST SOCKET EVENTS AFTER KICK: room, broadcast and live closed
REMOVED SCREEN: true
REOPENED AFTER KICK: 0
```

The names are random; what matters is that they and the roles do not change across the idle period, the reload and the drop.

## What it cannot do

Two real NATs, a real `trycloudflare.com` tunnel, a headset and real ears. Those are in `docs/collaboration/audit/manual-test-guide.md`.
