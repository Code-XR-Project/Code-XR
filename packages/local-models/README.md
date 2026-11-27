# @codexr/local-models

Local models as Code-XR agents (epic #310): people bring their own model served by Ollama, LM Studio, llama.cpp (`llama-server`), vLLM, Jan, LocalAI or any OpenAI-compatible server, and code with it like with Claude Code or Codex.

Shared by both hosts (product rule: every feature in the IDE **and** the VS Code extension). Every module here is plain TypeScript with **no Node, Electron, DOM or `vscode` import**; anything that touches the network or the disk is injected by the host.

| Module | What it holds |
|---|---|
| `src/servers.ts` | Server presets (default URL, how to start it), endpoint validation (`normalizeLocalBaseUrl`: http only to this machine or a private network, no credentials in the URL) |
| `src/discovery.ts` | `listLocalModels` (OpenAI `/v1/models`, plus Ollama's `/api/tags` for sizes) and `detectLocalServers` (probes the presets' default ports on 127.0.0.1, only when asked) |
| `src/agentLoop.ts` | `runAgentTurn`: the tool loop (stream, run tools, feed results back), falling back to plain chat when the server says the model has no tool support |
| `src/tools.ts` | The coding tools' JSON Schemas (`read_file`, `list_directory`, `find_files`, `search_text`, `write_file`, `edit_file`, `run_command`), `applyEdit`, `globToRegExp`, `numberLines`, the system prompt |

## Consumers

- **Code-XR IDE** (`apps/ide`): imported as `@codexr/local-models/<module>.ts` (alias in `scripts/viteConfigs.mjs`, `tsconfig.*.json` and the unit-test loader). The IDE ships the local agent as an ACP agent, `out/localAgent/index.cjs`, so local models get the same chat, review, checkpoints and worktrees as every other agent. See `docs/ide/local-models.md`.
- **VS Code extension**: story #315 (after the extension's agent UI, #214-#216, in 1.3.0).

Tests live with the IDE (`apps/ide/test/localModels.test.ts`), which already runs TypeScript tests with Node's type stripping.
