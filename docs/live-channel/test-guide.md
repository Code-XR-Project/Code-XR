# Live channel: manual test guide

Epic #341. About 15 minutes. Every check runs once in VS Code (F5 "Run CodeXR Extension" or the installed VSIX) and, where marked, once in the Code-XR IDE.

Keep the browser developer tools open on the **Network → WS** tab: you should see one `codexr-live` socket per page (plus `codexr-room` on XR scenes), and no `events` request at all.

## 1. XR scene live reload (VS Code and IDE)

1. Open a project and start an XR analysis of a file (or a directory).
2. In the scene's Network tab, check `ws://localhost:<port>/codexr-live`: the first frame is `{"type":"connected",...}`, then a `heartbeat` every 15 s.
3. Edit the analysed file (add a function) and save.
4. Expected: a `dataRefresh` frame arrives and the charts update in place, keeping the mapping and camera. No page reload.

## 2. Auto-reconnect and resync (the important one)

If your Chrome version keeps WebSockets open under DevTools **Offline**, do this step from a phone or headset on the LAN instead and toggle its Wi-Fi off and on.

1. With the scene from step 1 open, set **Network → Offline** in DevTools for 10 seconds (the server keeps running).
2. While offline, edit and save the file again.
3. Turn the network back on.
4. Expected: within a few seconds a new `codexr-live` socket opens (the old one shows as closed), and the charts update **once** with the change you made while offline. `window.__CODEXR_LIVE_RELOAD_STATUS__` in the console goes `reconnecting` then `open`.
5. Go offline again for ~60 s without changing anything, then back online. Expected: it reconnects and does **not** refresh (nothing was missed).

## 3. Server restart

1. With a scene open, close the analysis (Close Analysis) and start the same analysis again on the same port, or restart VS Code with the page left open.
2. Expected: the old page keeps retrying (1 s, 2 s, 4 s ... up to 30 s) without reloading itself in a loop or showing a browser error page; once a server answers on that port it reconnects and refreshes once.

## 4. LivePanel (VS Code)

1. Start a LivePanel analysis of a directory.
2. The top-right indicator reads **Live Updates**. Save a file in the directory: it flashes **New data received** and the tables update.
3. Start a historical comparison: progress messages arrive and the result loads.
4. DevTools offline for 10 s: the indicator turns **Disconnected**; back online it returns to **Live Updates**. Save a file while offline and check that the panel shows the change once it reconnects.

## 5. DOM visualisation (VS Code)

1. Run **Visualize DOM** on an HTML file.
2. Edit the HTML and save: the `babia-html` element updates in the scene.
3. Offline 10 s, save a change, back online: the page reloads once to catch up.

## 6. Remote and headset

1. Share an XR analysis through **Cloudflare remote access** and open the invitation on another device.
2. Expected: the page's Network tab shows `wss://<random>.trycloudflare.com/codexr-live` and saving a file on the host updates that device too. (Before 1.3.0 live reload did not work through the tunnel, because SSE is not supported there.)
3. On a headset on the LAN over HTTPS, the scene shows `wss://<lan-ip>:<port>/codexr-live` and live reload works the same.

## 7. Offline export

1. Export an XR analysis and open the export with a static server.
2. Expected: no `codexr-live` socket is opened, no console errors about live reload.

If anything fails, note which step, the host (VS Code or IDE) and copy the frames of the `codexr-live` socket from the WS tab.
