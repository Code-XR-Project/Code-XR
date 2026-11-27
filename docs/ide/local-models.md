# Local models as agents (epic #310)

People can bring **their own model**, served on their machine or their network, and code with it in the Code-XR IDE exactly like with Claude Code, Codex or Gemini CLI: the same chat tab, permission cards, **Changes** review, checkpoints, worktrees and Code-XR analysis tools. No account and no subscription are needed, and the code never leaves the machine.

| Story | What |
|---|---|
| #311 LM1 | Shared package `packages/local-models`: server presets, endpoint rules, discovery, model listing, the agent loop |
| #312 LM2 | The local-model ACP agent shipped with the IDE |
| #313 LM3 | Add, edit and remove local models in the Agents section |
| #314 LM4 | Detect running local servers |
| #315 LM5 | The same in the VS Code extension (1.3.0, after #214-#216) |
| #316 LM6 | This document and the manual test guide |

## Supported servers

Any server that speaks the OpenAI Chat Completions API with streaming works. These are known by name (preset, default address, how to start it):

| Server | Default address | Start it | Tool calls |
|---|---|---|---|
| Ollama | `http://127.0.0.1:11434/v1` | the Ollama app, or `ollama serve`; `ollama pull qwen2.5-coder:7b` | yes, for models whose template supports tools |
| LM Studio | `http://127.0.0.1:1234/v1` | load a model, Developer tab > Start server (or `lms server start`) | yes, for models with tool support |
| llama.cpp | `http://127.0.0.1:8080/v1` | `llama-server -m model.gguf --jinja` | only with `--jinja` |
| vLLM | `http://127.0.0.1:8000/v1` | `vllm serve <model> --enable-auto-tool-choice --tool-call-parser <parser>` | with those flags |
| Jan | `http://127.0.0.1:1337/v1` | Settings > Local API Server > Start | depends on the model |
| LocalAI | `http://127.0.0.1:8080/v1` | `local-ai run <model>` | depends on the model |
| Other | any | any OpenAI-compatible server or gateway | depends |

**Models that work well as coding agents** (they call tools reliably): `qwen2.5-coder` (7B and up), `qwen3`, `llama3.1`/`llama3.3`, `mistral-nemo`, `devstral`, `gpt-oss`. Small or old models (e.g. `gemma:2b`, `phi`) often have no tool support: the agent notices the server's refusal, says so once in the chat and keeps answering as a plain chat (it cannot read or change files then).

## Using it

1. Start your server and load or pull a model.
2. In the **Chats** view, under **Agents**, press **Add local model**.
3. Press **Detect** (it asks the default ports above on 127.0.0.1, once) and click a model, or pick the server, type its address and press **List models**.
4. Optionally rename it and add an API key (most local servers need none). Press **Add**.
5. Pick it next to **New chat** and chat. The **Model** menu of the chat lists every model of the server, so one entry covers them all; **Mode** switches between *Ask* (asks before every change and command) and *Accept edits* (changes files without asking, still reviewed in **Changes**; commands still ask).

**Check** starts the agent once and asks the server for its models: it shows *Ready*, or why it cannot reach the server and how to start it. **Edit** and **Remove** change or drop the entry (the model stays on the server).

## How it works

```
Chat tab (renderer) --IPC--> AgentSessionService (main, the ACP client)
                                  |  spawn: <IDE binary> out/localAgent/index.cjs   (ELECTRON_RUN_AS_NODE=1)
                                  v
                          local agent (ACP agent) --HTTP, OpenAI Chat Completions--> Ollama / LM Studio / ...
                                  |  fs/read_text_file, fs/write_text_file, terminal/*, session/request_permission  --> back to the IDE
                                  |  stdio MCP --> out/codexrMcp (the Code-XR analysis, AF10)
```

- **An ACP agent like the others.** The IDE already hosts coding agents over the Agent Client Protocol (epic #265). The local agent is one more ACP agent, shipped inside the IDE (`apps/ide/src/localAgent/`, bundled to `out/localAgent/index.cjs`) and started per chat by the IDE's own binary in Node mode, like the Code-XR MCP server: no system Node, nothing to download. Nothing in the chat, review, checkpoint or worktree code had to change.
- **Tools.** `read_file`, `list_directory`, `find_files`, `search_text`, `write_file`, `edit_file`, `run_command`, plus the tools of the MCP servers the IDE passes in `session/new` (the Code-XR analysis: `code-xr__get_metrics`, `get_hotspots`, `get_dependencies`, `get_evolution`). Reads and writes go through the ACP client, commands through ACP terminals, so the IDE checks the folder, records every change for **Changes** and runs commands in the chat's folder (its worktree, if it has one). Listing and searching read the disk directly inside the session's folder (ACP has no request for them), skipping `.git`, `node_modules`, virtual environments and caches.
- **The loop** (`packages/local-models/src/agentLoop.ts`): stream the answer, collect the tool calls, run them, feed the results back, repeat (at most 40 model requests per prompt). Tool results are cut to 24,000 characters (local models have small contexts). Stop cancels the HTTP request and any running command.
- **The project's instructions.** `AGENTS.md` (or `CLAUDE.md`) of the folder is added to the system prompt, as the IDE's instructions panel (AF11) writes it.
- **Shared code.** Everything host-neutral (presets, endpoint rules, discovery, the loop, the tools' schemas and edit logic) is in `packages/local-models`, imported as `@codexr/local-models/*` (alias in `apps/ide/scripts/viteConfigs.mjs`, the `tsconfig.*.json` and the test loader). The VS Code extension (#315) reuses it with its own thin host.

## Privacy and safety

- Nothing is probed until the person presses **Detect**, **List models** or **Check**, or starts a chat. **Detect** only asks the presets' default ports on `127.0.0.1`.
- Plain `http` is accepted only towards this machine (`localhost`, `127.0.0.0/8`, `::1`) or a private network (10/8, 172.16/12, 192.168/16, link-local, 100.64/10 as used by Tailscale, IPv6 ULA, `.local`); anything else needs `https`. Credentials in the URL are refused.
- An API key, if given, is encrypted with the OS secret store (Keychain, DPAPI, libsecret; kept in memory only when there is none), never returned to the page, and handed to the agent in its environment, never on a command line; the agent removes it from its own environment at start, so the MCP servers it starts do not inherit it.
- Changes and commands ask first, per chat (*Allow*, *Always allow edits/commands in this chat*, *Reject*), unless the chat is in *Accept edits* (edits only). Local models never start in Restricted Mode, like every agent.

## Limits

- Images in a prompt are not sent (the agent says so).
- A chat does not remember its messages after the IDE restarts with a new agent process (the agent has no `session/load` yet); the transcript stays in the IDE.
- Token use is not shown in the usage bar (local servers report it inconsistently).
