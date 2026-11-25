# Launcher / servers / session lifecycle audit (area: `launcher`)

Repo: `/home/user/Code-XR` @ d89e08d4. Paths below are relative to `apps/vscode-extension/` unless they start with `backend/`.
Confirmation scripts (all runnable with `export PATH=/opt/node24/bin:$PATH; node --test <file>`, they use `test/helpers/fakeVscode.cjs` and compiled `out/`):
`/tmp/claude-0/-home-user/af5ccea8-f538-575c-b7b6-8256e5a53df6/scratchpad/audit/launcher/t1…t9*`.

## 1. How the area works (summary)

1. **Entry points.** Some 20 commands and tree clicks call `AnalysisOrchestrator.orchestrateAnalysis(path, mode, targetType, ctx, isDeep)` (`src/core/analysis/analysisOrchestrator.ts`). They live in `features/analysis/commands/{file,directory,dom}/*`, `sections/files-by-language`, `sections/project-by-language`, and `projectAnalysisCommands`. Each call site picks the mode (XR / LivePanel / VisualizeDOM) with its own `switch`.
2. **Session creation.** `UnifiedSessionRegistry.createSession` (`core/analysis/session/sessionRegistry.ts`) rejects a duplicate: same path, mode, type and depth, with a status other than closed or error. It then builds `storage/{fileAnalysis|directoryAnalysis}/<name>_<mode>_<type>_<nonce>`.
3. **Launch.** The orchestrator dispatches on mode × targetType to `LauncherXRAnalysis` / `LauncherLivePanel` / `LauncherVisualizeDOM`. All three feed `executeLaunchPipeline` (`launchers/launchPipeline.ts`), which runs: preValidation → `FileRequirementProcessor` (Python via `ExecutePython`, then the template parsers: `fileXRParser`, `directoryXRParser`, `livePanelParser`, `visualizeDOMParser`) → `SaveFiles` → **watcher** (`SessionWatcherManager`, File/DirectoryWatcherOrchestrator) → **server**. DOM runs server first, then watcher.
4. **Server.** `new SessionServerManager` (one per launch) → `ServerLaunchOrchestrator` → `MultiServerLauncher.launchServer`. That probes the port, then `serverFactory.launchServerByType` → `HttpServer` / `HttpsDefaultServer` / `HttpsCustomServer`, listening on `0.0.0.0`. It then registers in `ActiveServerRegistry` and auto-opens the page. Afterwards `fileToServerMap.registerMapping(targetPath → port)` keys SSE delivery.
5. **Per-server analysis features.** The `HttpServer` constructor builds an `AnalysisFeatureHost`. Driven by `analysisServerCapabilities.ts`, it attaches `DependencyGraphService`, `HistoricalComparisonService`, `ProjectEvolutionService` and `GitAnalysisSourceCatalog`, wires them into `analysisRefreshCoordinator`, and exposes them through:
   - REST: `/api/dependency-graph/summary`, `/api/historical/references`, `/api/historical/compare`;
   - the collaboration WebSocket `/codexr-room` (`AnalysisMessageRouter`), which is what the in-scene switcher uses;
   - SSE `/events`, for classic data refresh and LivePanel pushes.
6. **Refresh.** Watchers call `analysisRefreshCoordinator.publishChanges`. The coordinator runs the handler of the active mode (and of the background modes) and publishes the `analysis-view` entity to the room. The re-analyzers send SSE `dataRefresh` (XR) or `analysis-updated` (others) to every client registered under **`targetPath`**.
7. **Stop.**
   - `ServerControl.stopServer` closes the panel, clears the SSE clients and the file map entry found by port, marks the session closed, `stop()`s with a 4 s timeout falling back to `forceStop()`, and unregisters.
   - `ServerWatcherIntegration` listens for `serverRemoved` and stops the session watcher of every session whose `port` matches.
   - Active Analyses "Close Analysis" runs `triggerManualCleanup`, then `removeSession`.

## 2. Findings

### LAUNCHER-1: HTTPS servers listen on a different port from the one registered (LAN/headset URL, tree, session and toast show the wrong port)
- Severity: major   - Type: bug
- Evidence:
  - `src/core/server/multiServerLauncher.ts:116` `const finalPort = await this.findAvailablePortWithLogging(requestedPort);`. When the default port is busy, this goes through `PortManager.findAvailablePort` → `get-port`, which **locks the returned port for 15–30 s** (`node_modules/get-port/index.js`, `lockedPorts.young`).
  - `src/core/server/httpsDefaultServer.ts:32` and `httpsCustomServer.ts:42` `await this.resolveListeningPort();` → `httpsServerBase.ts:161-167` calls `findAvailablePort(this.config.port, …)` again. get-port skips its own locked port, so `this.config.port = availablePort` (+1).
  - `multiServerLauncher.ts:167,210` still register and return `port: finalPort`. That value goes into `ActiveServer.port`, `session.port`/`assignedPort`, `fileToServerMap` and the success toast.
  - The URL is right (it comes from `server.start()`), but `activeServerItems.ts:172`, `handleServerActions.ts:141` and `serverDetailsFormat.ts:24` build the **LAN URL from `server.port`**.
