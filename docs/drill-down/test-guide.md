# Drill-down: manual test guide

Epic #333. Design and pipeline: `apps/vscode-extension/docs/features/DRILL_DOWN_XR.md`.
Each step says what to do and what you should see. About 10 minutes.

## Setup

1. Open a real project in VS Code (Code-XR's own repository works well).
2. Run **Code-XR: Analysis > Analyze Project (XR, deep)** and open the scene in the browser.
3. Wait for the city on the table. Under the table's front edge there is a dark bar: `<`, `>`, `Home`, one crumb with the project name, and the line *Select a building or a district and choose Analyze to drill into it.*

## 1. Jump into a folder

1. Click a building first: the card shows *File: <name>*, its path and its three metrics (height, area, colour) above the buttons. BabiaXR's own white legend no longer appears. Close it with X.
2. Click a district (a green plate) of the city.
3. A card appears above the city: *Folder: <name>*, its path, and **Analyze folder**.
4. Press **Analyze folder**. Expected:
   - The table switches in place to the city of that folder only (no page reload; in VR the session stays open). The table changes to a deeper blue.
   - The bar shows `project > ... > folder` and a line such as *53 files: all up to date, nothing analysed.* Every file of a project analysis is reused, so this jump is instant.
   - The controller at the table's corner is still the analysis controller (chart type and metrics).
5. In the controller, pick another chart (Bar Chart) or another metric: the drilled city redraws with it, still showing only that folder. Pick Babia Boats again to go on.

## 2. Jump into a sub-folder, then a file

1. Click a district of the drilled city, **Analyze folder**: the table shows that sub-folder.
2. Click a building, then **Analyze file**: the table shows the functions of that file (file analysis). The line says *N functions: freshly analysed.* The controller is locked with a note: a file's functions have their own metrics, so go up a level to change them.
3. **Open in editor** on the card opens the file in VS Code (local scene only).

## 3. Go back up

1. `<` (Back) returns to the previous target; `>` (Forward) goes forward again.
2. Any crumb jumps to that folder; the `...` crumb jumps to the deepest hidden folder.
3. **Home** returns to the classic analysis of the project. Back from Home returns to where you were.
4. Choosing **Classic analysis** from the Analyses menu also counts as Home.

## 4. Only what changed is analysed

1. Drill into a file (step 2). Go Back, then Forward to the same file: *up to date, nothing analysed* (from the cache).
2. Edit that file in VS Code and save. The drilled view refreshes on its own within a second.
3. Drill into a folder that is **outside** the analysed folder but inside the workspace (analyse `src/` only, then press the project crumb): the first time a loading card appears over the table (*Analyzing folder ...*, with the elapsed time) and the line says *X reused, Y analysed*. Jump there again: nothing is analysed.

## 5. Shared room

1. Open the same scene in a second browser tab (or join from a headset).
2. Drill in one tab: the other follows (same table, same bar).
3. A tab opened later joins on the drilled view.

## 6. From the editor

1. With the scene running, right-click a folder or a file in the Explorer (or in an editor) and choose **Code-XR: Analyze in XR Scene**.
2. The scene switches to it. With no running scene that holds the path, VS Code says so.

## 7. Refusals

1. In a scene exported to a folder (offline copy), pressing Analyze shows *Drill-down needs the live Code-XR session* on the bar.
2. A target outside the workspace is greyed out on the card (*Outside <project>*).

## Known limits

- The card needs a chart that marks its elements (boats, the default). With a flat chart the drilled data still draws, but clicks open no card.
- Open in editor only reaches files inside the analysed folder.

## Screenshots

`/mnt/project-files/xr-drilldown/screenshots/` (real analysis of Code-XR's own `src/`, 351 files): home, folder card, drilled `src/core/server`, sub-folder `server/analysis`, file card, drilled `httpServer.ts` (57 functions), Back.
