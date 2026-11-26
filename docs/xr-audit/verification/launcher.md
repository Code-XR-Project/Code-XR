# Verification: launcher area (LAUNCHER-1..18)

Branch v1.2.1 @ 6f827a19, `/home/user/Code-XR`. Compiled `apps/vscode-extension/out` (built 2026-11-26 10:02) used as-is; nothing in the repo was modified.
Scratch: `<scratch>/launcher/` (copied repros t1..t9, plus new probes `v2_https_port.test.cjs`, `v6.test.cjs`, `probes.test.cjs`, `probes2.test.cjs`).

Several original repros assert the BROKEN behaviour, so on the fixed code they "fail". Each one's result was read against its intent (inverted) and, where the code moved (`SessionServerManager` deleted, `SingleJobGate` replaced by `JobRunner`), re-written as a probe against the current code path.

| ID | Sev | Verdict | Evidence (short) |
|---|---|---|---|
| LAUNCHER-1 | G | FIXED (verified by run) | `v2_https_port.test.cjs` (t2 with an inverted assertion) uses the real `MultiServerLauncher` and `HttpsDefaultServer` with the default port busy. Output: `result.port=7295 url=https://localhost:7295 actual listen port=7295`, `7296/7296`, and `registered==bound` for every server. Before the fix it printed 7440 vs 7441. |
| LAUNCHER-2 | G | FIXED (verified by run) | t1 case 1: `connect after forceStop: false after stop(): false`. Its "BUG" assertion now fails, which is the inversion. HTTPS: `probes.test.cjs` L2 shows `connect before true after forceStop false`. Code: `httpServer.ts:230-242` and `httpsServerBase.ts:107-119` call `server.close()`. |
| LAUNCHER-3 | G | FIXED (verified by run) | Original t1 case 2 still prints a 404, but it registers the map by targetPath by hand, which the product no longer does. New probe `probes.test.cjs` L3 runs the real `ServerLaunchOrchestrator` twice on one target (XR plus LivePanel). Output: `A-before-B 200, A-after-B 200, B 200`; `refresh(sB) reached A? false, reached B? true`; after stopping B, A's `/events` is still 200. The map and SSE are keyed by sessionId (`serverLaunchOrchestrator.ts:83-93`, `reAnalysisManager.ts:55`, `directoryReAnalyzer.ts:271`, `analysisFeatureHost.ts:419-424`). |
| LAUNCHER-4 | G | FIXED (verified by run) | t3 case 1: `kinds: created duplicate sessions: 1` (inverted). `probes.test.cjs` L4 adds a directory case (`dir/` vs `dir`): `created duplicate`. Repo test `launchTransaction.test.cjs` also passes. |
| LAUNCHER-5 | G | FIXED (verified by run) | `probes.test.cjs` L5: the server fails, giving `watcher: 0` and `status error`, with exactly one toast: `"Failed to start analysis: Port 3005 busy (probe)"`. The pipeline now runs server then watcher (`launchPipeline.ts:155-161`). |
| LAUNCHER-6 | m | FIXED (verified by run) | t6 run with forced exit: `launch success: false … coordinator handlers left: undefined listeners: undefined` (the BUG assertion inverts). `serverFactory.ts:219-237` calls `forceStop()` in the catch. The original t6 hung only because its own `blocker` was never closed after the inverted assertion threw. |
| LAUNCHER-7 | G | FIXED (verified by run) | `probes.test.cjs` L7 runs the real Close flow (`triggerManualCleanup` then `removeSession`) during Python. Result: `server: 0, watcher: 0`, no toasts. `LaunchControl.close` is in `serverWatcherIntegration.ts:137`. |
| LAUNCHER-8 | G | FIXED (verified by run) | t4 case 2: `stopped: [] unrelated id: server-3001-1` (the "BUG reproduced" assertion now fails). `serverWatcherIntegration.ts:154-166` matches only on `metadata.sessionId`. `serverControl.ts` dropped the substring matching (comment at :238). |
| LAUNCHER-9 | m | FIXED (verified by run) | t5 transcripts. With 1 of 3 failing: `Stop all 3 server(s)?`, one per-server "did not shut down cleanly" warning, then `Stopped 2 of 3 server(s)…`, and no contradictory "Stopped all 3". With a non-running entry: `Stop all 1 server(s)?` then `Stopped 1 server(s)`. The t5 "BUG" assertions fail, which is the inversion. |
| LAUNCHER-10 | G | FIXED (verified by run) | `probes.test.cjs` L10: hung `processRequirements`, `timeoutMs: 200`. It resolved after 202 ms with `status error` and toast `"The analysis took too long and was stopped."`, and an immediate relaunch gives `created`, not "already in progress". Python is killed on abort (`executePython.ts:460-471`). The default deadline is 10 min (`launchControl.ts:24`). |
| LAUNCHER-11 | m | FIXED (verified by run) | t8 rewritten as `probes2.test.cjs` L11 with the real `ProjectEvolutionBridge` and `JobRunner` (`SingleJobGate` no longer exists). While the first job runs, the requester gets `sends: ['project-evolution-error:project-evolution-busy']` and `broadcasts: []`; after the run, `['upsert']`. Historical compare uses the same pattern (`historicalComparisonBridge.ts:174-188`, by code reading). |
| LAUNCHER-12 | m | FIXED (verified by run) | Original t9 still throws `Invalid end port 8080`, but it calls `PortManager.findAvailablePort(8081)` with the default end, which the launcher no longer does. The launcher passes `Math.min(65535, requestedPort + 100)` (`multiServerLauncher.ts:305-308`). `probes.test.cjs` L12: the 8080 window gives `8081`, and a really busy dynamic port P gives `P+1`. |
| LAUNCHER-13 | G? | FIXED (verified by code reading); platform behaviour still to be confirmed by hand | `portManager.ts:22-63` probes the first port on `0.0.0.0`, `127.0.0.1` and `::1` with `exclusive:true`, and get-port is called without a host. The `[::1]`-only probe was skipped because this container has no IPv6 loopback, and Linux refuses the IPv4 co-bind anyway. The co-bind on macOS/Windows is not covered by any row of `manual-test-guide.md`. Residual: the manual fallback scan (`portManager.ts:141`) still probes `0.0.0.0` only; it runs only when get-port throws. |
| LAUNCHER-14 | m | FIXED (verified by run) | `probes2.test.cjs` L14 ran `CleanAnalysisCommands.executeStartupCleanup`: stale folders under `fileAnalysis/`, `directoryAnalysis/`, `visualizeDOMAnalysis/` and legacy `analysis/` were all gone (`left: []`). The launchers and cleanup share `launch/storageFolders.ts`. |
| LAUNCHER-15 | G (Win) | FIXED (verified by run, Windows simulated) | `probes2.test.cjs` L15 runs `html_dom_parser.py` on `→ á` plus an astral-plane emoji (U+1F600). With a cp1252 stdout it exits 1; with the env ExecutePython now sets (`PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`, `executePython.ts:454`) it exits 0 with the arrow intact. `stdout.setEncoding('utf8')` is at `:475`. That is the only `spawn` under `core/analysis`. A real Windows run is not done. |
| LAUNCHER-16 | m | FIXED (verified by run) | Repo test `test/servers/multiServerLauncher.test.cjs` "registration fails: the server is stopped and the launch fails" passes (21/21). Code: `multiServerLauncher.ts:233-245` (discard plus `success:false`), and auto-open is outside the try (`:250`). |
| LAUNCHER-17 | m | FIXED (verified by run) | `targetKey` (`launch/targetKey.ts`): `C:\proj\a.ts` equals `c:\proj\A.ts\` on win32, darwin folds case, linux keeps it (node one-liner printed `true true true`). Used by the duplicate check (`sessionRegistry.ts:63-66`). SSE and the server map no longer use paths at all (sessionId). |
| LAUNCHER-18 | m | FIXED (verified by code reading) | `SessionServerManager` is gone from `src` and `out` (t3 and t4 fail with MODULE_NOT_FOUND for exactly that reason). `ServerLaunchOrchestrator.stopServerForSession` no longer exists. `directoryReAnalyzer.sendSSENotification` sends by `session.id` (`:262-279`). |

**Counts:** 18 FIXED (16 by run, 2 by code reading: LAUNCHER-13 and LAUNCHER-18). 0 STILL FAILING, 0 PARTIAL.

## Still failing / partial

None. Residual notes (not regressions, no new issue strictly needed):

- **LAUNCHER-13:** needs a hand check on macOS/Windows (a Vite dev server on `localhost:3000`, then launch Code-XR on 3000). No manual-test-guide row covers it. Optional issue: "Manual check: Code-XR port probe vs a localhost dev server on macOS/Windows (LAUNCHER-13)". The get-port failure fallback still probes `0.0.0.0` only.
- **LAUNCHER-9:** in a bulk stop, each failed server still shows its own "did not shut down cleanly" warning, in addition to the summary (only success toasts are silenced). The messages are consistent; this is cosmetic.
- **LAUNCHER-10:** auto-open is still awaited inside the launch (`multiServerLauncher.ts:250`). The only blocking prompt (HTTPS in a panel) is unreachable because HTTPS plus panel is overridden to HTTP (`serverFactory.ts:66-77`), and the 10-min deadline bounds it anyway.
- **Repro scripts:** the original t1 case 2, t2, t3, t4 case 1, t8 and t9 are stale against the current code: moved modules, hand-made targetPath mappings, and `server.close()` after `forceStop()` nulls `server`. Use the probes above instead.

## Commands run

```
export PATH=/opt/node24/bin:$PATH; unset NODE_OPTIONS
cd <scratch>/launcher
node --test t1_server_stop_and_events.test.cjs        # L2 inverted-pass; case 2 stale (manual targetPath map)
node --test t2_https_port_mismatch.test.cjs            # hung on teardown (forceStop + server.close on null) -> replaced by:
node --test v2_https_port.test.cjs                     # L1 pass
node --test t3_session_race_and_pipeline.test.cjs      # case1 'created duplicate' (L4 inverted); case2 MODULE_NOT_FOUND (L18)
node --test t4_close_while_analyzing.test.cjs          # case2 stopped [] (L8 inverted); case1 MODULE_NOT_FOUND
node --test t5_stop_all.test.cjs                       # L9 transcripts
node --test --test-force-exit v6.test.cjs              # L6 (t6 + exit)
node --test --test-force-exit t7_concurrent_launch.test.cjs   # informative: 10/10 pairs got distinct ports
node --test --test-force-exit t8_evolution_double_start.test.cjs  # SingleJobGate gone -> probes2 L11
node t9_port8080.cjs                                   # PortManager default still throws; launcher no longer uses default
node --test --test-force-exit probes.test.cjs          # L3 L4 L5 L7 L10 L12 L2-https pass; L13 skipped (no IPv6)
node --test --test-force-exit probes2.test.cjs         # L11 L14 L15 pass
cd /home/user/Code-XR/apps/vscode-extension
node --test --test-force-exit test/analysis/launchTransaction.test.cjs     # 15/15
node --test --test-force-exit test/servers/multiServerLauncher.test.cjs    # 21/21
node --test --test-force-exit test/analysis/crossPlatformOffline.test.cjs  # 5/5
node -e "...targetKey win32/darwin/linux..."           # true true true
```