- Failure scenario: HTTPS mode, which is the headset mode. Launch any second analysis while one server holds 3000. The tree says "localhost:3001" and "Local network address https://192.168.x.x:3001", and the toast says "Server running on port 3001", but the listener is on 3002. The headset typed or copied URL gets connection refused, or another Code-XR server. Once the get-port lock expires, a later launch can be registered on the same port as an earlier one. `findFileByPort` and `ServerWatcherIntegration.handleServerRemoved` (filter `session.port === server.port`) then pick the wrong file, or tear down two sessions (the duplicate-port part is LIKELY, not reproduced).
- Confidence: CONFIRMED. Running `t2_https_port_mismatch.test.cjs` (real `MultiServerLauncher` + real `HttpsDefaultServer`, default port occupied) printed `result.port=7440 url=https://localhost:7441 actual listen port=7441 listening@result.port=false`.
- Proposed fix: resolve the port once. Delete `resolveListeningPort()` from the HTTPS servers, or have it return the bound port. After `start()`, read the real port from `server.address().port` and use it everywhere: launcher result, registry, file map. Also make the inner `HttpServer` config port follow it; it is copied in the `HttpsServerBase` constructor. Test: a variant of t2 inside `test/servers/multiServerLauncher.test.cjs` with the real HTTPS class, asserting `result.port === instance.server.address().port`.

### LAUNCHER-2: `forceStop()` never closes the listener (HTTP and HTTPS), and the later `stop()` is a no-op
- Severity: major   - Type: bug (REPORT §9 deferred item, and it is worse than recorded: it is not HTTPS-only)
- Evidence: `src/core/server/httpServer.ts:230-234` and `httpsServerBase.ts:107-111` only do `closeAllConnections(); isRunning = false;`, with no `server.close()`. `stop()` starts with `if (!this.server || !this.isRunning) return;` (`httpServer.ts:198-201`), so after a force stop nothing can ever close the socket. `serverControl.ts:113` unregisters the entry anyway.
- Failure scenario: a graceful stop rejects or exceeds 4 s, for example a lingering upgraded WebSocket or tunnel socket (`closeAllConnections` does not track upgraded sockets), or a `close()` error. ServerControl warns "Server removed from the list, but its runtime did not shut down cleanly". The port stays bound on `0.0.0.0` with live request handlers and static files, but no tree entry. It is invisible and cannot be stopped until VS Code restarts. This is one way the tree and the OS port list drift apart.
- Confidence: CONFIRMED. Running `t1_server_stop_and_events.test.cjs` printed `connect after forceStop: true after stop(): true getIsRunning: false`.
- Proposed fix: in both `forceStop()`, call `this.server?.close()` (ignore `ERR_SERVER_NOT_RUNNING`), destroy upgraded sockets the server tracks itself (keep a `Set<Socket>` from `'connection'` and `'upgrade'`), then null `this.server`. Make `stop()` key on `this.server` and not on `isRunning`. Test: t1 case 1, inverted, added to `test/servers/`.

### LAUNCHER-3: one target served twice (two modes, or XR plus XR-deep) breaks live reload and cross-wires SSE
- Severity: major   - Type: bug (REPORT §9 "same target in two modes")
- Evidence:
  - `src/core/analysis/session-servers/serverLaunchOrchestrator.ts:83` `fileToServerMap.registerMapping(request.targetPath, …)`;
  - `core/server/fileToServerMap.ts:50` `this.fileToServer.set(fileUri, serverInfo)`, which overwrites;
  - `httpServer.ts:526-535`, where `/events` does `findFileByPort(this.config.port)` → 404;
  - `SSEManager`/`sseClientRegistry` key clients by `targetPath`. `directoryReAnalyzer.ts:268-273` and `reAnalysisManager.ts:55-57` send to `session.targetPath`.
- Failure scenario: XR and LivePanel of `src/` at once, or XR then XR-deep of the same folder (allowed, since `isDeep` differs):
  1. The first page loses live reload. Its `/events` returns 404, and the EventSource gives up or retries forever.
  2. Clients connected before the second launch are now cross-wired. A LivePanel re-analysis sends `analysis-updated` to the XR page, and the XR watcher sends `dataRefresh` to the LivePanel page. Each reloads its own `data.json`, so it double-reloads or reloads stale data.
  3. Stopping the second server runs `removeAllClients(targetPath)` and `unregisterMapping(targetPath)`, which kills the first server's SSE as well.
- Confidence: CONFIRMED for the 404 (`t1` case 2: `A /events before B: 200 A after B: 404 B: 200`). The cross-wiring is LIKELY, traced through the code.
- Proposed fix: key SSE and the server map by **sessionId**, not by target path. `/events` resolves `this.config.analysisSessionId`, which the server already has, and `SSEManager.sendDataRefresh(sessionId)`. Keep a `targetPath → Set<sessionId>` index for watchers. Test: register two sessions on one target, assert both `/events` return 200 and that a refresh of session A reaches only A's clients.

### LAUNCHER-4: double-click or quick re-trigger bypasses the duplicate-session guard
- Severity: major   - Type: bug (race)
- Evidence: `src/core/analysis/session/sessionRegistry.ts:90` runs the duplicate check, then `:99` `await this.hashTargetFile(...)` (file) or `:119` `await this.assertDirectoryTarget(...)` (directory). Only then does `:128` `this.sessions.set(id, session)` happen. Neither the orchestrator nor the commands hold any in-flight lock.
- Failure scenario: double-click "Analyze File (XR)", or run it from the editor menu and the tree in quick succession. Two sessions, two Python runs, two watchers and two servers result for the same target. Both pages then hit LAUNCHER-3, and two browser tabs or panels open.
- Confidence: CONFIRMED. `t3_session_race_and_pipeline.test.cjs` printed `kinds: created created sessions: 2`, and the same for directories.
- Proposed fix: reserve synchronously. Insert the session (status `creating`) before the first `await`, or keep a `Map<key, Promise>` of in-flight creations keyed by a normalised key (see LAUNCHER-17). Test: the t3 case 1, asserting the second call returns `duplicate`.

