# Group B market research: incumbent IDE vendors' agent experiences (as of late Nov 2026)

Scope: VS Code + GitHub Copilot, JetBrains (AI Assistant, Junie, Air, ACP), Google Antigravity, Firebase Studio / Gemini Code Assist, Amazon Q Developer (IDE). Written for the design of **Code-XR IDE** (Electron + Monaco, agent-first).

Confidence legend: **[C]** confirmed from an official page fetched during this research; **[S]** secondary source (press/blog/review); **[K]** from prior knowledge (2025-era docs), not re-verified this session — treat as uncertain. Research note: the shared web-fetch budget ran out near the end, so the Amazon Q section leans more on search snippets and [K] items than the others.

---

## 1. VS Code + GitHub Copilot

### 1.1 Positioning and pricing
- VS Code positions itself as a "multi-agent command center": one editor that hosts Copilot's own harness plus Claude and Codex harnesses running on their providers' runtimes, all managed from the same session list ([VS Code Wrapped, Oct 2026](https://code.visualstudio.com/blogs/2026/10/28/vscode-wrapped) [C]; [The New Stack](https://thenewstack.io/vs-code-becomes-multi-agent-command-center-for-developers/) [S]).
- **Billing moved to usage-based credits in June 2026** ([GitHub blog](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/) [S]). Individual plans ([docs](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals) [C]): Pro $10/mo (1,500 AI credits incl. a "flex" allotment), Pro+ $39/mo (7,000), Max $100/mo (20,000). 1 credit = $0.01. Chat, CLI, cloud agent and **third-party agents** consume credits. Completions and next-edit suggestions are unbilled on paid plans. 10% discount when using auto model selection. Free tier: auto model selection only, 2,000 completions/mo.
- Models: Copilot models and **BYOK** in the model picker, with reasoning-effort and context-size options. "Copilot Fusion" picks one model or orchestrates several. "Compare Models (Preview)" runs different models/harnesses on the same task side by side ([Wrapped](https://code.visualstudio.com/blogs/2026/10/28/vscode-wrapped) [C]).
- Bring-your-own-agent: Claude and Codex harnesses run through the **Agent Host**. Existing Claude Code and Codex project setups (CLAUDE.md, `.claude/agents`, etc.) are reused as-is [C].

### 1.2 Layout and UX
- **Chat view** in the secondary side bar lists sessions for the current workspace, grouped by time. Any chat can be popped out with "Open as Editor" (editor tab) or "Open to the Side" ([Manage sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions) [C]).
- **Agents window** (introduced experimentally around v1.129, July 2026, per [Visual Studio Magazine](https://visualstudiomagazine.com/articles/2026/07/16/vs-code-1129-introduces-agent-host-and-experimental-agents-window-editor.aspx?p=1) [S]): a separate window listing sessions **across workspaces**, grouped by workspace, with a **Changes** view, an Inbox, automations, and a multi-host connection to several agent hosts. Editor and Agents window stay in sync on the same session [C].
- **Session list item** shows the name, last-active time and a **count of unreviewed file changes** ([Agent sessions](https://code.visualstudio.com/learn/foundations/agent-sessions-and-where-agents-run) [C]).
- Session lifecycle: close tab (hides), Dismiss from Inbox (moves to Done; new activity brings it back), Archive / Mark done, Delete (permanent, can delete worktrees). Archiving a worktree session **commits uncommitted changes to its branch first**, and restoring re-creates the worktree [C].
- **Nested chats** (sub-conversation grouped under a session, starts with empty history), **forks**, and **side chats** let you branch without disturbing the main thread [C].
- **Session Target picker** at the bottom of the input chooses where the next session runs (Local/Copilot harness, worktree, remote host, cloud). **"Continue In"** hands an active session to another target with its context [C].
- Built-in agents: Agent, Plan, Ask. Custom agents appear in the same dropdown (see 1.4). Plan output can be opened in the **Markdown editor** where you edit the rendered plan and leave comments for the agent [C, Wrapped].
- **Harnesses**: the Copilot harness (Agent Host process, built on the Microsoft Copilot SDK, merges the old in-editor "Local" harness and Copilot CLI) is the default. The Local harness is **deprecated, removed Feb 2027** [C].
- Composer controls: agent dropdown, model picker (with reasoning effort), tools picker, permission-level picker (incl. per-session sandbox toggle), session-target picker, attachments (`#file`, `#selection`, images, etc.) [C/K].
- Other 2026 additions: **Canvases** (interactive agent UIs such as a task board), image generation for assets, Copilot connectors (Slack, Notion, MS Learn without MCP), experimental **computer use** on macOS/Windows, and "Blobby" pet with achievements [C, Wrapped].

### 1.3 Edit review
([Review and revert agent changes](https://code.visualstudio.com/docs/agents/run/review-code-edits) [C])
- Edits are **written to disk immediately** but remain in a *pending-review* state. In the editor, changed regions are highlighted inline with an overlay that has Up/Down navigation and **Keep / Undo per change (hunk), per file, or for all files**. Keep clears review state; it does **not** stage or commit. Staging in SCM also counts as Keep.
- For Claude/Codex harnesses, the Agents window, and cloud sessions: a **changed-files pill opens a multi-diff editor**; the Agents window has a **Changes** view. Accessible Diff Viewer for screen readers.
- `chat.editing.autoAcceptDelay` auto-keeps after N seconds; **hovering pauses the countdown**.
- **Checkpoints** (`chat.checkpoints.enabled`, on by default): before each request VS Code snapshots affected workspace files. Hover an earlier request → **Restore Checkpoint** restores files and drops later turns. Explicitly does **not** undo terminal commands, network calls, or deployments.
- **Edit a previous request** (`chat.editRequests`): reverts file changes from that request onward and resends.
- **Sensitive-file gate**: `chat.tools.edits.autoApprove` with globs, e.g. `"**/.env": false` forces a diff + approval before saving.
- Working set (`chat.editor.workingSet.enabled`, experimental): list of files in play.
- Implementation detail is not documented; the model is "snapshot files before each request + track pending ranges", similar to the Claude Code checkpointing approach ([Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing) [K/S]).

### 1.4 Context and customization
([Customization overview](https://code.visualstudio.com/docs/copilot/customization/overview), [Custom agent file reference](https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference) [C])
- **Always-on instructions**: `.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`.
- **File-scoped instructions**: `.github/instructions/*.instructions.md` (frontmatter `applyTo` glob [K]).
- **Prompt files**: `.github/prompts/*.prompt.md`, invoked as slash commands.
- **Custom agents** (`.agent.md`, successor of `.chatmode.md`): workspace `.github/agents` or `.claude/agents`; user `~/.copilot/agents` or `~/.claude/agents`; org-level via GitHub. Frontmatter: `name`, `description`, `argument-hint`, `tools` (aliases `read`/`edit`/`search`/`execute`), `agents` (allowed subagents), `model` (or fallback list), `model-policy`, `reasoning-effort`, `skills`, `user-invocable`, `disable-model-invocation`, `target`, `handoffs` (label/agent/prompt/send/model buttons shown after a response), `hooks`, `mcp-servers`.
- **Skills** (SKILL.md folders), **hooks** (lifecycle scripts), **plugins** (bundles of skills, agents, hooks, MCP servers from marketplaces), **tool sets**. Scopes: User / Workspace / Organization. An "Agent Customizations editor" UI manages them.
- Memory exists as a documented feature (`/docs/agents/run/memory`) but its format was not verified [uncertain].
- Indexing: workspace semantic index + `#codebase` search [K].

### 1.5 Tool execution and approvals
([Manage approvals](https://code.visualstudio.com/docs/agents/run/approvals), [Sandboxing](https://code.visualstudio.com/docs/agents/run/agent-sandboxing) [C])
- **Permission levels per harness**: Copilot: Manual (default) / **Assisted** (a model triages actions and flags risky ones; custom guidance via `chat.permissions.assisted.instructions`) / Allow all; **Autopilot** is a separate mode. Claude harness: Ask Before Edits / Edit Automatically / Plan / Auto / Bypass. Codex: Default / Auto-Review / Full Access.
- Per-call approval scopes: **Allow Once / In this Session / Always Allow** (persisted per Agent Host).
- Terminal rules: `chat.tools.terminal.autoApprove` map of `pattern → true|false`; prefix matching, `/regex/` anchors, `matchCommandLine` to check the whole line instead of each subcommand; **explicit ask beats allow**. Built-in default safe list can be ignored.
- URL fetch approvals per exact host (`chat.tools.urls.autoApprove`); Local harness separates approving the request vs. the response (prompt-injection guard).
- **Terminal sandbox**: OS-level; Linux/WSL2 via bubblewrap + slirp4netns + iptables; macOS 15+ native; Windows 11 BaseContainer (experimental). Settings for read-write/read-only/denied paths, outbound domain allow/deny, local-network toggle, credential env-var masking, git/gh auth passthrough, MCP and LSP servers sandboxed too. "Allow Outside Sandbox" is a distinct approval. `/sandbox policy` shows the effective policy.
- **Browser**: integrated browser shared by user and agent; agents use Playwright for testing and a11y checks [C, Wrapped].

### 1.6 Background / cloud agents, worktrees, PRs
- Local (Copilot harness, in Agent Host, parallel), worktree, remote (SSH/dev tunnels; survives disconnect), **cloud** (GitHub infra; survives closing laptop; continue in VS Code, GitHub app, Mobile, github.com, CLI) [C].
- Cloud agent flow: clones repo, opens a **draft PR**, pushes commits as it works; repo **Agents tab** on github.com shows status/logs and accepts mid-run steering ([Agent sessions](https://code.visualstudio.com/learn/foundations/agent-sessions-and-where-agents-run) [C]). PR review comments can feed back into the Agents window (`chat.experimental.agentsWindowPRComments`).
- **Automations** for recurring tasks, local or cloud [C].

### 1.7 MCP and external agents
- Full MCP incl. **MCP Apps** (interactive UI returned by MCP servers); extensions can contribute tools and MCP servers via Marketplace [C].
- **Agent Host Protocol (AHP) 1.0**: open protocol for clients to connect to and stay in sync with live agent sessions; anyone can build a client [C]. This is VS Code's answer to multi-client session sync, distinct from ACP (which VS Code does not appear to adopt natively — uncertain).
- External sessions from Copilot CLI, the GitHub Copilot app, Claude Code and Codex appear in the list ("external sessions", filtered by recency) [C].

### 1.8 Ideas worth imitating / weaknesses
- Imitate: pending-review-on-disk model with hunk-level Keep/Undo; checkpoint per request + "edit previous request" rewinds; unreviewed-change counter in the session list; harness-agnostic session list; `.agent.md` with `handoffs`; Assisted permission level; terminal rule semantics (ask beats allow, subcommand splitting); Inbox/Done triage; archive-commits-worktree.
- Weaknesses: feature surface is enormous and fragmented across three harnesses with different permission names and review UIs; Local harness deprecation churn; some features gated per harness (prompt files only in Local); usage-based billing generated complaints ([the-decoder](https://the-decoder.com/github-copilot-switches-to-token-based-billing-in-june-2026/) [S]); known issues e.g. auto-approve rules not honored under some modes ([vscode#324059](https://github.com/microsoft/vscode/issues/324059) [S]).

---

## 2. JetBrains: AI Assistant, Junie, Air, ACP

### 2.1 Positioning and pricing
- JetBrains repositioned as **"coding-agent agnostic"**: one subscription covers Claude Agent (built on the Claude Code SDK / Claude Agent SDK), Codex, Gemini and its own Junie; JetBrains runs no LLM of its own ([JetBrains JP blog, Jun 2026](https://blog.jetbrains.com/ja/blog/2026/06/16/junie-jetbrains-ai-2026/) [C]).
- Pricing: paid IDE licences include **AI Free** (~$3 of credit; completion + commit messages); **AI Pro** unlocks agents; All Products Pack / dotUltimate include AI Pro (10 credits/mo individual, 20 business); top-up credits valid 1 year; tokens priced at vendor API rates. Business credits pooled company-wide from July 2026 via Central Console (renamed **Air Governance**) [C]. The JP blog itself notes heavy users may be better off on a Claude/ChatGPT subscription.
- **ACP agents need no JetBrains AI subscription** — they bill against their own plans ([ACP help](https://www.jetbrains.com/help/ai-assistant/2026.1/acp.html) [C]).
- **BYOK / local models**: "AI providers and API keys" screen; local models in the model selector [C].

### 2.2 Layout and UX
- **AI Assistant chat** ([AI Chat help](https://jetbrains.com/help/ai-assistant/ai-chat.html) [C]): tool window on the right. Controls: **mode/agent selector** (Chat vs an agent; "JetBrains Pick" default chosen from benchmarks), model selector, attachment button (files, folders, images, **symbols, commits**), send options, Chat History / New Chat / **Show Chats in Editor Tabs**.
- **Air (standalone ADE)**, public preview Mar 2026 ([Air launch](https://blog.jetbrains.com/air/2026/03/12/air-launches-as-public-preview/) [C]): built "around the agent rather than the editor". Tasks reference precise code entities (a line, commit, class, method). **One task in focus at a time** with notifications when another needs input. Agents run locally, or isolated in **Docker containers or Git worktrees**, and Air moves the result back. Review shows changes **in the context of the whole codebase** (not only a diff), alongside a terminal, Git client and built-in preview. Codex, Claude Agent, Gemini CLI and Junie out of the box. Later added more agents, local models and Java/Kotlin code intelligence ([Jul 2026 update](https://blog.jetbrains.com/air/2026/07/what-s-new-air-gets-more-agents-local-models-and-java-kotlin-code-intelligence/) [S]) and **Air Teams** ([Sep 2026](https://blog.jetbrains.com/air/2026/09/introducing-air-teams/) [S]).
- **JetBrains Air umbrella** (Sep 22 2026 [announcement](https://blog.jetbrains.com/blog/2026/09/22/introducing-jetbrains-air/) [C]): Air in IDEs + Air Teams (human+agent delivery workflows) + Air Governance (policy, audit, cost) + Junie on every surface. Roadmap: mobile/remote, event- and schedule-triggered work.
- **Air in IDEs (EAP, 2026.3)** ([blog](https://blog.jetbrains.com/ai/2026/10/air-in-ides-eap/) [C]): replaces AI Assistant chat when installed. **Sessions open as editor tabs**; each can be a terminal UI, a graphical chat, or a **full-screen terminal tab** (e.g. Claude Code TUI). **Double-tap Ctrl** opens a prompt popup with current context attached. One list of all sessions **across projects** showing activity, unread updates, changed files, **outgoing commits and cost**. Temporary worktrees + **cherry-pick results into the main project**. Ships no agent; detects installed ones ("Air is a tool window, not an AI provider"). IDE tools and skills (debugger, profiler, code search) exposed to agents.

### 2.3 Edit review
- Agent changes: click a modified file to open its diff; **rollback single file** or **Rollback all**; command widgets have "Open in editor" to inspect the full command before/after running ([Claude Agent help](https://www.jetbrains.com/help/ai-assistant/claude-agent.html) [C]). Chat mode never applies edits (manual apply).
- Air: review in full-codebase context; changes cherry-picked from worktree/container [C].
- Junie (2025-era plugin) used local history/rollback and per-file diff [K].

### 2.4 Context, rules, memory
- **Project rules** in `.aiassistant/rules/*.md` with types **Always / Manually (`@rule:` or `#rule:`) / By model decision (with an instruction) / By file patterns (`*.kt`, `src/**`) / Off** ([Project rules](https://www.jetbrains.com/help/ai-assistant/configure-project-rules.html) [C]).
- **Junie guidelines** ([Guidelines & memory](https://junie.jetbrains.com/docs/guidelines-and-memory.html) [C]): order `.junie/AGENTS.md` → `AGENTS.md` (+ `.junie/playbook.md`, `.junie/rules/*.md`) → legacy `.junie/guidelines.md`; global `~/.junie/AGENTS.md`; both levels included and labelled, project wins on conflict, identical content de-duplicated. **On first open Junie offers to import other agents' guideline/memory files** into `.junie/AGENTS.md`.
- Claude Agent reads `CLAUDE.md`; IDE context toggle auto-attaches open file + selection; `@` adds other files; **context-window usage indicator** [C].
- `.aiignore` excludes files (note: Claude Agent does **not** honour it [C]).
- Advantage claimed: deterministic code intelligence (PSI index) exposed to agents is cheaper and more accurate than agent-side grep [C, Air announcement].

### 2.5 Tool execution
- Junie action allowlist ([docs](https://junie.jetbrains.com/docs/action-allowlist.html) [C]): approval required by default for terminal, RunTest/Build, Preview, MCP tools, files outside project, editing build scripts, editing config/hidden files (`.idea/`, `.env`, `.claude/`), reading secret-like files. Rules: exact command, **Java regex** (doc example blocks `; | & < > @ $` to prevent chaining), or "all of a type". `ls/cd/pwd` free, but chains still ask. ("Brave mode" from 2025 not found in current docs [uncertain].)
- Claude Agent in JetBrains: Allow once / Always allow / Deny; modes Auto, Manual (default), Accept edits, Plan, Bypass [C].

### 2.6 Background / cloud
- Junie moved to a **CLI-based architecture** (IDE plugin's final version 2026.2) with Plan, Debug, Remote modes, worktree support and a code-review mode [C, JP blog]. Cloud runs need a JetBrains AI subscription; Air cloud sandboxes in tech preview [C].

### 2.7 MCP and ACP
- **ACP** (Agent Client Protocol, co-developed with Zed; JetBrains joined Oct 2025 — [Zed blog](https://zed.dev/blog/jetbrains-on-acp), [Tessl](https://tessl.io/blog/jetbrains-joins-agent-client-protocol-to-open-ai-coding-agents-to-any-ide/) [S]). JSON-RPC over stdio between IDE (client) and agent (server). JetBrains calls it "the LSP moment for AI agents" ([WebStorm blog](https://blog.jetbrains.com/webstorm/2026/08/the-lsp-moment-for-ai-agents-webstorm-acp/) [S]).
- In AI Assistant ([ACP help](https://www.jetbrains.com/help/ai-assistant/2026.1/acp.html) [C]): **ACP Registry** — install curated agents from inside the IDE; the IDE downloads them and **manages the Node/Python runtime**, shows update dots. Custom agents via `~/.jetbrains/acp.json`:
  ```json
  { "default_mcp_settings": { "use_custom_mcp": true, "use_idea_mcp": false, "idea_mcp_allowed_tools": [] },
    "agent_servers": { "My Agent": { "command": "...", "args": [], "env": {} } } }
  ```
  IDE auto-detects agents on PATH ("Add to configuration"). Agents get the user's MCP servers and optionally the IDE's own MCP server (filtered tool list). Not supported in WSL. "Get ACP Logs" for debugging.
- Third-party ACP agents listed include Cursor and GitHub Copilot (billing against their own plans) [C, JP blog].

### 2.8 Ideas / weaknesses
- Imitate: ACP registry with managed runtimes; `acp.json` shape; rule types (always/manual/model-decision/glob); guideline import from other agents; sessions-as-editor-tabs with "terminal UI or graphical chat" per session; double-tap prompt popup with context; per-session cost and outgoing-commits columns; cherry-pick from worktree; exposing IDE semantic tools to any agent via MCP.
- Weaknesses: brand churn (AI Assistant → Junie plugin → Junie CLI → Air; Central → Air Governance; Agent Workbench merged into Air); AI Assistant and Air are mutually exclusive; ACP agents get only a subset of features (e.g. Junie CLI via ACP); credit model confusing; `.aiignore` not honoured by third-party agents.

---

## 3. Google Antigravity

### 3.1 Positioning and pricing
- Launched **Nov 18 2025** as a free preview: a VS Code fork with an **Agent Manager** "mission control" ([Google Developers blog](https://developers.googleblog.com/en/build-with-google-antigravity-our-new-agentic-development-platform/) [S]).
- **Antigravity 2.0 (Google I/O, May 19 2026)** ([official blog](https://www.antigravity.google/blog/introducing-google-antigravity-2) [C]; [TechCrunch](https://techcrunch.com/2026/05/19/google-launches-antigravity-2-0-with-an-updated-desktop-app-and-cli-tool-at-io-2026/) [S]): a **standalone desktop app with "no IDE"** (agent-first), plus Antigravity CLI (replaces Gemini CLI for individuals by Jun 18 2026), SDK and API/Managed Agents. The IDE remains (recommended for developers) but **the Agent Manager will be removed from the IDE**; Google recommends pairing 2.0 with another IDE and is building extensions for other IDEs.
- Pricing: free tier with weekly caps; Google AI Pro $20/mo; AI Ultra 5x $100/mo; Ultra 20x $200/mo (was $249.99); extra credits $25 per 2,500 ([DEV review](https://dev.to/jovan_chan_9500711396d4e6/google-antigravity-20-review-2026-browser-subagent-20month-pro-and-the-quota-problem-6ob) [S]; [The Register](https://www.theregister.com/2026/03/12/users_protest_as_google_antigravity/) [S]). Business via Google Cloud licences or pay-as-you-go ([codelab](https://codelabs.developers.google.com/getting-started-google-antigravity) [C]).
- Models: Gemini 3.x (3.5 Flash default per review), Claude Sonnet/Opus (review says requires own Anthropic key in 2.0 — **uncertain**, at 2025 launch Claude was included), GPT-OSS 120B [S].

### 3.2 Layout and UX
- **Projects** (one or more folders, own isolated agent settings/permissions) contain **conversations**; Conversation History; standalone conversations ([codelab](https://codelabs.developers.google.com/getting-started-google-antigravity) [C]).
- 1.x layout [K/S]: two surfaces — **Editor** (VS Code-like with an Agent side panel) and **Agent Manager** (Inbox of conversations across workspaces, "Playground" for scratch tasks), switchable with a shortcut; modes **Planning** (produces artifacts) vs **Fast**.
- 2.0 slash commands: `/plan`, `/goal` (run to completion without intermediate prompts), `/grill-me` (agent asks clarifying questions first), `/schedule` (recurring/one-off timers), `/browser`; `/generative_ui` produces interactive HTML widgets [C].
- Subagents spawned by the main agent; async background tasks; **JSON hooks**; scheduled tasks; live-transcribed voice input [C].

### 3.3 Artifacts and edit review
- **Artifacts** ([docs](https://www.antigravity.google/docs/artifacts) [C]): task lists, implementation plans (rich Markdown), walkthroughs, code diffs, architecture diagrams, images/screenshots, **browser recordings**, interactive HTML widgets. Reviewed in a sidebar + review pane; **inline comments on artifacts (Google-Docs-style) steer the agent before it touches files**. Review policy: require review vs **"Always Proceed"** [C]. The CLI has a keyboard-driven review panel with a status-bar notification.
- Users can also comment on regular files (e.g. `package.json`) as feedback [C].
- Diffs: "review flow for changes" in 2.0; 1.x had per-file accept/reject in the editor [S/K].

### 3.4 Context
- Skills: `SKILL.md` folders; global `~/.gemini/config/skills/`, project `<root>/.agents/skills/`; loaded only when description matches [C].
- Rules / workflows (1.x: `.agent/rules`, `.agent/workflows`; global `GEMINI.md`) [K, uncertain for 2.0]. "Knowledge items" (auto-captured memory) existed in 1.x [K].

### 3.5 Tool execution and sandbox — the most rigorous model in this group
([Permissions](https://antigravity.google/docs/permissions/?tab=2-0), [Sandbox](https://antigravity.google/docs/sandbox?tab=cli) [C])
- Every sensitive operation is a resource `action(target)`: `command(git)`, `read_file(path)`, `write_file(path)`, `read_url(domain)`, `execute_url` (browser navigation, localhost isolated per port), `download_url`, `mcp(server/tool)`, `unsandboxed`. Three lists **Deny > Ask > Allow**.
- Presets: **Request Review** (no sandbox, commands always ask), **Default** (sandboxed; network/host needs approval), **Auto** (sandboxed; out-of-sandbox commands auto-evaluated: safe/reversible proceed, risky ask), **Turbo** (no sandbox, everything allowed). Custom rules layer on top.
- Terminal matching: word-by-word prefix or `regex:`; constructs that hide execution (`$(...)`, backticks, brace expansion, sub-command flags) disable prefix matching; pipelines/chains are split and evaluated.
- In an approval prompt you can **widen the target** (file → parent folder) for file/URL/MCP requests.
- Browser uploads always need one-time approval, even in Turbo.
- Sandbox: Linux namespaces; macOS `sandbox-exec` Seatbelt profiles; Windows AppContainer. No network by default; `read_url` grants populate the outbound allowlist; `read_file`/`write_file` grants become mounts; `~/.ssh`, `.env` blocked; unmounted paths invisible.
- **Browser subagent**: Chrome (debug session) driven by a sub-agent that clicks, types, screenshots, records video; a Chrome extension in 1.x [C/S].

### 3.6 Background / cloud
- Async tasks, scheduled tasks, Managed Agents API (pay-per-run). Roadmap: Remote Control, cloud-deployed agents [C].

### 3.7 MCP / external agents
- Local and remote MCP, one-click Google Cloud servers, per-server and per-tool toggles; config `$HOME/.gemini/config/mcp_config.json` [C]. SDK for custom agents [S]. No ACP mention found [uncertain].

### 3.8 Ideas / weaknesses
- Imitate: artifact-first review (plan/task list/walkthrough as commentable docs); browser recordings as verification evidence; `action(target)` permission grammar with presets + Deny>Ask>Allow; approval-prompt target widening; `/grill-me`, `/goal`, `/schedule`; projects spanning multiple folders with per-project permissions.
- Weaknesses: repeated unannounced quota cuts and multi-day lockouts ([Register](https://www.theregister.com/2026/03/12/users_protest_as_google_antigravity/) [S]); Open VSX only (no MS Marketplace); bugs in auto-execute/Turbo ([forum](https://discuss.ai.google.dev/t/antigravity-turbo-mode-broken/171183) [S]); product churn (IDE → standalone app; Agent Manager leaving the IDE); no published SOC 2 as of May 2026 [S].

---

## 4. Firebase Studio / Gemini Code Assist

### 4.1 Firebase Studio — being sunset
- ([Migration doc](https://firebase.google.com/docs/studio/migrating-project) [C]) Sunset announced **Mar 19 2026**; no new workspaces/sign-ups since **Jun 22 2026**; **shutdown Mar 22 2027** with data deleted. Targets: **Antigravity** (code-first) or **Google AI Studio** (browser prototyping; exportable to Antigravity).
- What it was: a cloud VS Code (Code OSS) workspace with an **App Prototyping agent** (prompt → full-stack Next.js app with live preview, "Prototyper mode") and Code View with Gemini agents; publishing via App Hosting [C]. Lesson: a browser-only agent IDE was folded into a local agent app.

### 4.2 Gemini Code Assist (VS Code / IntelliJ extension)
- ([Agent mode docs](https://docs.cloud.google.com/gemini/docs/codeassist/use-agentic-chat-pair-programmer) [C]) Agent mode is still **Pre-GA**. In VS Code it **runs on Gemini CLI** and the docs themselves say it "is not optimized for the latest Gemini models" and recommend **Antigravity CLI** — i.e. Google is steering users away.
- UX: Agent toggle in the chat (VS Code) / Agent tab (IntelliJ). Permission prompt before each tool; YOLO via `geminicodeassist.agentYoloMode` (trusted workspaces only) or "Auto-approve changes" (IntelliJ).
- Context: `GEMINI.md` at user (`~/.gemini/GEMINI.md`), project and component scopes; IntelliJ also reads `AGENT.md`. MCP in `~/.gemini/settings.json` (VS Code) or `mcp.json` (IntelliJ). Slash commands `/tools`, `/mcp`, `/deploy` (Cloud Run).
- Mar 2026 update ([Google Developers blog](https://developers.googleblog.com/en/unleash-your-development-superpowers-refining-the-core-coding-experience/) [C]): agent Auto Approve, **inline diff where you can edit, accept or reject per line**, custom slash commands / saved prompts, **Context Drawer** (manage files in context), **Revert to Checkpoint** (in chat).
- Pricing: free individual tier with daily quotas; Standard/Enterprise editions; can add a Gemini/Vertex API key after quota [C/K].
- Weakness: second-class to Antigravity; warning that changes made outside the IDE cannot be undone.

---

## 5. Amazon Q Developer (IDE)

### 5.1 Positioning — end of life
- AWS announced end of support for the Q Developer **IDE plugins on Apr 30 2027**; successor is **Kiro** (agentic IDE, Code OSS fork) ([AWS doc](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-developer-ide-end-of-support.html) [C]; [AWS blog](https://aws.amazon.com/blogs/devops/amazon-q-developer-end-of-support-announcement/) [S]). Pricing historically Free tier + Pro $19/user/mo [K].
- Kiro's distinctive ideas [K/S, uncertain details]: **spec-driven development** (requirements → design → tasks Markdown in `.kiro/specs`), **steering** files (`.kiro/steering/*.md`), **agent hooks** triggered by file events, Autopilot vs Supervised modes ([enterprisedna](https://enterprisedna.co/resources/news/aws-kiro-replaces-amazon-q-developer-spec-driven-2026) [S]).

### 5.2 Layout and UX
- Chat panel from the Q icon; **each conversation in its own tab (up to 10)**, context not shared across tabs; current file auto-attached; `/clear`, `/compact`, `/help`; **send instructions while the agent is working** and it incorporates them ([Chat doc](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-in-IDE-chat.html) [C]).
- **Agentic coding on by default**, toggled with a `</>` icon [C].
- Context [K]: `@workspace`, `@file`, `@folder`, `@code` (symbols), `@prompts` (saved prompts in `~/.aws/amazonq/prompts`), **pinned context**, images; project rules in `.amazonq/rules/*.md` shown in a Rules picker; model picker (Claude family) ([context features blog](https://aws.amazon.com/blogs/devops/amazon-q-developers-new-context-features/) [S]).

### 5.3 Edit review
- Agent edits files directly; per-file **diff and Undo** in the chat card; "undo all" at end of turn [C/K]. Shell commands: it suggests them and **runs some low-risk ones on its own** [C]; others show Run / Reject buttons [K].

### 5.4 Tools / MCP
- MCP in IDE ([docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/qdev-mcp.html) [S]) with per-tool permission (Ask / Always allow / Deny) [K] and admin **MCP governance** ([docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/mcp-governance.html) [S]).
- Security weakness: a **July 2026 CSA research note** describes MCP auto-execution in Amazon Q becoming an attack path ([CSA](https://labs.cloudsecurityalliance.org/research/csa-research-note-amazon-q-mcp-auto-execution-20260707-csa-s/) [S], details not read).

### 5.5 Ideas / weaknesses
- Imitate: tabs-per-conversation with explicit isolation; mid-run steering messages; saved prompts as `@prompts`; rules picker; `/compact`.
- Weaknesses: being retired; low autonomy controls; MCP auto-execution concerns.

---

## 6. Cross-cutting patterns (late 2026)

1. **Sessions are the primary object, not the chat panel.** Every vendor converged on a session list with state (working / needs input / done / archived), unread markers, changed-file counts, sometimes cost and outgoing commits. Two surfaces: an in-editor panel for the current workspace and a cross-workspace "mission control" (VS Code Agents window, Antigravity app, JetBrains Air). Sessions can be popped into editor tabs.
2. **Harness-agnostic hosting.** The IDE is a host for many agent runtimes: VS Code (Agent Host + AHP; Claude/Codex harnesses), JetBrains (ACP + registry; Air ships no agent), Antigravity (SDK, CLI). The open standard for "plug any agent into any editor" is **ACP** (Zed + JetBrains; JSON-RPC over stdio; agents like Claude Code via `claude-code-acp`, Codex, Gemini CLI, Junie, Copilot).
3. **Isolation via git worktrees** (all three leaders) and optionally containers (Air Docker) or cloud sandboxes; results come back by merge/cherry-pick/PR. Archiving commits WIP to the branch (VS Code).
4. **Review = pending changes already on disk** with per-hunk/per-file/all Keep/Undo (VS Code, Gemini), or multi-file diff + per-file rollback (JetBrains, Q). Multi-diff editors for non-native harnesses.
5. **Checkpoints per user turn** (snapshot touched files before the request); restore drops later turns; edit-and-resend rewinds; none undo side effects (terminal/network) and all say so.
6. **Plans as editable/commentable documents** (Antigravity artifacts; VS Code Markdown plan editor with comments; Kiro specs). Planning mode/`/plan` is universal.
7. **Instruction files converge on AGENTS.md**, with vendor files still read: `copilot-instructions.md`, `CLAUDE.md`, `GEMINI.md`, `.junie/AGENTS.md`, `.aiassistant/rules`, `.amazonq/rules`. Rule scoping by glob / always / manual / model decision. **Skills (SKILL.md)** adopted by VS Code and Antigravity. Hooks (JSON/scripts) everywhere.
8. **Permissions moved from "approve each call" to policy**: presets (Manual/Default/Auto/Turbo; Assisted/Auto-review uses a model as reviewer), allow/ask/deny rule lists where **deny > ask > allow**, subcommand-aware matching that refuses to prefix-match `$(...)`, scopes Once/Session/Always, and **OS-level terminal sandboxes** (bubblewrap/namespaces, Seatbelt, AppContainer) with network allowlists. Sensitive files (`.env`, keys, config) always gated.
9. **Browser as an agent tool** with evidence: Playwright in VS Code's integrated browser; Antigravity browser subagent with screenshots and recordings.
10. **Background, scheduled and cloud runs** with PR output and mid-run steering (Copilot cloud agent, Antigravity scheduled tasks, Air automations, Kiro hooks).
11. **MCP is table stakes**; per-server/per-tool toggles; MCP Apps (UI from tools); IDE exposes its own semantic tools as an MCP server to agents (JetBrains IDE MCP).
12. **Pricing shifted to credits/usage**, causing backlash (Copilot June 2026, Antigravity quota cuts); BYO agent/BYOK lets users bring existing subscriptions.
13. **Consolidation**: Firebase Studio → Antigravity/AI Studio; Q Developer → Kiro; Junie plugin → Junie CLI; Gemini Code Assist agent → Antigravity CLI.

---

## 7. Features to imitate in Code-XR IDE (ranked)

Ranked by value for an Electron + Monaco agent-first IDE versus implementation cost.

1. **ACP client (bring-your-own-agent).** Implement the Agent Client Protocol host: spawn agents over stdio from an `acp.json`-style config (`agent_servers: {name: {command, args, env}}`), auto-detect installed CLIs (Claude Code via its ACP adapter, Codex, Gemini CLI, etc.), pass through the user's MCP servers. Gives Claude Code/Codex/Gemini on day one without building a harness. (JetBrains, Zed.)
2. **Session list as the main navigator.** Per-workspace list in the chat side panel + "open as editor tab"; each row shows status (working / needs input / done), unread dot, changed-files count, (optional) cost. Inbox → Done → Archive lifecycle; new chat per tab with isolated context. (VS Code, Air, Q.)
3. **Pending-changes review in Monaco.** Edits land on disk but are tracked as pending: inline decorations with Keep/Undo per hunk, per file, all; a changed-files pill opening a multi-file diff editor (Monaco `DiffEditor`); "next change" navigation. Keep ≠ commit. (VS Code.)
4. **Per-turn checkpoints + rewind.** Snapshot files touched in each turn (shadow copies or a hidden git ref); "Restore checkpoint" on any user message, and "edit & resend" that rewinds first. State clearly that commands/network are not undone. (VS Code, Claude Code, Gemini.)
5. **Permission policy with presets and rules.** Presets Ask / Accept-edits / Auto / Full-access; rule lists Deny > Ask > Allow over `command(...)`, `write_file(...)`, `read_url(...)`, `mcp(server/tool)`; approval scopes Once / Session / Always; subcommand splitting and refusal to prefix-match `$(...)`/backticks; sensitive-file globs (`.env`, keys) always ask. (Antigravity grammar + VS Code semantics.) Surface the agent's own permission modes when using ACP agents (ACP `session/request_permission`).
6. **Instructions & rules discovery.** Read `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `GEMINI.md`, `.junie/AGENTS.md`; scoped rules with `applyTo` globs; show which ones are active in the composer. Offer "import from other agents" (Junie). (All.)
7. **Composer controls.** Agent picker, model picker (+reasoning effort), mode (Ask / Plan / Agent), `@`-mentions for files, folders, symbols (from Monaco/LSP), selection, terminal output, git commits, images; slash commands from prompt files; **context-usage meter**; send-while-running steering. (VS Code, JetBrains, Q.)
8. **Plan as a commentable document.** Plan mode writes a Markdown plan rendered in the editor; user leaves inline comments and the agent revises before executing. Same viewer can show task lists and walkthroughs. (Antigravity artifacts, VS Code plan editor, Kiro specs.) Pairs naturally with the user's requested Markdown viewer.
9. **Worktree isolation per session.** "New worktree" option per session; archive commits WIP to the branch; "apply/cherry-pick to main" action; show outgoing commits per session. (VS Code, Air.)
10. **MCP manager.** UI to add/enable servers and individual tools (workspace `.vscode/mcp.json`/`mcp.json` compatible), with per-tool permission. Optionally expose the IDE's own tools (open files, diagnostics, symbol search) as an MCP server to ACP agents. (All; JetBrains IDE MCP.)
11. **Terminal sandbox (later).** bubblewrap on Linux, `sandbox-exec` on macOS, network allowlist; per-session toggle and "run outside sandbox" approval. High value, high cost — phase 2. (VS Code, Antigravity.)
12. **Browser tool + evidence.** Built-in preview pane the agent can drive (Playwright/CDP via Electron `webContents`), capturing screenshots for the review. (Antigravity, VS Code.)
13. **Custom agents / handoffs.** `.agent.md` (or `.claude/agents`) files with tools/model/description, and handoff buttons (e.g. Plan → Implement). (VS Code.)
14. **Quick prompt popup** (double-tap Ctrl / Cmd-I) that opens a floating composer with current file + selection attached. (Air.)
15. **Scheduled/background tasks and `/goal`, `/grill-me` style commands** — nice-to-have once sessions and permissions are solid. (Antigravity.)

Things to avoid (lessons): multiple overlapping harnesses with different permission vocabularies (VS Code), mutually exclusive chat plugins (JetBrains AI Assistant vs Air), opaque quotas (Antigravity), auto-executing MCP tools without policy (Amazon Q CSA note), and checkpoint UIs that imply side effects are undone.
