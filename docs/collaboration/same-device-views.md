# One person, many views

Story #352, under epic #341.

Every view opened on the computer that runs Code-XR is the same person in the room. That includes the Code-XR IDE's scene pane and any `localhost` tab in a browser. The views share one name, one avatar, one role and one camera.

## How it works

- **One participant.** The first local view to join the room creates the participant. Later local views attach to it, so the room server sees one person, and the participant leaves only when its last local view closes.
  - "Local" means the room's own rule (`isLocalRequest`): a loopback connection that is not remote access. Guests through the tunnel or the LAN are always separate people.
  - Code: `src/core/server/collaboration/localDevice.ts`.
- **One camera.**
  - The view you move in sends a `self-view` message on the room socket (`/codexr-room`). It carries the rig position and rotation and the look-controls pitch and yaw.
  - The server relays it to your other local views and keeps the latest one for a view opened later. It never reaches remote guests.
  - Code: the `selfView.js` part of the collaboration runtime.
- **No ping-pong.**
  - A view never sends a camera it was given.
  - The pose a view starts with does not count as a move.
  - A view in a headset (VR or AR) neither leads nor follows.

It replaces the "viewer" of #331. That fix hid the IDE pane from the room, so guests could not see the host when only the IDE was open.

## Manual test (about 10 minutes)

You need the Code-XR IDE (or VS Code with the extension) and a desktop browser on the same computer. A second device, such as a phone, a headset or another computer, is optional for step 4.

1. In the IDE, open a project and its XR analysis in the right-hand pane. Look around with the mouse and walk a little with WASD.
2. Press **Open in browser**, or type the scene's `localhost` address in Chrome or Edge.
   - Expected: the browser opens at the same place and facing the same way as the IDE pane, not at the default start.
   - Expected: no second avatar appears in either view.
3. Move in the browser.
   - Expected: the IDE pane follows within a fraction of a second.
   - Then move in the IDE pane. Expected: the browser follows.
   - Neither view drifts or shakes when you stop.
4. Optional, with a second device: share the session (invitation link through the LAN or remote access) and join from the other device.
   - Expected: the guest sees **one** avatar for you, moving wherever you move, whichever of your two views you use.
   - Expected: the guest is a separate person and does not take over your camera.
5. Close the IDE pane's scene. Expected: you stay in the room through the browser, and the guest still sees you. Close the browser too. Expected: you leave the room.
6. VS Code only: open the scene in two `localhost` tabs. They behave as one person, as in steps 2 and 3.

For anything wrong, note which view you moved in, what the other did, and the browser console (F12).

## Automated coverage

- `apps/vscode-extension/test/servers/collaborationRoomServer.test.cjs`:
  - one participant for every local view;
  - the participant leaves with its last view;
  - the camera is relayed, and stored for a late view;
  - guests are never linked and never get the camera.
- `apps/vscode-extension/test/analysis/collaborationRuntime.test.cjs`:
  - a view sends only on a real move;
  - it follows without echoing;
  - guests and headsets stay out.