### LAUNCHER-5: a launch that fails at the server step leaks its watcher and says nothing to the user
- Severity: major   - Type: bug
- Evidence: in `src/core/analysis/launchers/launchPipeline.ts:136` the watcher starts before the server (XR and LivePanel). On failure, `:239` `registry.updateSessionStatus(session.id, 'error', undefined, 'Server could not be started')` runs with **no throw and no toast**. `SessionServerManager.startServerForSession` swallows every error into `{isServerActive:false}`. The `catch` at `:147` does not stop the watcher either. The `error` session is never removed, and the duplicate check ignores `error`, so each retry adds another session and watcher.
- Failure scenario: an XR or LivePanel launch whose server cannot start. Causes include HTTPS-custom with a missing certificate, `defaultPort` 8080 busy (LAUNCHER-12), or `EADDRINUSE`. The user sees nothing, or only "Port … busy". The file or directory watcher keeps re-running the Python analysis on every save, for a page that does not exist. With directory sessions, that is a full re-scan.
- Confidence: CONFIRMED. `t3` case 2 printed `status: error watcherId: watcher-1 watcherStarted: 1 messages: []`.
- Proposed fix: give the pipeline a `try/finally` teardown list (watcher stop, server stop, map unregister) that runs on any failure, and always surface the error. Better, start the server before the watcher, as DOM already does. Test: the t3 case 2, asserting `stopWatchingSession` was called and an error toast was shown.

### LAUNCHER-6: a server whose `start()` fails still wires its analysis services to the session
- Severity: minor   - Type: bug / leak
- Evidence: `src/core/server/serverFactory.ts:200` `serverUrl = await server.start();`. The catch returns `{success:false}` and never disposes the instance. Meanwhile the `HttpServer` constructor already built `AnalysisFeatureHost` (`analysis/analysisFeatureHost.ts:59-155`), which:
  - registers the `dependency-graph` refresh handler and an `onStateChanged` listener;
  - subscribes to `analysisUpdateEvents`;
  - for LivePanel, calls `setBackgroundRefresh` + `forceRefreshMode('dependency-graph')`, which starts a Python dependency scan.

  `start()` also runs `attachToNodeServer`, which creates the room and broadcast WebSocket servers.
- Failure scenario: a port race or certificate failure. The session keeps a ghost dependency handler and listeners. A LivePanel launch that failed still burns a full dependency analysis in the background.
- Confidence: CONFIRMED. `t6_failed_start_leak.test.cjs` printed `launch success: false … coordinator handlers left: [ 'dependency-graph' ] listeners: 1`.
- Proposed fix: in `launchServerByType`'s catch, call `server.disposeRuntimeFeatures()` (or `forceStop()`). Better, build the feature host lazily on `'listening'`. Test: t6, asserting no handler is left behind.

### LAUNCHER-7: "Close Analysis" during analysis leaves an orphan server and watcher, then reports success
- Severity: major   - Type: bug (race / teardown)
- Evidence:
  - `features/analysis/sections/active-analyses/activeAnalysesCommands.ts:200` offers Close for any non-closed status, including `analyzing`.
  - `:270-271` runs `triggerManualCleanup`, then `removeSession`.
  - `executeLaunchPipeline` holds the session object and never re-checks the registry. After Python returns it saves, starts the watcher, starts the server, and `onSuccess` toasts. `registerSessionPort` only warns "not found".
- Failure scenario: start a long directory XR analysis, then close it from Active Analyses. A minute later a server opens anyway, with a watcher re-analysing on save. The server's feature host finds no session, so the in-scene switcher reports every analysis unavailable. It is listed in Active Servers but not in Active Analyses.
- Confidence: CONFIRMED. `t4_close_while_analyzing.test.cjs` printed `after removal: watchers started 1 servers started 1 session in registry false toasts [… "Server running on port 3005"]`.
- Proposed fix: give each launch an `AbortController` stored on the session, or in the unified registry (§4). Close or remove aborts it, the pipeline checks `signal.aborted` between steps, and Python is killed through the signal (LAUNCHER-10). Test: the t4 case 1, asserting zero watcher and server starts.

### LAUNCHER-8: closing an analysis that has no port can stop an unrelated server
- Severity: major   - Type: bug
- Evidence: `src/features/analysis/services/serverWatcherIntegration.ts:153-161`. `findAndStopServerForSession` falls back to `servers.find(server => server.customName?.includes('Analysis'))` and stops the first match. Server names are `XR File: <name>`, `XR Directory: <name>`, `LivePanel …`, or user-chosen names for Visualize Data.
- Failure scenario: an analysis still `analyzing`, or one in `error` (no port), is closed. Any running server whose target or visualization name contains "Analysis" is stopped, for example `AnalysisService.ts` or a data visualization called "Sales Analysis". Its session is marked closed and its watcher stopped, through `serverRemoved`.
- Confidence: CONFIRMED. `t4` case 2 printed `stopped: [ 'server-3001-1' ]` for a server named `XR File: AnalysisService.ts` that belonged to another session.
- Proposed fix: delete that fallback and the `htmlFile.includes(outputPath)` heuristic. Stop only by `metadata.sessionId` (always set by `ServerLaunchOrchestrator`). `ServerControl.closeAssociatedAnalysisSession` (`serverControl.ts:249-266`, substring matching both ways) gets the same fix. Test: the t4 case 2, asserting nothing is stopped.

