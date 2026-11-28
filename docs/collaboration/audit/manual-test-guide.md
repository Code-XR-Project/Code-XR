# Collaboration: manual test guide

What the automated tests and the multi-browser harness cannot prove: two real people on different networks, the real Cloudflare tunnel, a headset, and real audio. About 30 minutes with one helper.

You need: the VS Code extension (or the Code-XR IDE) with a folder open, a second person on another network (a phone on mobile data works), and ideally a headset (Quest) for part E. Use headphones on the guest side so the host's audio does not loop back.

Write down for each step: works / fails, and what you saw. A failure with the browser console open (F12) is the most useful report.

## A. Join through the tunnel

1. Start an XR analysis. In the Code-XR sidebar, turn on cross-network sharing and copy the invitation link.
2. The guest opens the link, picks a name, requests access. You confirm the six-digit code.
   - Expected: the guest enters the scene under the chosen name, and both of you see each other's avatar moving.
3. The guest reloads the page.
   - Expected: same name, same colour, no second avatar for them.

## B. Shared screen (the main fix)

1. Host: take a virtual screen, **Share screen**, choose a window that plays a video with sound (a YouTube tab is fine).
   - Expected: the guest sees the picture within a few seconds and hears the sound (they may need to click once in the page if the browser blocks audio; a hint appears).
2. Ask a second guest to join (or open the link in another browser on the guest machine).
   - Expected: the second guest also sees and **hears** it. (Before the fix only the first relay viewer had sound.)
3. Host: **Switch source** to another window.
   - Expected: guests follow the new window, they do not freeze on the last frame.
4. Guest: resize, move or minimise the shared screen.
   - Expected: the share keeps going for everybody. (Before, a guest's resize could stop it.)
5. Host: close the tab that is sharing.
   - Expected: the screen goes back to idle for the guests, and when the host reopens the scene they can share again without restarting anything.
6. Optional, LAN: a guest on the same Wi-Fi opens the scene with the LAN address.
   - Expected: they see the share too. If the network blocks direct connections, it now falls back to the server relay instead of "Connecting..." forever.

Note the delay and the sound quality on the guest side; there is no number to hit, only "usable" or not.

## C. Connections that drop

1. Leave the scene idle for three minutes, nobody touching anything.
   - Expected: nobody is disconnected (Cloudflare closes idle connections after 100 s; the server now keeps them busy).
2. Guest: turn Wi-Fi off for 20 seconds, then on.
   - Expected: they come back with the same name and colour, and there is never a frozen second copy of them.
3. Host: reload the scene (or close and reopen the tab within two minutes).
   - Expected: while you are away a guest becomes host; when you are back, **you are the host again** and they are a guest.
4. Host: stop sharing in the sidebar and start it again (the tunnel gets a new address).
   - Expected: the guest with the old link sees, after a minute or so, a message that the session may have moved and to ask for the new link.

## D. Removing someone

1. Host: remove the guest (sidebar participant list, or from inside the room).
   - Expected: the guest sees "Removed from session"; their screen share and live updates stop too; reloading the old link does not let them back in without a new pairing.
2. Host with two views of the scene open (a browser tab and the IDE pane, or two tabs): ask a guest to try to kick you. They cannot (host only). Then check both your views stay one person in the guests' list.

## E. Interactions everyone shares

With at least one guest:

1. Host changes the analysis mode (classic, dependency graph, historical comparison, project evolution, Agent Flow). Expected: the guest's table follows every time.
2. Guest changes the chart mapping (chart type or an axis). Expected: the host sees it.
3. Project evolution: both press play/seek at about the same time. Expected: you both end on the same frame.
4. While the host plays the movie, the guest changes the mapping. Expected: the host's table applies it when the host pauses.
5. Guest tries **Clear** on the project evolution movie or **Cancel** on a running comparison. Expected: refused with "Only the host can do this"; the host can do both.
6. Save a file in the editor. Expected: everybody's scene refreshes.
7. Drill-down: the guest analyses a folder from the table. Expected: everybody follows, Back works for everybody.

## F. Headset

1. Host or guest enters VR on a Quest.
   - Expected: the other person sees the avatar move with the headset (head and hands), and the avatar does not spin when the person turns past behind them.
2. In VR, look at the shared screen with sound playing. Expected: picture and sound keep going in VR.

## G. IDE

Repeat A.1-A.2 and B.1 with the host in the Code-XR IDE instead of VS Code. The IDE fixes are in a separate change; note what fails rather than stopping.

## Reporting

For each failure: the step, who (host / guest, which network), what you saw, and a screenshot of the browser console if you can.
