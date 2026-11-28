# Agent Flow (XR)

The fifth analysis type (mode id `agent-flow`, controller view `agent-flow`,
accent `#10b981`; epic #319). It replays or follows an AI coding agent's
session on the analysis table: the analysed folder is drawn as a city and the
agent's steps (read, search, write, execute) walk it in order. Design and
related work: `docs/agent-flow/research.md` (repository root). Manual test
guide: `docs/agent-flow/test-guide.md`.

## Pipeline

```
trace sources ──► AgentTraceEvent[] ──► buildAgentFlowDataset ──► agent-flow/agent-flow-<rev>.json
 (transcripts,      (one shared            (city layout, steps,       + room entity `agent-flow`
  IDE chats)         event model)           turns, metrics, deltas)    ──► agentFlowRuntime.js
```

| Layer | Where | Notes |
|---|---|---|
| Event model and dataset contract | `src/core/agent-flow/agentFlowModels.ts` | No imports. `AGENT_FLOW_SCHEMA_VERSION` is 1 |
| Sources | `claudeCodeTranscript.ts`, `codexRollout.ts`, `acpSessionEvents.ts`, `agentTraceSources.ts` | Claude Code (`~/.claude/projects`), Codex (`~/.codex/sessions`), live push sources registered by a host (the IDE's chats) |
| Shell classification | `shellCommandClassifier.ts` | `cat`/`rg`/`sed -i`/`apply_patch`… become read, search or write steps instead of opaque executes |
| City layout | `agentFlowLayout.ts` | Squarified treemap, single-folder chains collapsed; a 16% strip on the right always reserved for files outside the analysis, so base buildings never move |
| Builder | `agentFlowBuilder.ts` | Pure. Budget of 900 files. Metric deltas prefer the live re-analysis, then per-turn deltas, then diff line counts |
| Service | `agentFlowService.ts` | One per scene. Follows a source, rebuilds (throttled) into `agent-flow/`, keeps 3 revisions, publishes the entity. Module registry: `openAgentFlowInScenes(root, sourceId)` |
| Room bridge | `src/core/server/analysis/agentFlowBridge.ts` | `agent-flow-sources-request`, `agent-flow-open`, `agent-flow-close` → `agent-flow-sources` / `agent-flow-error`. Guests see only the active source and cannot open or close |
| Host wiring | `analysisFeatureHost.attachAgentFlow` | Folder and project analyses only. Re-analysis refreshes call `requestRefresh()` |
| Browser runtime | `templates/components/codexr/agent-flow/agentFlowRuntime/` | Multi-part runtime assembled to `agentFlowRuntime.js`; loaded after `dependencyGraphRuntime.js` |

All of `src/core/agent-flow/` is vscode-free and uses erasable TypeScript
only (no parameter properties, no enums, `type` on type-only imports): the
IDE imports it as `@codexr/core/agent-flow/*` and its tests load it with
Node's type stripping.

## Hosts

- **VS Code extension**: the AI Agents sidebar section lists recent sessions
  of the workspace and **Watch an agent in XR**; the command
  `codeXR.agentFlow.watch` starts the project XR analysis when no scene is
  open, waits for it, and opens the session
  (`src/features/ai-agents/commands/agentFlowCommands.ts`).
- **Code-XR IDE**: `apps/ide/src/main/agentSessions/agentFlowFeed.ts` turns
  each chat's session events into a live push source (`ide-chat:<sessionId>`)
  for the chat's project, rewriting worktree paths onto the project; the chat
  header's **Watch in XR** opens it in the scenes of that project.

## Privacy

Transcripts are read locally and never leave the machine. The dataset holds
relative paths, tool names, short titles, the first 160 characters of each
prompt and command lines; it holds no file contents and no assistant text.
The scene shows the folder name, never an absolute path.

## Tests

`test/analysis/agentFlowCore.test.cjs`, `test/analysis/agentFlowRuntime.test.cjs`,
`apps/ide/test/agentFlowFeed.test.ts`; the scripted session in
`test/manual/agent-flow/sampleSession.cjs` drives the runtime test and the
screenshot harness `test/manual/agent-flow-harness.html`.