### LAUNCHER-9: "Stop all" prompt, return value and toasts disagree
- Severity: minor   - Type: bug / ux (REPORT §9 "stopAllServers count-as-success" and "Stop all 20 server(s)?")
- Evidence:
  - `src/features/active-servers/views/handleServerActions.ts:425,433` prompts with `getAllServers().length` (every status).
  - `ServerControl.stopAllServers` (`core/server/serverControl.ts:160-205`) stops only `status==='running'` and returns a **count**.
  - `handleServerActions.ts:442-446` reads it as a boolean (`if (success)`), then toasts `Stopped all ${allServers.length} servers`.
  - Each `stopServer` adds its own "Server stopped" toast, and ServerControl adds a summary toast of its own.
- Failure scenario:
  - One of three fails. The user sees "Stopped 2/3 servers. Some servers may require manual intervention." and then "Stopped all 3 servers".
  - A non-running entry inflates the prompt: "Stop all 2 server(s)?" … "All 1 servers stopped successfully" … "Stopped all 2 servers".
  - About the 20-vs-13 report: I could not reproduce those exact numbers. Plausible contributors: LAUNCHER-1 (in HTTPS mode the registry ports are not the bound ports, so a comparison against `lsof` or `netstat` cannot match), LAUNCHER-2 (unregistered but still bound), LAUNCHER-4 and LAUNCHER-7 (extra or orphan servers), and the prompt counting all entries. The maintainer should say whether HTTP or HTTPS was in use.
- Confidence: CONFIRMED. `t5_stop_all.test.cjs` reproduced both transcripts.
- Proposed fix: return `{requested, stopped, failed[]}` from `ServerControl.stopAllServers`, with no toasts inside it. The handler prompts with the running count and shows exactly one summary. Pass `{silent:true}` to `stopServer` in bulk. Test: extend `test/servers/serverActionHandlers.test.cjs` goldens.

### LAUNCHER-10: no timeout or cancellation anywhere on the launch path, and a hung launch blocks every relaunch
- Severity: major   - Type: robustness (hang)
- Evidence:
  - `src/core/analysis/python/executePython.ts:438-497` `spawnAndCollect` has no timeout, no kill and no `AbortSignal`. stdin stays an open pipe.
  - `projectAnalysisCommands.ts` wraps the launch in a `withProgress` with `cancellable: false`.
  - `sessionRegistry.ts:57-67` treats `creating`/`analyzing` as duplicates: "Analysis … is already in progress".
  - The pipeline awaits `handleAutoOpening` (`multiServerLauncher.ts:197`), which for an HTTPS server in panel mode awaits a non-modal `showWarningMessage` (`serverOpenActions.ts:47`).
- Failure scenario: a Python run that never returns (huge file, a stalled Windows pipe, antivirus blocking the venv). The progress notification spins forever and the session stays `analyzing`. Every new attempt on that target is refused as "already in progress", and the user's only way out is Close Analysis, which leaks (LAUNCHER-7). The scene never loads.
- Confidence: LIKELY (traced; a real hang was not reproduced).
- Proposed fix: thread an `AbortSignal` through `executeLaunchPipeline` → `ExecutePython` (`child.kill()` on abort), plus a configurable launch timeout (for example 10 min, with a "still running…" progress message). Make the progress cancellable. Do not await auto-open inside the launch; fire it after `monitoring`. Test: a unit test with a fake Python that sleeps, asserting rejection within the timeout and the session moving to `error`.

### LAUNCHER-11: concurrent historical or project-evolution "start": check-then-act race, and the busy error goes to every peer
- Severity: minor (major in a shared room)   - Type: bug (race)
- Evidence:
  - `src/core/server/analysis/projectEvolutionBridge.ts:137` checks `isBusy()` synchronously, but the job only enters `SingleJobGate` after `await SessionWatcherManager.reconcileSession` (`:180-183`).
  - `historicalComparisonBridge.ts:139` behaves the same, with `reconcile` and `refreshMode` before `compare`.
  - The losing request's `project-evolution-busy` error is **broadcast** (`:214`). The scene's `handleError` (`templates/…/project-evolution/projectEvolutionRuntime/playbackControlsAndMessages.js:296-302`) stops playback, rejects the pending frame apply and shows "error" on every client while the first job is still running.
- Failure scenario: a double tap on Generate, or two collaborators. All clients flip to the error status mid-generation, and later the movie appears anyway. In historical compare, the second start also flips `setRefreshEnabled` for the first request.
- Confidence: CONFIRMED on the host side. `t8_evolution_double_start.test.cjs` printed `broadcasts: [ 'project-evolution-error:project-evolution-busy' ]` while the first job was running, then `upsert`.
- Proposed fix: take the gate synchronously, before the first `await`, by moving `reconcileSession` inside `jobs.run`. Send busy errors with `messageContext.send` to the requester only. Test: t8, asserting no broadcast error.

### LAUNCHER-12: `defaultPort` = 8080 (allowed by the UI) fails every launch when 8080 is busy
- Severity: minor   - Type: bug
- Evidence: `src/core/server/multiServerLauncher.ts:256` `PortManager.findAvailablePort(requestedPort + 1)` uses the default `endPort` 8080 (`portManager.ts:52-66`), which throws `Invalid end port 8080`. `handleConfigurationClicks.ts:110-118` allows 3000–8080.
- Failure scenario: the user sets the port to 8080, and Tomcat, Jenkins or another dev server holds it. Every analysis fails with "No available ports found starting from 8080". Combined with LAUNCHER-5, XR launches also fail silently and leak a watcher.
- Confidence: CONFIRMED. `t9_port8080.cjs` printed `THROWS: SERVER: Invalid end port 8080. Must be between 8081 and 65535`. The same message appeared in the t2 log.
- Proposed fix: `findAvailablePort(requestedPort + 1, Math.min(65535, requestedPort + 100))`. Test: a PortManager unit test.

