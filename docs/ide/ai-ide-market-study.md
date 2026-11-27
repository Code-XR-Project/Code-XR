# AI-first IDEs: market study and design decisions for the Code-XR IDE

*Study date: 27 November 2026. Scope: the agentic coding environments a developer can choose today, how they organise work with AI, and how they are built, so that the Code-XR IDE can offer the same experience and add what only Code-XR has: the live analysis of the project.*

The four detailed reports this summary is built from are in [`market-study/`](market-study/):

| Report | Products |
|---|---|
| [group-a-ai-ide-forks.md](market-study/group-a-ai-ide-forks.md) | Cursor, Windsurf / Devin Desktop, Trae, Void, Kiro |
| [group-b-incumbent-ides.md](market-study/group-b-incumbent-ides.md) | VS Code + GitHub Copilot, JetBrains (AI Assistant, Junie, Air, ACP), Google Antigravity, Firebase Studio / Gemini Code Assist, Amazon Q Developer |
| [group-c-agents-and-clis.md](market-study/group-c-agents-and-clis.md) | Zed, Claude Code, OpenAI Codex, Gemini CLI, Cline, Roo Code, Kilo Code, Aider, Warp |
| [group-d-protocols.md](market-study/group-d-protocols.md) | Agent Client Protocol, subscription terms, checkpoints, diff review in Monaco, rules files, MCP, worktrees |

Every claim in the reports carries its source URL and a confidence label (verified from an official page, secondary source, or prior knowledge not re-checked). Package versions quoted below were checked against the npm registry on 27 November 2026.

---

## 1. Executive summary

