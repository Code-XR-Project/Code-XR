# Group C — Agent-first coding environments: market research for Code-XR IDE

*Compiled 2026-11-27. Sources were fetched where marked; items marked **[training knowledge]** come from pre-2026 knowledge and were not re-verified this session (the shared web-fetch budget ran out midway). Items marked **[uncertain]** need confirmation before being relied on.*

---

## 0. Executive summary (read this first)

1. **The protocol to adopt is ACP (Agent Client Protocol).** Zed created it; JetBrains, Neovim (CodeCompanion) and others consume it; there is a public **ACP Registry** of agents (Claude Agent, Codex, Gemini CLI, OpenCode, Copilot, Cursor, Pi, Poolside…). An Electron IDE that implements the *client* half of ACP gets every major agent "for free", each running as a subprocess that owns its own auth, models and billing. ([zed.dev/docs/ai/external-agents](https://zed.dev/docs/ai/external-agents.md), [agentclientprotocol.com v1 overview](https://agentclientprotocol.com/protocol/v1/overview.md))
2. **Subscription auth — the legal line differs per vendor, and this decides the architecture:**
   - **Anthropic**: third parties may **not** offer claude.ai login or route requests through Free/Pro/Max credentials, and may not collect/store Claude session tokens — *including* apps built on the Agent SDK (which must use API keys). **But** an end user signing in to the **unmodified Claude Code binary** with their own subscription is explicitly allowed, including where a platform hosts Claude Code. ⇒ Code-XR IDE may launch the official `claude` CLI (in its terminal, or as a subprocess the user logs into via Anthropic's own `/login` flow), but must never handle the OAuth token itself. ([legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance.md), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md), [The Register, 2026-02-20](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access))
   - **OpenAI**: the opposite posture. "**Sign in with ChatGPT**" for third-party coding agents launched at DevDay (Sept 2026): Plus/Pro usage counts against Codex limits, users can set per-app weekly caps. Launch partners include OpenCode, Kilo Code, Warp, Conductor, Pi, Amp. The Codex **app-server** (JSON-RPC over stdio, the backend of the official VS Code extension) can be embedded by third-party local/open-source apps; it notes app-server auth "has never been permitted for commercial or hosted services" and recommends migrating to Sign in with ChatGPT. ([thenewstack.io/sign-in-with-chatgpt](https://thenewstack.io/sign-in-with-chatgpt/), [Codex App Server](https://learn.chatgpt.com/docs/app-server.md))
   - **Google**: directly accessing the services behind Gemini CLI (Code Assist) from third-party software with Gemini CLI OAuth "is a violation of applicable terms" and may get accounts suspended (OpenClaw is the named example; many 403 ToS-ban reports). Launching the **real `gemini` binary** (e.g. `gemini --acp`) is the sanctioned route. Note: since **2026-06-18** Gemini CLI's unpaid tier and Google One users were moved to **Antigravity CLI**. ([geminicli.com tos-privacy](https://www.geminicli.com/docs/resources/tos-privacy), [geminicli.com acp-mode](https://geminicli.com/docs/cli/acp-mode/))
3. **UX consensus across products** (to imitate): thread/session sidebar with status badges (working / needs input / done) → plan mode with an editable plan → todo list pinned in the panel → per-tool approvals with "allow once / allow for session / always" → a **multi-file review surface** (Zed's multibuffer, Claude Desktop's diff pane with line comments, Kilo/Cline Kanban card diffs) → **checkpoints per prompt** with "restore code / restore conversation / both" → **git worktree per parallel session** → merge/commit/PR from the UI.

---

## 1. Zed — Agent Panel, threads, ACP external agents

**Pricing/auth.** Zed's own agent ("Zed Agent") uses Zed's hosted models (Zed Pro) or BYO provider keys. **External agents are free from Zed's side**: "Zed does not charge for External Agents"; billing is between the user and the agent vendor, and prompts don't transit Zed servers (Codex post). Each external agent manages its own auth: Claude Agent → run `/login` inside the thread (API key, or "Claude Code where supported"); Codex → ChatGPT login, Codex/OpenAI API keys; Gemini CLI → Google login / Vertex / `GEMINI_API_KEY` (Zed passes its own Google AI key as `GEMINI_API_KEY` if none set). ([external-agents](https://zed.dev/docs/ai/external-agents.md), [codex-is-live-in-zed](https://zed.dev/blog/codex-is-live-in-zed))
[uncertain] The Zed registry page for Claude only mentions an Anthropic API key ([zed.dev/acp/agent/claude-code](https://zed.dev/acp/agent/claude-code)); given Anthropic's policy, subscription login through an SDK-based adapter is legally grey unless it delegates to the real Claude Code login flow.

**UX — Agent Panel** ([agent-panel](https://zed.dev/docs/ai/agent-panel.md)):
- **Threads**: `cmd-n` new thread; "New Thread…" menu chooses Zed Agent or any external agent; **New From Summary** (seed a fresh thread with a summary of the current one); **Terminal thread**.
- **Threads Sidebar** grouped by project, thread switcher `ctrl-tab`; **Thread History** across projects, archive/restore; auto-generated, editable, regenerable titles.
- **Review Changes**: list of edited files with line counts; opens a **multibuffer** tab (`shift-ctrl-r`) showing every hunk the agent made across files, with **accept/reject per hunk or all**. Optional `agent.single_file_review` shows the same keep/reject controls inline in each file.
- **Follow the agent** (crosshair): editor jumps to each file the agent touches, in real time.
- **Queueing** messages during generation; **Steer** (interrupt at next step; Zed Agent only); edit any sent message and resubmit; "Open Thread as Markdown".
- **Notifications**: desktop/sound when done while backgrounded; `prevent_idle_sleep` during generation.
- **Model selector** with favourites, per-thread overrides, "Save as Default".
- **Checkpoints**: [training knowledge] Zed Agent shows a "Restore Checkpoint" button on each user message that reverts the project to the state before that message (implemented on Zed's own git-based snapshotting). Not confirmed for external agents.

**Context**: @-mentions for files, directories, symbols, previous threads, skills, diagnostics, branch diffs, URLs; add editor/terminal selection with `cmd->`; images by paste/drag/@; token-usage meter; auto-compaction ("Context Compacted") plus `/compact`.

**Tools/permissions**: **Agent Profiles** (Write / Ask / Minimal built-ins, plus custom) select which built-in and MCP tools a thread may use; **Tool Permissions** allow / deny / confirm per tool. Rules: [training knowledge] `.rules`, plus it reads `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, etc., and a Rules Library.

**ACP wiring of external agents** (the key part):
- ACP = JSON-RPC 2.0; agent runs as a **subprocess of the editor over stdio**. Agent-side methods: `initialize`, `authenticate`, `session/new`, `session/prompt`, `session/cancel`, optional `session/load` (resume), `session/set_mode`, `logout`. Client-side methods the agent calls: `session/request_permission` (baseline), optional `fs/read_text_file` / `fs/write_text_file` (so the editor can serve *unsaved buffer* contents and apply writes through its buffers), `terminal/create|output|wait_for_exit|kill|release`, `elicitation/create`. Streaming via `session/update` notifications: message/thought chunks, **tool calls + updates (with diffs and locations)**, **plans** (todo lists), available-commands updates (slash commands), mode changes, notices, context compactions, **subagent sessions**. ([ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview.md), [tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls.md); a v2 draft exists under `/protocol/v2/` [uncertain what changes])
- **Install**: ACP Registry (`zed: acp registry` or Agent Settings → External Agents → Add Agent → Install from Registry); custom agents via `agent_servers` entries `{type, command, args, env}`; old "extension agents" deprecated → migrated to registry.
- **Claude**: adapter (originally `@zed-industries/claude-code-acp`, now `agentclientprotocol/claude-agent-acp`) wraps the Claude Agent SDK and translates to ACP; Apache-licensed and reusable by any ACP client. Gets: follow-along, multibuffer hunk review, **task list anchored in the panel**, custom slash commands; early limitations: many built-in slash commands unsupported, plan mode arrived later. It reads `CLAUDE.md` natively. ([claude-code-via-acp, 2025-09-03](https://zed.dev/blog/claude-code-via-acp))
- **Codex**: open-source `codex-acp` adapter (Oct 2025). Difference: Codex runs terminal commands **in its own process and streams bytes**; Claude/Gemini instead ask the *client* to run commands (`terminal/create`), which Zed can run in PTY mode (interactive, coloured) — at the risk of deadlocks (e.g. `git rebase --continue` opening an editor). ([codex-is-live-in-zed](https://zed.dev/blog/codex-is-live-in-zed))
- **Gemini CLI**: the first ACP agent (Aug 2025), native `gemini --acp`; supports `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode` (approval level), `unstable_setSessionModel`; file system proxied through the client; the client can expose its own tools to the agent as an MCP server at `initialize`. ([acp-mode](https://geminicli.com/docs/cli/acp-mode/), [bring-your-own-agent](https://zed.dev/blog/bring-your-own-agent-to-zed))
- **What external agents get in the UI**: same thread view, model/mode/thinking-effort/"Fast mode" pickers in the composer when the agent advertises them, imported thread history (archived, restorable), MCP servers forwarded over ACP, Zed permission prompts. **Not applied**: Zed profiles and Zed Skills; Steer. Debug via `dev: open acp logs`.

**Distinctive / imitate**: multibuffer review of all agent hunks; follow mode; New From Summary; ACP registry; agent-agnostic thread sidebar. **Weaknesses**: external agents are second-class (no steer, partial slash commands, settings split between Zed and the agent, checkpoint coverage unclear).

---

## 2. Claude Code (CLI, Desktop, VS Code/JetBrains, Agent SDK)

**Pricing/auth.** Login with Claude Pro / Max / Team / Enterprise (OAuth) or Console API key, or Bedrock / Vertex(Agent Platform) / Foundry. **Third-party rules** (verbatim essentials, [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance.md)):
- "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
- "Developers building products … including those using the Agent SDK, should use API key authentication … Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users … may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
- "Nor does it prevent an end user from signing in to the **unmodified Claude Code binary** with their own Claude subscription, including where a platform hosts Claude Code." Hosting Claude Code requires: binary not modified, no auth method removed, no reselling/intermediating usage.
- Agent SDK note: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Branding: you may say "Claude Agent" / "Powered by Claude", **not** "Claude Code". ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md))
- Enforcement history: Feb 2026 clarification; OpenCode removed Claude subscription support citing "anthropic legal requests"; OpenClaw subscriptions ended (Sept 2026) ([The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)).
- **Implication for Code-XR IDE** [inferred]: the safe designs are (a) run the user-installed `claude` CLI in the integrated terminal (zero integration risk), (b) offer "Claude via API key" through the Agent SDK / an ACP adapter, (c) treat any SDK/ACP-adapter path that silently reuses `~/.claude` subscription credentials as **not** permitted unless Anthropic approves. Cline's "Claude Code provider" (shells out to the user's `claude` binary) is a grey-zone precedent, not a sanctioned one.

**Surfaces**: CLI (TUI); **Desktop app** — session sidebar (group/sort/archive/search), **Worktree toggle per session**, split view / separate windows, side chats (`/btw`), background-tasks pane, **diff view with per-line comments** (submit all with Cmd+Enter → Claude produces a new diff), `/code-review` cards with "Fix this one"/"Apply fixes", integrated terminal, file pane, **browser pane** for dev-server preview where Claude can screenshot/click/inspect DOM, drag-and-drop pane layout, session details (context usage), PR monitoring with CI status + auto-fix + merge-when-ready, local / cloud / SSH / WSL environments, Remote Control from phone, `.claude/launch.json` preview configs ([desktop](https://code.claude.com/docs/en/desktop.md)). **VS Code extension** — bundles its own CLI; Spark icon; sessions list in Activity Bar with groups and status filters (Needs input / Working / Completed); multiple conversations in tabs with coloured status dot (blue = permission pending, orange = finished unseen); plan review as an editable doc; @-mention with line ranges from selection; auto-attach selection/open file; images by paste; PDFs page ranges; **hover any message → rewind: fork conversation / rewind code / both**; agent map of subagents (status, time, tokens, stop); bookmarks; plugin & marketplace dialogs; resume cloud sessions; option to use terminal mode instead ([vs-code](https://code.claude.com/docs/en/vs-code.md)). JetBrains plugin runs the CLI in the IDE terminal with IDE diff viewer [training knowledge].

**Sessions**: `--continue`, `--resume`, `/resume`, `/branch`, `--fork-session`, `--from-pr`, named sessions; transcripts are JSONL under `~/.claude/projects/` [training knowledge] ([sessions](https://code.claude.com/docs/en/sessions.md)).

**Plan mode & todos**: plan mode = read/explore only; on finish user chooses "Yes + auto mode" / "Yes, manually approve edits" / "Keep planning"; `Ctrl+G` edits the plan in $EDITOR; enter via `Shift+Tab`, `/plan`, `--permission-mode plan`. TodoWrite tool renders a live task list [training knowledge].

**Checkpoints** ([checkpointing](https://code.claude.com/docs/en/checkpointing.md)): one checkpoint per user prompt that starts a turn; **file snapshots** (not git) of files touched by Claude's edit tools, last 100 checkpoints kept, saved with the conversation so they survive resume; ~30-day retention. `/rewind` or `Esc Esc` → *Restore code and conversation / Restore conversation / Restore code / Summarize from here / Summarize up to here*. Limits: **Bash-made changes, subagent edits (mostly), external edits and symlinks are not restored** — "not a replacement for version control". The Agent SDK exposes file checkpointing too ([agent-sdk/file-checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)).

**Context**: `CLAUDE.md` hierarchy (managed → user `~/.claude/CLAUDE.md` → project → subdirectory, `@imports`), reads `AGENTS.md`, plus **auto memory** ([memory](https://code.claude.com/docs/en/memory.md)); @-files; images; `/compact`, auto-compaction; `/context` [training knowledge].

**Permissions & sandbox** ([permission-modes](https://code.claude.com/docs/en/permission-modes.md)): modes `default`(Manual) / `acceptEdits` / `plan` / `auto` (background classifier reviews each action) / `dontAsk` (CI) / `bypassPermissions`; `Shift+Tab` cycles. Rules `allow` / `ask` / `deny` with specifiers like `Bash(npm test)`, `Bash(git push *)`, `Read(./.env)`; deny always wins; broad `Bash(*)` allows dropped in auto mode; protected paths (`.git`, `.claude`, `.bashrc`, `.mcp.json`) never auto-approved. Optional OS **sandboxed Bash** restricting filesystem and network hosts ([sandboxing](https://code.claude.com/docs/en/sandboxing.md)).

**Extensibility**: MCP (stdio/HTTP, `.mcp.json`, connectors); **hooks** (PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, Notification, SessionStart, PreCompact…; command/HTTP/prompt hooks; JSON I/O and exit codes can block/modify) ([hooks](https://code.claude.com/docs/en/hooks.md)); **subagents** (`.claude/agents/*.md` with own prompt, tools, model; isolated context) ([sub-agents](https://code.claude.com/docs/en/sub-agents.md)); **skills** (`SKILL.md` folders, progressive disclosure, also the mechanism for custom slash commands) ([skills](https://code.claude.com/docs/en/skills.md)); **plugins + marketplaces** bundling skills/agents/hooks/MCP; agent teams, agent view, worktrees, dynamic workflows, scheduled tasks/routines ([agents](https://code.claude.com/docs/en/agents.md)).

**Integration hooks for a host IDE**: headless `claude -p --output-format stream-json` (+ `--input-format stream-json` for bidirectional) ([headless](https://code.claude.com/docs/en/headless.md)); Agent SDK (TS/Python) which spawns the Claude Code binary; IDE MCP bridge used by the VS Code/JetBrains integrations for diffs and selection [training knowledge]; ACP via `claude-agent-acp`.

**Imitate**: three-way rewind menu; plan approval → choose execution mode; status-dot tabs; diff line comments that turn into a follow-up prompt; agent map for subagents; side chat that doesn't pollute context. **Weaknesses**: checkpoint blind spot for shell edits; subscription lock-in to first-party surfaces.

---

## 3. OpenAI Codex (CLI, IDE extension, Codex app, cloud)

**Pricing/auth** ([auth](https://learn.chatgpt.com/docs/auth.md)): **Sign in with ChatGPT** (Plus/Pro/Business/Enterprise plan limits; required for Codex cloud), API key (pay-per-token), **device-code login** (beta) for headless, Codex access tokens for trusted automation. Third-party: **Sign in with ChatGPT for other apps** (DevDay, Sept 2026) shares plan usage with partner tools with per-app weekly caps; no fallback to the third party's billing when caps hit. Partners: OpenCode, OpenClaw, Pi, T3, Hermes Agent, Amp, Kilo Code, Warp, Conductor, Devin, Notion, Vercel… ([thenewstack](https://thenewstack.io/sign-in-with-chatgpt/)) [uncertain: onboarding requirements for a new partner app — likely an application/registration process]. App-server: `account/login/start` with `chatgpt` / `chatgptDeviceCode` / `apiKey`, experimental external tokens; "never been permitted for commercial or hosted services" ([app-server](https://learn.chatgpt.com/docs/app-server.md)).

**UX**: CLI TUI (Rust), IDE extension for VS Code/Cursor/Windsurf (backed by app-server), **Codex app** (macOS Feb 2026, later Windows [uncertain]) focused on managing many agents: projects, parallel threads, **built-in git worktrees per thread**, local vs cloud execution, review pane, automations/scheduled tasks, skills/plugins, browser, computer use, voice, mobile approvals ([Codex app](https://developers.openai.com/codex/app), [worktrees](https://developers.openai.com/codex/app/worktrees), [features](https://learn.chatgpt.com/docs/features.md), [introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)). Plan updates and aggregated turn diffs are first-class events (`turn/plan/updated`, `turn/diff/updated`). Threads support `thread/start|resume|fork|archive`, `turn/steer`, `turn/interrupt`. `/review` code review, `/undo` [training knowledge; undo via ghost commits — uncertain whether still present].

**Approvals & sandbox** ([agent-approvals-security](https://learn.chatgpt.com/docs/agent-approvals-security.md)): approval policies `on-request`, `never`, **granular** per category; `untrusted` retired (use per-project `trust_level`); **auto-review** reviewer agent (`approvals_reviewer = "auto_review"`) that denies critical-risk actions, fail-closed. Sandbox modes `read-only` / `workspace-write` (network off by default) / `danger-full-access`. OS sandbox: macOS Seatbelt (`sandbox-exec`), Linux **bubblewrap + seccomp** (since 0.115; landlock alias), Windows MXC (legacy elevated/unelevated). Network proxy with domain allow/deny. Presets: Auto, Safe read-only, Read-only CI, Auto-review, Full access (`--yolo`). Defaults: git folder → Auto, non-git → read-only. Protected paths: `.git`, `.agents`, `.codex`, `.aws` stay read-only.

**Context/extensibility**: `AGENTS.md` (hierarchical; open standard shared by many tools), `~/.codex/config.toml`, MCP client (and `codex mcp-server`), skills, plugins, custom prompts, hooks [training knowledge — hooks support uncertain], execpolicy rules.

**Integration for a host IDE**: **app-server** — JSON-RPC (stdio NDJSON; experimental WebSocket, unix socket); `initialize` → `thread/start` → `turn/start`; streamed `item/*` events (`agentMessage`, `commandExecution`, `fileChange`, deltas); server-initiated approvals `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` with `accept / acceptForSession / decline / cancel`; schemas generated by `codex app-server generate-ts`. Set `clientInfo.name` to identify the client. Alternatively the TypeScript **Codex SDK** for automation, or `codex-acp` for ACP.

**Imitate**: sandbox-first design (approvals only on escaping the sandbox), auto-review agent, granular approval categories, worktree-per-thread, aggregated turn diff event. **Weaknesses**: frequent config renames (e.g. `untrusted` retired), Windows sandbox churn.

---

## 4. Gemini CLI

**Auth/pricing**: Google account login (Code Assist for individuals; Google AI Pro/Ultra under Google One terms; Standard/Enterprise under GCP terms), Gemini API key, Vertex AI. **Third-party use of Gemini CLI OAuth is prohibited** and has triggered account suspensions; unpaid tier & Google One users moved to **Antigravity CLI** on 2026-06-18 ([tos-privacy](https://www.geminicli.com/docs/resources/tos-privacy), [acp-mode](https://geminicli.com/docs/cli/acp-mode/), ban reports e.g. [discuss.ai.google.dev](https://discuss.ai.google.dev/t/urgent-mass-403-tos-bans-on-gemini-api-antigravity-for-open-source-cli-users-paid-tier/124508)). Apache-2.0 open source.

**ACP mode**: `gemini --acp` (formerly `--experimental-acp`); methods initialize/authenticate/newSession/loadSession/prompt/cancel, `setSessionMode` (approval level), `unstable_setSessionModel`; file system proxied through the client; client tools exposed via MCP. Listed in the ACP Registry used by Zed and JetBrains.

**Checkpointing** ([checkpointing](https://geminicli.com/docs/cli/checkpointing.md)): off by default (`general.checkpointing.enabled`). Taken **after the user approves a file-modifying tool, before it runs**; files snapshotted as a commit in a **shadow git repo at `~/.gemini/history/<project_hash>`** (project's own repo untouched); conversation + pending tool call saved as JSON in `~/.gemini/tmp/<project_hash>/checkpoints`. `/restore` lists; `/restore <id>` reverts files and conversation and **re-proposes the original tool call**.

**Other** [training knowledge]: `GEMINI.md` hierarchical context (configurable filename, can be set to `AGENTS.md`), `/memory`, approval modes (default / auto_edit / yolo, plus plan mode added 2026 [uncertain]), sandboxing via macOS Seatbelt profiles or Docker/Podman container, MCP, extensions (bundle MCP + context + commands), TOML custom commands, `/chat save|resume`, `/compress`, IDE companion extension for VS Code ([ide-integration](https://geminicli.com/docs/ide-integration.md)), hooks (added late 2025 [uncertain]).

**Imitate**: shadow-git checkpoint that re-proposes the tool call after restore. **Weaknesses**: product churn (Antigravity split), aggressive ToS enforcement.

---

## 5. Cline (open source, VS Code + CLI + Kanban)

**Auth/pricing**: free extension, BYOK for many providers, **Cline provider** (usage billing via Cline account), **"Claude Code" provider** that uses the user's installed `claude` CLI ("uses your Claude subscription limits"; no token streaming, limited images/caching), OpenAI Codex provider with OAuth ([anthropic provider](https://docs.cline.bot/provider-config/anthropic.md), [llms.txt](https://docs.cline.bot/llms.txt)). [inferred] Shelling out to the unmodified binary is the closest to Anthropic's allowed pattern, but Anthropic has not endorsed it.

**UX**: single task-centric chat in the sidebar, task history; **Plan / Act** modes with optional different models per mode; `/deep-planning`; todo list ("focus chain") [training knowledge]; auto-compaction [training knowledge]; per-action approval cards showing diffs before writing (diff opens in VS Code's diff editor, user can edit before saving) [training knowledge]; browser tool (headless Chromium screenshots). **Checkpoints**: shadow git repo (separate from project git, includes untracked files), **one checkpoint after every tool use**; actions **Compare** (opens diff), **Restore Files**, **Restore Task Only**, **Restore Files & Task** ([checkpoints](https://docs.cline.bot/core-workflows/checkpoints.md)). **Kanban** (research preview, `npx kanban`): task cards each with own **git worktree + terminal**, sidebar chat can split work into cards, inline diff comments, Commit / Open PR, dependency chains auto-starting next task; drives Cline CLI, **Claude Code, Codex, OpenCode** ([kanban](https://docs.cline.bot/usage/kanban.md)). Also Agent Teams in the CLI.

**Permissions**: Auto-approve toggles — read project / read all / edit project / edit all / safe commands / all commands / browser / MCP; "safe" is **model-judged**, not an allowlist; OS notifications on approval needed; **YOLO** mode auto-approves everything ([auto-approve](https://docs.cline.bot/features/auto-approve.md)).

**Context/extensibility**: `.clinerules` (folder of rule files, toggleable), Memory Bank pattern, workflows/slash commands, skills, hooks, subagents, MCP + marketplace, @file/@folder/@problems/@terminal/@url/@git [training knowledge] ([rules](https://docs.cline.bot/customization/cline-rules.md), [hooks](https://docs.cline.bot/customization/hooks.md), [subagents](https://docs.cline.bot/features/subagents.md)).

**Imitate**: per-tool-call checkpoints with Compare; Kanban board orchestrating *other vendors' CLIs* in worktrees (exactly the model Code-XR can use legally). **Weaknesses**: model-judged "safe command" classification; one task per panel.

---

## 6. Roo Code (Cline fork) — **extension sunset in 2026**

Roo Code announced it is **sunsetting the Roo Code VS Code extension, Roo Code Cloud and Router**, pivoting to **Roomote**, a cloud autonomous agent, arguing "IDEs aren't the future of coding" (≈May 2026) ([roocode.com blog](https://roocode.com/blog/sunsetting-roo-code-extension-cloud-and-router), [daily.dev](https://app.daily.dev/posts/roo-code-pivots-to-cloud-based-agent-says-ides-aren-t-the-future-of-coding-gzvafjdtg), [kilo.ai on the shutdown](https://kilo.ai/compare/roo-code-shutdown-roomote)) [uncertain: exact dates; the sunset blog URL now 302-redirects to roomote.dev, which confirms the pivot but the post text could not be read]. Kilo Code published migration guides ([roo-to-kilo](https://kilo.ai/articles/roo-to-kilo-migration-guide)).

Ideas still worth copying [training knowledge]: **Modes** (Code, Architect, Ask, Debug, **Orchestrator/"Boomerang"**) each with restricted tool groups (read, edit — optionally regex-restricted to file patterns like `\.md$`, command, browser, mcp) and a **sticky model per mode**; custom modes in `.roomodes`/global YAML; Orchestrator spawns **subtasks** in child contexts that return a summary; checkpoints via shadow git (like Cline); codebase indexing (embeddings + Qdrant); context condensing; per-mode rules folders `.roo/rules-<mode>/` ([using modes](https://docs.roocode.com/basic-usage/using-modes)).

---

## 7. Kilo Code

**Status**: open source (MIT). Rebuilt VS Code extension GA **2026-04-02**, now built on **OpenCode server** (the Kilo CLI is an OpenCode fork) so CLI, VS Code and Cloud Agents share one core ([blog.kilo.ai](https://blog.kilo.ai/p/new-kilo-for-vs-code-is-live), [morphllm comparison](https://www.morphllm.com/comparisons/opencode-vs-kilo-code)). JetBrains plugin and cloud agents exist [training knowledge].

**Auth/pricing**: Kilo Gateway (pay-as-you-go at provider list price, 500+ models, some free models) or BYOK [training knowledge]; listed as a **Sign in with ChatGPT** launch partner ([thenewstack](https://thenewstack.io/sign-in-with-chatgpt/)).

**UX** (blog): **Agent Manager** — each tab an independent agent you monitor/switch/step into; **git worktrees** per agent with merge / apply / commit / open PR; multiple agents on one worktree for read-heavy work; **diff review** unified or split with **line-level comments sent back as structured context**; **multi-model comparison** (same prompt, several models side by side); parallel tool calls and parallel/custom subagents; sessions shared across CLI, VS Code and teammates; provider settings in-extension; native **MCP marketplace**; modes merged into "Agents" (OpenCode-style agents: build / plan / custom). Checkpoints: [uncertain] OpenCode uses git-based snapshots with `/undo` `/redo` [training knowledge].

**Weaknesses**: early users reported the rebuild follows instructions worse than v5 (unverified comments).

---

## 8. Aider

[training knowledge; aider.chat not reachable this session] Terminal pair-programmer, Apache-2.0, BYOK (any LiteLLM provider; no subscription login). **Git-native**: every AI edit is auto-committed with a generated message (author marked "(aider)"); `/undo` reverts the last aider commit; dirty files committed first so user and AI changes stay separate — **git itself is the checkpoint system** ([git integration](https://aider.chat/docs/git.html)). **Repo map**: tree-sitter extraction of symbols ranked with a graph (PageRank-like) and fitted to a token budget, giving whole-repo awareness without embeddings. Chat modes `code` / `ask` / `architect` (architect model proposes, cheaper "editor" model writes the edits); multiple **edit formats** (whole, diff, udiff, diff-fenced) chosen per model; `/add`, `/read-only`, `/drop` manage the file set explicitly; `/run`, `/test` with auto-lint/auto-test and fix loops; **watch mode** (`--watch-files`) acts on `AI!` / `AI?` comments written in any editor; voice input; image/URL context; `.aider.conf.yml`, `CONVENTIONS.md` loaded read-only. No MCP/hooks natively [uncertain]. Publishes the widely-cited **Aider LLM leaderboards** ([aider.chat docs](https://aider.chat/docs/)).

**Imitate**: repo map; "AI!" comments in-editor as a trigger; architect/editor model split; auto-commit-per-edit option. **Weaknesses**: no rich UI, no sandbox, manual file-set curation.

---

## 9. Warp

Terminal turned "Agentic Development Environment" (Warp 2.0, mid-2025); **open-sourced its ADE client on 2026-04-28** ([press release](https://www.warp.dev/newsroom/2026/4/28/warp-open-sources-its-agentic-development-environment)); **Oz** (Feb 2026) orchestration platform for cloud coding agents ([Oz launch](https://www.warp.dev/newsroom/2026/2/10/warp-launches-oz-the-orchestration-platform-for-cloud-coding-agents), [blog](https://warp.dev/blog/oz-orchestration-platform-cloud-agents)). **Agents 3.0**: agents get **full terminal use** (can drive interactive programs, REPLs, debuggers), `/plan` with versioned plans, built-in **code review panel** where you comment on agent diffs and send them back, a lightweight file editor ([Agents 3](https://www.warp.dev/blog/agents-3-full-terminal-use-plan-code-review-integration)). Agent Mode with per-action permissions (autonomy levels, command allow/deny lists), **Warp Drive** (shared workflows, notebooks, rules), rules/`AGENTS.md`, MCP, multiple agents in tabs with a management view and notifications [training knowledge]. Pricing: Warp credits subscription + BYOK on higher tiers [training knowledge]; Sign in with ChatGPT launch partner. Warp also explicitly supports running third-party CLI agents (Claude Code, Codex, Gemini CLI) inside its terminal with agent-aware UI (notifications, rich input) [training knowledge/uncertain].

**Imitate**: agent with *real* PTY control; terminal blocks as attachable context; review panel that turns comments into prompts. **Weaknesses**: proprietary cloud, credit pricing.

---

## 10. Cross-cutting patterns

| Concern | Dominant pattern(s) | Who |
|---|---|---|
| Host ↔ agent wiring | **ACP over stdio** (agent subprocess; client serves fs + terminals + permission UI) | Zed, JetBrains, Gemini, Claude/Codex adapters, Kilo/OpenCode |
| | Vendor-specific JSON-RPC (Codex app-server), stream-json CLI (Claude `-p`) | Codex VS Code ext., Claude SDK |
| Subscription use in 3rd-party host | Anthropic & Google: **only via their unmodified binary + their own login flow**; OpenAI: **Sign in with ChatGPT** for partner apps | — |
| Session organisation | Sidebar of threads grouped by project, status (working / needs input / done / unread), archive, search, auto titles, fork/branch | All |
| Parallelism | **git worktree per session/task**, Kanban or agent manager view, merge/commit/PR from UI | Codex app, Claude Desktop, Kilo, Cline Kanban, Warp/Oz |
| Planning | Read-only **plan mode** → approve → choose execution mode; editable plan doc; todo list streamed as structured "plan" updates | Claude, Cline, Roo, Kilo, Warp, Codex (`turn/plan/updated`), ACP `plan` |
| Approvals | Per tool call card: allow once / for session / always (persist rule) / deny; mode cycle (Manual → Accept edits → Plan → Auto); background classifier or reviewer agent | Claude (`auto`), Codex (auto-review) |
| Sandboxing | OS sandbox for shell (Seatbelt, bubblewrap+seccomp, Landlock), network off by default, protected paths (.git, agent config) | Codex, Claude sandboxed Bash, Gemini (Seatbelt/Docker) |
| Diff review | Multi-file review buffer with per-hunk accept/reject; **line comments → follow-up prompt** | Zed, Claude Desktop, Kilo, Cline Kanban, Warp |
| Checkpoints | (a) **file snapshots per prompt** (Claude Code); (b) **shadow git repo** per tool call (Cline, Roo, Gemini `~/.gemini/history`); (c) **real git commits** (Aider) | — |
| Restore UX | Restore code / conversation / both; Compare; re-propose tool call | Claude, Cline, Gemini |
| Rules/memory | `AGENTS.md` converging as cross-tool standard; vendor files `CLAUDE.md`, `GEMINI.md`, `.clinerules`, `.roo/rules-*`; hierarchical (global → project → subdir) | All |
| Context | @file/@folder/@symbol/@diagnostics/@terminal/@url/@thread, selection auto-attach, images paste, auto-compaction + manual `/compact`, token meter | All |
| Extensibility | MCP everywhere; hooks (Claude, Cline, Gemini); subagents; skills (`SKILL.md`, now cross-vendor); plugins/marketplaces | — |

---

## 11. Features to imitate in Code-XR IDE (ranked)

1. **ACP client + agent registry** — implement the client half of ACP (stdio subprocess, `session/update` rendering, `session/request_permission`, `fs/*` served from Monaco models incl. unsaved buffers, `terminal/*` on node-pty, `session/load` for resume). One integration gives Claude Agent, Codex, Gemini CLI, OpenCode, Kilo, etc. *Highest leverage.*
2. **Compliant auth matrix** — per agent: "Use your installed CLI & its own login" (launch the unmodified `claude` / `codex` / `gemini` binaries, IDE never touches tokens), "API key" (stored in OS keychain via Electron `safeStorage`), and for OpenAI optionally "Sign in with ChatGPT" (partner onboarding needed). Show a clear notice that Claude subscriptions only work through the official Claude Code binary. Also provide a plain **"Run in terminal"** fallback for any CLI agent.
3. **Thread sidebar** with project grouping, status badges (working / needs input / done-unread), auto titles, archive, search, fork/"new from summary", OS notifications.
4. **Multi-file review surface** — Monaco diff editors stacked in one scrollable "Review changes" view; per-hunk and per-file accept/reject; **line comments that are sent back as one follow-up prompt**; follow-agent mode that reveals files as they are edited.
5. **Checkpoints** — IDE-owned, agent-agnostic: shadow git repo outside the workspace (Gemini/Cline style, e.g. `<userData>/checkpoints/<project-hash>`), snapshot before each user prompt *and* before each approved write; restore menu "code / conversation / both" + Compare. Being IDE-side also covers shell-made changes that Claude's own checkpoints miss.
6. **Plan mode + todo panel** — render ACP `plan` updates as a pinned checklist; plan shown as an editable Markdown doc with "Approve → run in Manual / Accept-edits / Auto".
7. **Permission UX** — mode switcher under the composer; approval cards with allow once / session / always (writes a rule) / deny; visible allowlist editor; protected paths.
8. **Parallel sessions in git worktrees** with a board/agent-manager view and merge / commit / open-PR actions.
9. **Rich context composer** — @file/@folder/@symbol (from Monaco/LSP)/@problems/@terminal/@git-diff/@thread/@url, selection auto-attach with dismiss, image paste, token meter + compact.
10. **Rules & memory** — read/write `AGENTS.md` first, also surface `CLAUDE.md` / `GEMINI.md`; rules editor UI.
11. **MCP manager** (forwarded to agents over ACP) and skills/slash-command palette fed by ACP `available_commands_update`.
12. **Agent map** for subagents/background tasks (status, elapsed, tokens, stop).
13. Nice-to-haves: side chat (`/btw`), multi-model compare (Kilo), Aider-style `AI!` comment trigger, built-in browser preview pane the agent can screenshot (Claude Desktop), repo map for the native agent.

**Risks to note**: ACP is evolving (v2 draft); adapters for Claude/Codex lag their vendors' native features (slash commands, plan mode); vendor ToS for subscription use change frequently (Anthropic Feb 2026, Google 2026 bans, OpenAI Sept 2026 opening) — re-check before release.