### LAUNCHER-13: the port probe only checks `0.0.0.0` (risk of co-binding with a localhost dev server on macOS and Windows)
- Severity: major if confirmed   - Type: cross-platform bug
- Evidence: `src/core/server/portManager.ts:21-41` `isPortAvailable(port, '0.0.0.0')` is the first-choice path. The server then listens on `0.0.0.0` and the page is opened as `http://localhost:<port>`. On macOS (BSD bind semantics with `SO_REUSEADDR`) and on Windows, a wildcard bind can succeed while another process owns `127.0.0.1:3000` or `[::1]:3000`. That is the default for Vite, Next and CRA on port 3000, the Code-XR default. `localhost` then resolves to the other app.
- Failure scenario: macOS, with a React or Next dev server on `localhost:3000`. Code-XR "launches on 3000" and the browser or panel shows the other app. The XR scene never appears, and `/events` and the API return that app's 404s.
- Confidence: SUSPECTED. Linux refuses the co-bind, so this cannot be reproduced here; the maintainer needs to check on macOS and Windows.
- Proposed fix: probe the way get-port does, across `undefined`/`::`, `0.0.0.0` and `127.0.0.1` (get-port already does this; use it for the first port too). Or bind with `exclusive:true` and port 0 retry, and use the bound port from `server.address()` (which also fixes LAUNCHER-1).

### LAUNCHER-14: startup cleanup deletes a folder nothing writes, so the real analysis folders grow without bound
- Severity: minor   - Type: bug
- Evidence: `src/features/analysis/commands/cleanAnalysisCommands.ts:63` cleans `storage/analysis`. Sessions write to `storage/fileAnalysis|directoryAnalysis/<…>` (`sessionRegistry.ts:155-156`, `utils/saveFiles.ts:50`) and `storage/visualizeDOMAnalysis/<…>` (`launcherVisualizeDOM.ts` `folderName`). `ServerLaunchOrchestrator.getTempDirForSession` (`:127-130`) still points at `storage/analysis/<sessionId>`, a dead fallback.
- Failure scenario: every analysis keeps its data, dependency datasets, comparison revisions and evolution frames in workspace storage forever, across reloads, because sessions are in-memory only. The REPORT §10 A.2 check ("stale folders in analysis/ are removed") is vacuously true.
- Confidence: CONFIRMED (traced: the only writers into storage are the two listed; `grep 'analysis'` finds no other writer).
- Proposed fix: point cleanup at the three real roots, skipping folders of sessions alive in this activation, and delete `getTempDirForSession`. Test: create stale folders under `fileAnalysis/` and `directoryAnalysis/`, run `executeStartupCleanup`, assert they are gone.

### LAUNCHER-15: Windows: the DOM backend writes non-ASCII JSON to a cp1252 pipe and crashes; stdout decoding splits UTF-8
- Severity: major (Windows only, VisualizeDOM)   - Type: cross-platform bug
- Evidence: `backend/src/html/html_dom_parser.py:64` `print(json.dumps(result, ensure_ascii=False, indent=2))`. `src/core/analysis/python/executePython.ts:448-452` spawns with `env: process.env` and no `PYTHONIOENCODING`/`PYTHONUTF8`. On Windows a piped stdout uses the ANSI code page. `:470` `stdout += data.toString()` also decodes each chunk on its own, so a multi-byte character across a 64 KB boundary becomes U+FFFD. That affects every analysis with accented paths, for example a user folder named "Adrián".
- Failure scenario: Windows, "Visualize DOM" on any HTML containing `→`, emoji, CJK and so on gives `UnicodeEncodeError: 'charmap' codec can't encode character '\u2192'`, and the launch fails. Accented Latin characters come back mangled.
- Confidence: CONFIRMED by simulation: `PYTHONIOENCODING=cp1252 python3 backend/src/html/html_dom_parser.py <html with →>` printed the traceback and exited 1. The chunk split is LIKELY.
- Proposed fix: spawn with `env: {...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'}`, and use `child.stdout.setEncoding('utf8')` (StringDecoder-safe). Test: a unit test feeding a split multi-byte buffer, plus a Windows CI job for the DOM fixture.

### LAUNCHER-16: a registrar failure still reports success, and the server leaks (re-check of the deferred item)
- Severity: minor   - Type: robustness
- Evidence: `src/core/server/multiServerLauncher.ts:156-202`. A throw inside the `try` (`registerServer` **or `handleAutoOpening`**) is logged as "Failed to register" and the launch returns `success:true` with `activeServerId` undefined. The server is listening, but nothing can find it to stop it.
- User impact: low in practice, since `registerServer` does not throw today and auto-open catches its own errors. If it ever does, the result is an unstoppable server on `0.0.0.0`. It is pinned by the golden test "registration fails: the launch still succeeds".
- Confidence: LIKELY (code plus the existing golden).
- Proposed fix: if registration fails, `stop()` the instance and return `success:false`. Move auto-open out of the try. Update the golden.

### LAUNCHER-17: session, SSE and server identity are raw path strings
- Severity: minor   - Type: cross-platform robustness
- Evidence: `sessionRegistry.ts:62` `session.targetPath === params.targetPath`; `fileToServerMap` keys; `SSEManager` keys. Entry points produce paths differently: `uri.fsPath` (lower-case drive letter on Windows), `path.resolve(workspaceFolder.uri.fsPath, rel)` (`filesByLanguageCommands.ts:94-105`), and Python-supplied paths (project-by-language).
- Failure scenario: on Windows, or on case-insensitive macOS volumes, `C:\proj\a.ts` and `c:\proj\a.ts` are two targets. The duplicate guard is bypassed, which feeds LAUNCHER-3 and LAUNCHER-4.
- Confidence: SUSPECTED (depends on what each producer returns; not verified on Windows).
- Proposed fix: one `normalizeTargetKey(p)` = `path.resolve(p)` plus `toLowerCase()` on win32 (and on darwin when the volume is case-insensitive), used for every identity key. Keep the original string for display and spawning.