1. **The market split into two shapes and is converging on one.** Forks of VS Code (Cursor, Windsurf, Trae, Kiro) and incumbents (VS Code + Copilot, JetBrains) started as "an editor with a chat panel". During 2026 every one of them added an **agent manager**: a list of sessions with their state (working, needs input, done) that is becoming the home screen (Cursor 3 Agents Window, Devin Desktop's board, VS Code's Agents window, JetBrains Air, Antigravity). Users complain when the classic editor disappears, so the winning shape is **both**: an agent-first view and the classic IDE, one click apart.
2. **The chat is a normal coding chat.** In every product the person types what they want ("add a login page", "fix this test"), the agent reads files, runs commands, edits code and shows a plan and a to-do list. Analytics or commentary are never the chat's job.
3. **"Bring your own agent" is the way to use the subscriptions people already pay for.** The open **Agent Client Protocol (ACP)**, created by Zed and adopted by JetBrains, Neovim and others, lets an editor host Claude Code, Codex, Gemini CLI, Copilot CLI, OpenCode and about 40 more agents. Each agent runs as a child process with its own login and billing. This is also the only route the vendors allow for consumer plans (section 4).
4. **Review and safety have a standard shape:** edits land on disk but stay *pending* with Keep / Undo per hunk, per file and for the whole session; a checkpoint per user turn with "restore code / conversation / both"; approvals with allow once / always / deny; a permission mode switch (ask, accept edits, plan, auto).
5. **Parallel work uses git worktrees**, one per agent session, with a merge action at the end.
6. **Customisation converged on `AGENTS.md`** (plus each vendor's file), MCP for tools, hooks and skills.
7. **No product shows the project's structure and quality changing as the agent works.** The closest precedent is Windsurf's *Codemaps* (AI-annotated maps of the code). Code-XR's live XR / LivePanel / dependency-graph analysis beside the chat is a genuine differentiator, and it is the thesis contribution: *context for the developer while an AI changes the code*.

## 2. The products in one table

| Product | Shape (late 2026) | How you connect AI | Distinctive | Weakness reported |
|---|---|---|---|---|
| Cursor | VS Code fork; editor + Agents Window (local, worktree, cloud, SSH sessions) | Own subscription with many models; BYO key limited | Tab completion, plan mode with editable Markdown plan, background agents, Bugbot | Pricing changes, closed |
| Windsurf → Devin Desktop | Fork; opens on a board of agent "Spaces" | Own subscription; Devin Local agent; ACP for other agents | Codemaps (visual code maps passed to the agent) | Lost IDE feel after the rename |
| Trae | Fork; SOLO mode = tasks / chat / tools in three panes | Own subscription (cheap) | Three-pane SOLO layout | Privacy concerns |
| Void | Open-source fork | BYO key, local models | Fully local | Development paused |
| Kiro | Fork by AWS | Own subscription | Spec-driven development (requirements, design, tasks files), hooks | Slow, quota limits |
| VS Code + Copilot | Classic IDE + chat sessions list + Agents window; also hosts Claude and Codex harnesses | Copilot plan (credits since June 2026), BYO key, external agents | Pending edits with Keep/Undo, checkpoints, terminal sandbox, cloud agent PRs | Several harnesses with different permission vocabularies |
| JetBrains | IDE + AI chat; Air for parallel agents | Any ACP agent from a registry (`acp.json`) | ACP host, IDE exposes its semantics as MCP | Mutually exclusive chat plugins |
| Antigravity | Standalone agent app (2.0, May 2026) | Google account | Artifacts (plans, walkthroughs, browser recordings) you can comment on; strict permission grammar | Opaque quotas |
| Zed | Native editor with Agent Panel | Own agent with keys, or external agents over ACP | ACP's origin, multibuffer review of all changes | Smaller extension ecosystem |
| Claude Code | CLI + desktop + IDE extensions | Claude subscription or API key | Plan mode, rewind, hooks, subagents, skills | Terminal-first |
| Codex | CLI, IDE extension, desktop app, cloud | ChatGPT subscription or API key | Sandbox by default, worktrees in the app, app-server protocol | |
| Gemini CLI | CLI | API key (consumer plans moved to Antigravity CLI in June 2026) | Shadow-git checkpointing, `--acp` | Subscription change |
| Cline / Kilo / Roo | VS Code extensions | BYO key; Kilo has "Sign in with ChatGPT" | Plan/Act modes, shadow-git checkpoints, Kilo's Agent Manager with worktrees | Roo's extension shut down in 2026 |

## 3. UX patterns everyone converged on

**Layout and navigation**
- A **sessions sidebar** grouped by project: auto title, agent, last activity, status badge (working, needs input, failed, done/unread), changed-file count, archive and search.
- The chat opens as a panel *or* as an editor tab; several chats in tabs.
- An agent manager view for parallel sessions (list or board by status).
- Notifications (in-app and OS) when an agent finishes or needs input.

**Composer**
- Agent picker, model picker (with reasoning effort), mode (Ask / Plan / Agent, or the agent's own modes).
- `@`-mentions of files, folders, symbols, selection, problems, terminal output, git diff; image paste.
- Slash commands (from the agent and from prompt files), a context-usage meter, a message queue and "steer now" while the agent runs.

**While the agent works**
- A streamed transcript with tool-call cards (read, edit, run, search, fetch) that can be expanded.
- A **plan / to-do list** pinned above the composer.
- Approval cards: allow once, allow always, reject; a mode switch for less friction.

**After the agent works**
- A **changed-files summary** at the end of the turn, opening a multi-file review: diff per file, Keep / Undo per hunk and file, Keep all / Undo all; line comments sent back as a follow-up prompt.
- **Checkpoints** per user message: restore code, conversation, or both; edit and resend a previous message rewinds first. Everyone states that terminal side effects are not undone.

**Customisation**
- Instructions files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules`, `copilot-instructions.md`) with a panel showing what is loaded.
- MCP servers with per-server and per-tool toggles; hooks; skills.

## 4. How it is built (the parts that decide our architecture)

### 4.1 Agent Client Protocol (ACP)

- JSON-RPC 2.0 over stdio, newline-delimited; the agent is a child process of the editor. Stable protocol version **1** (v2 is a preview).
- Editor → agent: `initialize`, `authenticate`, `session/new` (with `cwd` and `mcpServers`), `session/load`, `session/prompt`, `session/cancel`, `session/set_mode`, `session/set_config_option`.
- Agent → editor: `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` with diffs, `plan`, `available_commands_update`, `current_mode_update`, config and usage updates), and requests `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release`.
- The editor serves file reads from **unsaved buffers** (the agent sees what the person sees) and runs terminals in its own visible terminal.
- SDK: `@agentclientprotocol/sdk` 2.12.0 (Apache-2.0).
- Launch commands (verified on npm): Claude via `@agentclientprotocol/claude-agent-acp` 0.113.0, Codex via `@agentclientprotocol/codex-acp` 2.12.1, Gemini via `@google/gemini-cli` 0.71.1 with `--acp`. A public registry lists about 40 agents with their launch specs.

### 4.2 Using the subscriptions people already pay for

| Vendor | Allowed | Not allowed |
|---|---|---|
| Anthropic (Claude Pro / Max) | The person signs in to the unmodified Claude Code with Anthropic's own login flow; a host app launches it | A third-party app offering "Sign in with Claude", or reading, storing or proxying the OAuth token |
| OpenAI (ChatGPT Plus / Pro) | Codex with ChatGPT login (browser or device code); "Sign in with ChatGPT" for partner apps since September 2026 | Using the app-server's auth in commercial hosted services |
| Google | The real `gemini` binary with its own login; consumer AI Pro / Ultra plans now go through Antigravity (`agy acp`) | Reusing Gemini CLI's OAuth from other software (accounts have been suspended) |

**Consequence for Code-XR:** the IDE launches the vendor's own agent, lets it run its own login in the IDE's terminal or browser, and never touches the tokens. API keys typed by the person stay in the OS keychain (Electron `safeStorage`, already used by the agent hub). Terms change often, so the IDE must word this carefully and the study must be re-checked before a release.

### 4.3 Checkpoints

Three implementations exist: file snapshots per prompt (Claude Code), a **shadow git repository** outside the project (Cline, Roo, Gemini CLI), and real commits (Aider). The shadow-git approach also catches changes made by shell commands, works with any agent, and never touches the person's own repository when it uses its own `GIT_DIR`, index file and a neutral config (no hooks, no signing, no LFS filters, `autocrlf=false`).

### 4.4 Review in Monaco

Monaco offers a diff editor (`createDiffEditor`) for the multi-file review, and view zones plus decorations for inline red/green hunks with Keep / Undo widgets in the normal editor. VS Code's model: apply edits immediately, keep the original, let the person keep or undo; holding writes until approval breaks agents that read back their own files, so it is only an optional "ask before write" mode.

### 4.5 Rules and tools

- Agents load their own instruction files from their working folder; a host must not inject them again. The IDE shows which files exist and offers to create `AGENTS.md` as the canonical one.
- MCP (spec 2026-07-28; `@modelcontextprotocol/server` 2.4.0, or the 1.x `@modelcontextprotocol/sdk` 1.32.2): the IDE can pass its own MCP server to every agent in `session/new`. JetBrains does exactly this to expose its code intelligence.

### 4.6 Parallel agents

`git worktree add` per session outside the repository, an optional setup script, the agent started with that folder as `cwd`, and Apply / Merge / Discard at the end; a cap on concurrent sessions and `git worktree prune` at start-up.

## 5. What this means for the Code-XR IDE

**Two modes, one app.** *Agent* mode is the default: sessions on the left, the chat and files in the centre, the live Code-XR analysis on the right. *Classic* mode is today's VS Code-like workbench. Both share the same editor, terminal, Git, extensions and analysis.

**The chat hosts real coding agents.** Claude Code, Codex and Gemini CLI through ACP (with the person's subscription or key), plus the existing built-in agent of epic #189 for API keys of any provider. One UI for all of them.

**Our differentiator: the project changing in front of you.**
- The right-hand dock keeps the XR scene, LivePanel or dependency graph of the project live, re-analysing when the agent writes files.
- Files the agent reads and edits are highlighted in the scene, and the camera can follow the agent.
- After each turn, a one-line delta of what changed (complexity, size, new files, new dependencies) under the turn and per file in the dock.
- Code-XR's own analysis is offered to every agent as an MCP server, so the agent can ask for hotspots, metrics and dependencies the same way the person sees them.

## 6. Prioritised features (what we build, in order)

| # | Feature | Seen in | Why first |
|---|---|---|---|
| 1 | ACP host in the main process (spawn, auth, sessions, updates, permissions, fs from buffers, terminals) | Zed, JetBrains | Unlocks Claude, Codex and Gemini subscriptions at once |
| 2 | Chat as a normal coding chat in an editor tab: transcript with tool cards, plan, composer with agent/mode/model pickers, @-mentions, slash commands | All | The core interaction |
| 3 | Agent-first layout + Classic mode switch | Cursor 3, Trae SOLO, VS Code | Adrián's layout |
| 4 | Sessions sidebar grouped by project with status and notifications | All | Organises chats and agent projects |
| 5 | Pending changes: changed-files list, multi-file review, inline Keep / Undo | VS Code, Zed, Claude Desktop | Trust in what the agent did |
| 6 | Checkpoints per turn (shadow git), restore code / conversation / both | Cline, Gemini, Claude Code, VS Code | Safety |
| 7 | Live analysis dock + agent activity in the scene + per-turn metric delta | (none) | Code-XR's contribution |
| 8 | Code-XR MCP server passed to every agent | JetBrains | Agents get Code-XR context |
| 9 | Agent catalogue: presets, install with consent, registry | Zed, JetBrains | Easy set-up |
| 10 | Instructions panel (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) | All | Customisation |
| 11 | Parallel sessions in git worktrees with Merge / Discard | Cursor, Codex app, Kilo, VS Code | Several agents at once |
| 12 | First-run "connect your AI" flow | All | Onboarding |

Later: OS terminal sandbox, browser preview the agent can drive, plans as commentable documents, voice (its own epic).

**Lessons to avoid:** several permission vocabularies for different agents (map everything onto one approval card), opaque quotas (always show what an agent costs or that it uses a subscription), checkpoint wording that implies terminal side effects are undone, and removing the classic editor.

## 7. VS Code extension (1.3.0)

Following the project rule that every feature works in the IDE and the extension with shared code, the logic of features 1, 5, 6, 7 and 8 lives in shared modules with no Electron or `vscode` imports, so the extension's agent stories (#214 shared core, #215 sidebar, #216 chat webview) reuse it in 1.3.0.