### LAUNCHER-18: `SessionServerManager` is a per-launch throwaway, so its stop and notify paths are dead or wrong
- Severity: minor   - Type: architecture / dead code
- Evidence: `launchPipeline.ts` does `new SessionServerManager(context)` per launch, so its `activeSessions` map dies with the launch. `ServerLaunchOrchestrator.stopServerForSession` (`:112-121`) only unregisters the file map and never stops the server. `directoryReAnalyzer.sendSSENotification`'s fallback `notifyAnalysisUpdated` therefore always no-ops. Its `isWatcherActive: true` is a constant ("Asumimos…").
- Impact: none today, but anyone calling "stop server for session" through it believes it worked. Fold it into the unified launcher (§4).

### Smaller observations (not separate findings)
- **Doubled toasts.** `projectByLanguageCommands.ts:179-186` toasts "Started … analysis" *after* the awaited launch, including when it was refused as a duplicate or failed. A DOM failure toasts twice: the pipeline's "Failed to start analysis", then a rethrow caught by the command. A session-creation error toasts in the orchestrator and again in the command wrapper.
- **Five copies of mode selection.** The "which mode for this file or directory" `switch` exists in 5 places (`filesByLanguageCommands`, `projectByLanguageCommands` ×2, the command classes), and the XR project command has no progress UI while the LivePanel project command does.
- **Path guard.** `staticAssets.ts:94` uses `startsWith(staticRoot)` without a separator, so a sibling folder sharing the prefix passes. It is low risk because folder names carry nonces; use `path.relative`.
- **Deactivate leaves servers running.** `extension.ts:109-141` deactivate does not stop running servers or watchers. Only `cleanupInactiveServers`, which does nothing to running ones, is called. Process exit hides this on a full shutdown, but not on a host restart while sockets linger in TIME_WAIT.

## 3. Current launch paths (map)

### 3a. Host-side launch, per entry

| Entry | Mode / target | Launcher → pipeline config | Order | Data producer | Scene / page assets | Server features |
|---|---|---|---|---|---|---|
| `analyzeFileXR`, files-by-language (mode XR) | XR / file | `LauncherXRAnalysis.launchFileXRAnalysis` (chart plus mapping validation in `preValidation`) | watcher → server | Python file metrics → `fileXRParser` (writes `outputPath`, `copyToOutput`, `singleFileRuntimeAssets`) | `fileAnalysis.html`/`index.html` plus the single-file runtime list | XR caps: dep, hist, evol |
| `analyzeDirectoryXR[Deep]`, `analyzeProjectXR[Deep]`, project-by-language (XR) | XR / dir | `launchDirectoryXRAnalysis` | watcher → server | Python dir metrics → `directoryXRParser` (hard-coded list of 37 `*_OUTPUT_NAME` runtime assets) | `directoryAnalysis.html` plus about 20 runtimes | XR caps |
| `analyzeFileLivePanel`, files-by-language (LivePanel) | LP / file | `LauncherLivePanel.launchFile…` (hash preValidation, theme) | watcher → server | Python → `livePanelParser` | LivePanel bundle | dep + hist (LP pushes over SSE) |
| `analyzeDirectoryLivePanel[Deep]`, `analyzeProject[Deep]` (withProgress) | LP / dir | `launchDirectory…` | watcher → server | same | same | dep + hist, forced background dep refresh |
| DOM command, files-by-language (HTML) | DOM / file | `LauncherVisualizeDOM` (`rethrowErrors`, `setEndTime`) | **server → watcher** | `html_dom_parser.py` → `visualizeDOMParser` | babia-html page | none |
| Visualize Data, BabiaXR examples, "Launch server" | (no session) | `launchServerWithFile` / `MultiServerLauncher` directly | server only | none, or JSON in place | user or example HTML | none (static plus collaboration) |

### 3b. The four in-scene XR analyses (same server, switched by the controller)

| Analysis | Scene → host | Host service | Data delivered via | Refresh |
|---|---|---|---|---|
| classic (`single`) | WS `analysis-mode-activate {mode:'single'}` | none; the watcher re-analysis (`directoryReAnalyzer` / `reAnalysisManager`) | `./data.json`, SSE `/events` `dataRefresh` (keyed by targetPath) | watcher → coordinator `single` handler |
| dependency-graph | WS `analysis-mode-activate`, then `dependency-graph-start`, `-settings`, `dependency-file-scope-request`; LP uses REST `/api/dependency-graph/summary` | `DependencyGraphService` (through `DependencyGraphBridge`) | room entity `dependency-graph{datasetUrl}` → `/dependencies/dependency-graph-<rev>.json` written into staticRoot; LP gets SSE `dependency-updated` | coordinator `dependency-graph` handler (registered by `AnalysisFeatureHost`) |
| historical-compare | WS `historical-comparison-references-request`, `-start`; LP uses REST `/api/historical/references`, `/compare` | `HistoricalComparisonService` + `GitAnalysisSourceCatalog` | room entity `historical-comparison{result}` → `./comparison/revision-N.json`; progress broadcast | `analysisUpdateEvents` → `scheduleHistoricalComparisonRefresh` (350 ms debounce) |
| project-evolution | WS `project-evolution-references-request`, `-start`, `-apply-frame`, `-clear` (XR only) | `ProjectEvolutionService` | room entity `project-evolution{result/resultUrl}`; frames applied server-side (`applyFrameToBridge`) | refresh **disabled** at start (`setRefreshEnabled(false)`); a static movie |

### 3c. Duplication and divergence
- **Two "launch" concepts.** Session-bound launches go through the pipeline. Session-less launches (Visualize Data, examples, the "launch server" command) call `MultiServerLauncher` directly, with their own naming and no teardown hook.
- **Five-plus places choose the mode.** Three ways name a project: `analyzeProject*` (LP) and `analyzeProjectXR*` (XR) via two different classes, plus project-by-language.
- **Step order differs per launcher.** It is watcher → server for XR and LP and server → watcher for DOM, so the failure semantics differ too. XR and LP set `error` silently (LAUNCHER-5); DOM throws and double-toasts.
- **Ports are resolved twice for HTTPS** (LAUNCHER-1), and identity is keyed three ways: sessionId (registry, coordinator), targetPath (file map, SSE, duplicate check) and port (`findFileByPort`, `handleServerRemoved`, `closeAssociatedAnalysisSession`). Most of the bugs above come from these keys disagreeing.
- **Teardown is spread over four places** that partly overlap: `ServerControl.stopServer`, `ServerWatcherIntegration` (an event on `serverRemoved`, matched by port), `activeAnalysesCommands.closeAnalysis` (manual cleanup, then remove), and `AnalysisFeatureHost.dispose` (wipes the coordinator state for the session, including the watcher's handlers). None of them aborts an in-flight launch.
- **Scene-asset lists are hand-maintained twice**: `directoryXRParser` imports 20 assets and `singleFileRuntimeAssets` keeps a second list. Server capabilities sit in a third table, `analysisServerCapabilities.ts`. Adding an analysis type touches about seven files: the parser lists, capabilities, `AnalysisFeatureHost`, `AnalysisMessageRouter`, a new bridge, `SNAPSHOT_PROBE_BY_MODE`, `analysisViewModes`/the coordinator `MODES`, and the runtime option registration.
- **The scene sends without acknowledgement.** The switcher's `client?.sendMessage?.('analysis-mode-activate', …)` (`templates/components/codexr/analysis-mode/analysisModeRuntime/selectorAndPanel.js:130-131`) gets no ack and has no timeout. If the room socket is not connected (an HTTPS certificate not accepted for wss, or a remote guest), the mode switches locally and the host never learns. The scene then waits on an entity that never arrives; this is one source of "stuck loading".

## 4. Design: one modular launcher and registry

### 4a. Two descriptors and one lifecycle

```ts
// core/analysis/launch/targetKey.ts
export function targetKey(p: string): string  // path.resolve + win32/darwin case fold (LAUNCHER-17)

// core/analysis/launch/launchKinds.ts — HOW something is produced and served (XR | LivePanel | VisualizeDOM | future)
export interface LaunchKind {
  id: 'XR' | 'LivePanel' | 'VisualizeDOM' | string;
  targets: ReadonlyArray<'file' | 'directory'>;
  eligibility(target: LaunchTarget, ctx): Promise<Eligibility>;            // language support, chart+mapping validation, HTML-only…
  produce(target, session, signal: AbortSignal): Promise<ProducedPage>;    // Python + parser; returns files + mainHtml + assetManifest
  watch?: (session, signal) => Promise<WatcherHandle>;                    // file/dir watcher; handle.dispose()
  capabilities: ReadonlyArray<AnalysisTypeId>;                            // which in-scene analyses the server attaches
  progress: ProgressPlan;                                                  // replaces the per-launcher percentages
  folderName: string;                                                      // storage root (also feeds startup cleanup, LAUNCHER-14)
}

// core/analysis/launch/analysisTypes.ts — WHAT an in-scene analysis is (single | dependency-graph | historical-compare | project-evolution | future)
export interface AnalysisTypeDescriptor {
  id: AnalysisTypeId;                       // also the coordinator mode and the room entityKind root
  label: string;
  available(sessionCtx): Availability;      // replaces resolveAnalysisServerCapabilities + getAvailability()
  sceneAssets: RuntimeAssetRef[];           // replaces hard-coded lists in directoryXRParser/singleFileRuntimeAssets
  createService(sessionCtx): AnalysisService;   // DependencyGraphService / HistoricalComparisonService / …
  messages: Record<string, MessageHandler>;     // 'dependency-graph-start' etc., routed by a generic router
  rest?: Record<string, RestHandler>;           // '/api/historical/compare' …
  snapshotProbe?: { entityKind: string; isAvailable(e): boolean; allowsEmptyShell: boolean }; // replaces SNAPSHOT_PROBE_BY_MODE
  refresh?: { handler(batch): Promise<void>; background?: boolean; enabledByDefault: boolean };
  controllerView: { default: string; onSnapshot?: string };                 // replaces analysisViewModes
}

interface AnalysisService { isBusy(): boolean; run<T>(req, job: () => Promise<T>): Promise<T>; dispose(): Promise<void>; }
```

### 4b. `LaunchRegistry` replaces UnifiedSessionRegistry, SessionServerManager, fileToServerMap and the session parts of ServerControl

```ts
class LaunchRegistry {
  launch(kind, target, opts): Promise<LaunchHandle>      // synchronous reservation by key = `${kind}|${targetKey}|${depth}` (LAUNCHER-4)
  get(sessionId) / byKey(key) / byServerId(id)           // ONE identity: sessionId; port is just an attribute (LAUNCHER-1/3)
  close(sessionId, reason): Promise<CloseReport>         // the only teardown entry point
}
interface LaunchHandle {
  session: Session;
  abort: AbortController;                     // Close during analysis aborts (LAUNCHER-7/10)
  resources: Disposable[];                    // pushed as each step succeeds: watcher, server, sse channel, feature host
  state: 'reserved'|'producing'|'serving'|'monitoring'|'failed'|'closed';
}
```

Pipeline (one function, used by every kind):

```
reserve(key)                       -> throws Duplicate synchronously
eligibility()                      -> fail fast, nothing to undo
produce(signal)  [timeout + abort] -> files saved under storage/<folderName>/<sessionDir>
server = startServer(session)      -> bound port read from server.address(); feature host built AFTER listen
resources.push(server)
watcher = kind.watch?.(signal)     -> AFTER the server, so a server failure never leaves a watcher (LAUNCHER-5)
resources.push(watcher)
state = monitoring; openPage() fire-and-forget (not awaited)
on ANY error/abort: dispose resources in reverse; state=failed; ONE toast; keep a failed entry for display only
```

Server and SSE changes:
- `/events` and SSE resolve by `config.analysisSessionId`. `SSEManager.send(sessionId, …)`, with an index `targetKey → Set<sessionId>` for the watchers.
- `ServerControl.stopServer(serverId)` becomes `LaunchRegistry.close(sessionId)` whenever the server has a session; plain servers keep the current path.
- `stopAllServers` returns a report (LAUNCHER-9).
- `forceStop` really closes the listener (LAUNCHER-2).

Router:
- `AnalysisMessageRouter` becomes a table lookup over `AnalysisTypeDescriptor.messages` for the types the session's kind declares. "Not available" replies are automatic.
- The busy gate is taken synchronously in the generic dispatcher (`service.run`). Busy goes back to the requester only (LAUNCHER-11).

Scene assets: the parsers ask `assetsFor(kind, enabledTypes)` (union of `sceneAssets`) and stop keeping their own lists.

Adding a fifth analysis type then means one descriptor file, its runtime folder and its service.

### 4c. Migration steps (behaviour-preserving, each step shippable and testable)
1. **Fix the confirmed bugs that need no redesign**, each with its scratch test promoted into `test/servers/` or `test/analysis/`: LAUNCHER-2, 6, 8, 9, 11, 12, 15, and LAUNCHER-1 (bound port from `server.address()`).
2. **Introduce `targetKey` plus synchronous reservation** in `createSession` (LAUNCHER-4, 17).
3. **Make the pipeline transactional.** Add a `resources` stack and `AbortController` to `executeLaunchPipeline`, switch the order to server → watcher for all kinds, and give Close Analysis the abort (LAUNCHER-5, 7, 10). Existing launcher tests (`launcherClosures.test.cjs`, `analysisOrchestratorDuplicate.test.cjs`) pin the per-kind configs.
4. **Re-key SSE and the file map by sessionId** (LAUNCHER-3). Keep the `fileToServerMap` API as a thin adapter during the transition. `livePanelSse.test.cjs` and the xr-mode harness verify it.
5. **Extract `LaunchKind` descriptors** from the three launchers and the five mode-selection `switch`es. The orchestrator becomes `registry.launch(kinds[mode], target)`.
6. **Extract `AnalysisTypeDescriptor`s** from `analysisServerCapabilities.ts`, `AnalysisFeatureHost` (constructor branches), the three bridges, `SNAPSHOT_PROBE_BY_MODE`, `analysisViewModes` and the parsers' asset lists. Run `analysisMessageRouter.test.cjs`, `analysisServerCapabilities.test.cjs`, `analysisModeMegatest.test.cjs` and the four Playwright harnesses unchanged.
7. **Fold teardown together.** Move `SessionServerManager`/`ServerLaunchOrchestrator`/`ServerWatcherIntegration` port matching into `LaunchRegistry.close`, delete the dead paths (LAUNCHER-14 fallback dir, LAUNCHER-18), and point startup cleanup at the `LaunchKind.folderName`s.

### 4d. Cross-platform rules for the new code
- Identity: `targetKey()` only; never compare raw `fsPath`.
- Files: `path.join`/`path.relative` and the `!rel.startsWith('..' + sep) && !isAbsolute(rel)` containment check; URLs built with `/` explicitly from `rel.split(path.sep)`.
- Ports: bind once with port 0 retry or exclusive probing across `::`/`0.0.0.0`/`127.0.0.1`, read `server.address().port`, and treat the port as display data only.
- Python: always `PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8`, decode with `setEncoding('utf8')`, and kill the child on abort. Use `taskkill /T` on Windows if the backend ever spawns children.

## 5. Status of the REPORT §9 deferred items in this area
| Item | Real user-facing bug? |
|---|---|
| Same target in two modes → `/events` 404 | **Yes**, confirmed (LAUNCHER-3). It also happens with XR plus XR-deep and with a double click (LAUNCHER-4), and it cross-wires SSE. |
| "Stop all 20 server(s)?" while 13 ports open | The prompt and count mismatch is confirmed (LAUNCHER-9). The exact numbers are most plausibly HTTPS port drift (LAUNCHER-1) plus orphan or leaked listeners (LAUNCHER-2, 7); the maintainer should say which server mode was in use. |
| `stopAllServers` count-as-success | **Yes**: contradictory toasts (LAUNCHER-9). |
| `forceStop` on HTTPS leaves the listener | **Yes**, and on **HTTP too**. `stop()` cannot recover it afterwards (LAUNCHER-2). |
| Registrar failure reports success | Real but practically unreachable today (LAUNCHER-16). |

Needs the maintainer's eyes (no VS Code, headset, macOS or Windows here): LAUNCHER-13 (macOS/Windows co-bind), the Windows half of LAUNCHER-15/17, and whether the forceStop path is hit in practice (look for "did not shut down cleanly" in the CodeXR output).
