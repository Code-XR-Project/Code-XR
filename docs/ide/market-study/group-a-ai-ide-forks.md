# Agent-first IDE market research, group A: Cursor, Windsurf/Devin Desktop, Trae, Void, Kiro

Research date: 2026-11-27. Prepared for the design of **Code-XR IDE** (Electron + Monaco).

**How confident each claim is.** Every claim is labelled:
- **[V]**: verified this session against a fetched page, which is cited.
- **[S]**: comes only from a search-result title, or from a secondary article.
- **[K]**: prior knowledge from training, current to about early 2026. Not re-verified for late 2026, so it may be out of date.

The shared web-fetch budget ran out partway through the session. As a result, **Cursor and Windsurf/Devin Desktop are well verified, while Kiro, Trae and Void lean on [K] and [S]**. The "Gaps" section at the end lists what to re-check.

---

## 1. Cursor (Anysphere; acquisition by SpaceX announced 2026)

### Positioning and pricing
- **Ownership.** SpaceX (which absorbed xAI in February 2026) signed a binding all-stock deal in June 2026 to acquire Anysphere at a $60B valuation. Closing was expected in Q3 2026. [V] https://thenextweb.com/news/spacex-cursor-acquisition-official-60-billion
- **Effect on the model lineup.** The house models are now xAI ones: Grok 4.5/4.6/4.7 and Composer 2.5. [V] https://cursor.com/docs/models-and-pricing.md
- **Current plans.** [V] (same page)
  - Free.
  - Plus: $8/mo.
  - Premium: $30/mo (4x Plus).
  - Super: $100/mo (15x).
  - Ultra: $200/mo (50x).
  - Teams: $30, $100 or $200 per seat.
  - Enterprise.
- **Usage pool.** One weekly pool covers Cursor models across Agent, CLI and Cloud Agents.
- **Third-party models.** These include Anthropic, OpenAI, Google, Kimi, DeepSeek, GLM and Meta. They are billed at API list price from prepaid credit, on Premium and above. Plus does not allow your own API keys.
- **"Auto" router.** It has Cost, Balance and Intelligence modes.
- **This pricing replaces the 2025 Pro/Pro+/Ultra scheme.** Treat older articles as historical.
- **Reported usage mix.** Agent users now outnumber Tab-completion users two to one. Cloud agents write 35% of the PRs merged by Cursor's own team. [V, via InfoQ] https://infoq.com/news/2026/04/cursor-3-agent-first-interface/

### Layout and UX
- **Cursor 2.0 (2025-10-29).** [V] https://cursor.com/en-US/changelog/2-0
  - A new "agent-centric" layout with a sidebar for agents and plans.
  - Up to 8 agents can run in parallel on one prompt. Each works in its own copy of the code, using a git worktree or a remote machine.
  - Introduced the Composer model and voice mode.
  - Files and folders appear as inline "pills" in the prompt.
  - Several @-context items were removed (@Definitions, @Web, @Link), because "the agent now gathers context itself".
- **Cursor 3 "Agents Window" (2026-04-02).** [V] https://cursor.com/en-US/blog/cursor-3
  - A new full-screen interface "built from scratch around agents", described as inherently multi-workspace. The classic IDE is still one switch away.
  - One sidebar lists all local and cloud agents, wherever they were started: desktop, web, mobile, Slack, GitHub or Linear.
  - Sessions can be handed off between local and cloud in either direction.
  - Cloud agents return demos and screenshots as proof of their work.
  - A simplified diffs view supports stage, commit and PR management.
  - A built-in browser can open and drive local sites.
  - Full LSP navigation is still available.
  - A plugin marketplace bundles MCP servers, skills and subagents, with private team marketplaces.
  - Opened via Cmd+Shift+P → "Agents Window".
- **Agent tabs.** Agents are tiled side by side or in a grid. Each runs in a local worktree, a cloud sandbox or an SSH remote. "Design Mode" shows a rendered page where you can annotate elements. [S] https://dev.to/gabrielanhaia/cursor-3-glass-replaced-composer-with-an-agents-window-1pcg
- **Multitask, worktrees and multi-root (2026-04-24).** [V] https://forum.cursor.com/t/multitask-worktrees-and-multi-root-workspaces/158954
  - `/multitask` runs parallel asynchronous subagents and can split a large task into chunks.
  - Worktrees run in the background, and "move to local foreground with one click" brings one forward.
  - One agent session can span several folders (multi-root).
- **Composer and chat controls.** [V] https://cursor.com/docs/agent/overview.md
  - **Message queue.** Enter queues a message; queued messages can be dragged to reorder. Cmd+Enter or "Send now" steers the current turn at its next tool call.
  - **Side chats** (`/side`, `/btw`). Durable child conversations that use the parent thread as hidden context. You @-mention a side chat to pull its context back into the main thread.
  - **`/goal`** sets a long-lived objective, and the `/loop` skill repeats a prompt on an interval.
  - **Custom modes** act as playbooks.
  - **Search.** A local index makes transcript history searchable (Cmd+K), and Cmd+F searches within a chat.
- **Modes.** Agent, Ask, Plan and (since about 2.2) Debug, plus custom modes. [K; only custom modes were confirmed on the fetched page]
  - Plan mode writes an editable Markdown plan with to-dos, which can then be built.
  - Since 2.0 one model can plan while another builds, in the foreground or background. [V, 2.0 changelog]
- **Recent additions.** [V] https://cursor.com/zh-Hant/changelog
  - Voice chat with cloud agents (2026-11-06).
  - Cloud agents that build and deploy live apps with Postgres and SSO (2026-11-05).
  - Agent SDK GA (2026-10-20). An agent is a folder; it is triggered by PRs, Slack, webhooks or cron; MCP servers live in `mcp-connections/`; it includes evals.
  - Cloud-agent "canvases" and an Environments API (2026-10-16).

### Edits, review and checkpoints
- **Multi-file review (2.0).** Changes across many files can be viewed in one place, without opening each file. [V, 2.0 changelog]
- **Keep/undo.** Per-file and per-hunk keep/undo inside the editor, with a review bar. [K]
- **Checkpoints.** [V] https://cursor.com/docs/agent/overview.md
  - Created automatically "before making significant changes", capturing all modified files.
  - Stored **locally and separately from Git**.
  - Restore from the timeline, or with "Restore Checkpoint" on an earlier message.
  - Restoring reverts files but keeps the conversation.
  - The implementation is not public. It appears to be a file-snapshot store, not a shadow git repository. [inferred]
- **Bugbot.** A GitHub PR-review bot. [K]

### Context
- **Codebase index.** [V] https://cursor.com/blog/secure-codebase-indexing (2026-01-27)
  - A Merkle tree of file hashes, so only changed branches re-sync.
  - Code is split into syntactic chunks, embedded, and cached by chunk content.
  - A new teammate's index is bootstrapped from a similar existing one, found by simhash, so time to first query falls from hours to seconds.
  - Results are filtered by content proofs, so no one sees code they do not have locally.
- **Rules.** [V] https://cursor.com/docs/rules.md
  - `.cursor/rules/*.mdc` files with frontmatter fields `alwaysApply`, `globs` and `description`. These give four activation types: Always, file-glob, Intelligent (the model decides from the description) and Manual (@-mention).
  - User Rules, plus Team Rules from the dashboard, which can be enforced.
  - `AGENTS.md` at the root and nested in subdirectories; the more specific file wins.
  - Precedence: Team → Project → User.
- **Memories.** The current rules documentation presents rules, not memories, as the way to persist context. Memories (launched in 1.0, 2025) may have been folded into rules. [uncertain]
- **Other context.** Web search tool, image input, and image generation saved to `assets/`. [V, agent overview]

### Tool execution
- **Run modes** (Settings > Agents > Approvals & Execution). [V] https://cursor.com/docs/agent/run-modes
  - **Auto-review** (recommended). Allowlisted calls run directly. Other shell commands run in the **sandbox** when possible. Anything else goes to a **classifier**, which is "not a security boundary".
  - **Allowlist.** Deterministic, with no classifier.
  - **Run Everything.**
  - Extra protections apply in every mode: Browser, File-Deletion and External-File protection. Reading a file outside the workspace shows an approval card with the full path and the reason.
- **Sandbox network.** Blocked by default. Settings are `sandbox.json` only, `sandbox.json` plus defaults for package registries, or Allow All. The sandbox protects `.git/config` and `.git/hooks`.
  - Sandboxed terminals became GA on macOS in 2.0, with read/write access to the workspace and no internet. [V, 2.0 changelog]
- **Hooks.** [V] https://cursor.com/docs/hooks.md
  - Config is `hooks.json` at four levels: enterprise (MDM), team, project (`.cursor/hooks.json`) and user (`~/.cursor`).
  - Events include `sessionStart`/`End`, `preToolUse`/`postToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop` and subagent events.
  - Each hook gets JSON on stdin and writes JSON to stdout, returning `allow`, `deny` or `ask`. When responses merge, deny beats ask, and ask beats allow.
  - Exit code 2 blocks the action. Hooks fail open unless `failClosed` is set.
  - `stop` can return a `followup_message`.
- **Browser.** GA in 2.0. It can be embedded, and you can select a page element and send its DOM to the agent. [V, 2.0 changelog]

### Background agents and PRs
- **Cloud Agents** (formerly Background Agents). They run on VMs, can be started from Slack, GitHub or Linear, open PRs, produce demos, and can be handed off to local. [V]
- **Parallel isolation.** Worktrees isolate parallel local agents. [V]

### MCP and extensions
- **MCP.** Supported throughout: in plugins and in the Agent SDK's `mcp-connections/` folder. [V]
- **Extensions.** A VS Code fork. The marketplace moved to **Open VSX** in 2025, after Microsoft enforced its marketplace terms. Some Microsoft extensions (C/C++, Pylance, Remote) are unavailable or replaced with forks. [K]

### Distinctive features and complaints
- **Worth imitating:**
  - A unified agent inbox that collects agents from every surface.
  - Message queueing and mid-turn steering.
  - Side chats.
  - Checkpoint restore that keeps the conversation.
  - A sandbox plus classifier plus allowlist approval model.
  - Rich hook events.
  - Live-app canvases.
- **Complaints:** [V] InfoQ; [S] dev.to
  - The IDE identity is being lost.
  - The cognitive load of reviewing many agents.
  - Cost. Parallel agents multiply spend, and frontier models moved behind Max Mode in March 2026.
  - Pricing churn.
  - Lock-in.

---

## 2. Windsurf → Devin Desktop (Cognition)

### Positioning and pricing
- **History.**
  - Cognition acquired Windsurf in July 2025, after Google licensed the technology and hired its leadership. [S/K]
  - **Windsurf 2.0 (2026-04-15)** added the **Agent Command Center** and bundled the Devin cloud agent. [V] https://testingcatalog.com/windsurf-2-0-adds-devin-and-agent-command-center/
  - **2026-06-02:** an over-the-air rebrand to **Devin Desktop**; windsurf.com now redirects to devin.ai.
  - **Cascade** was deprecated on 2026-07-01 in favour of **Devin Local**, which was rewritten in Rust and shares its harness with Devin CLI. [S] https://dev.to/jovan_chan_9500711396d4e6/windsurf-is-now-devin-desktop-what-the-june-2-rebrand-agent-command-center-default-surface-and-5d0i
  - Official FAQ: "same IDE, same editor"; pricing is unchanged; Devin Cloud is a separate SKU. [V] https://docs.devin.ai/desktop/devin-desktop-faq.md
- **Pricing.** Free, Pro $20, Max $200 and Teams $40 per user, credit-based. [S, dev.to]
- **Models.** Own models SWE-1.5 (Oct 2025, ~950 tok/s via Cerebras) and SWE-grep, plus frontier models from a picker under the input box. [S] https://dev.to/digitalapplied/windsurf-swe-15-cascade-hooks-complete-developer-guide-20fh; [V, picker] https://docs.devin.ai/desktop/cascade.md

### Layout and UX
- **Agent Command Center (ACC).** [V] https://docs.devin.ai/desktop/agent-command-center
  - The **default screen on launch**: a Kanban board of local and cloud sessions grouped by status (in progress, blocked, ready for review). The classic editor is one step away.
  - **Spaces** group the sessions, PRs, files and context for one task.
  - **Sidebar.** Lists every session per workspace, with filter, sort and group, a context menu, and rename on double-click.
  - **Session controls.** A session is read-only while its agent runs. A session can be duplicated to explore an alternative. Queued messages can be edited. Cmd/Ctrl+L adds the selection to the chat.
  - **Notifications.** One native OS notification per session when it finishes or needs input. Off by default.
- **Devin Local.** [V] https://docs.devin.ai/desktop/devin-local/overview.md
  - **Modes:** Code, Smart, Ask, Plan and Bypass Permissions.
  - **Subagents** run in the foreground or background, with custom ones in `agents/<name>.md`.
  - **Quick Review** is a subagent that gives fast feedback on changes.
  - **Sharing:** `/share` uploads a sanitised transcript and returns a link.
  - A Customizations surface shows what the session has loaded.
- **ACP (Agent Client Protocol).** External agents such as Codex, Claude Agent and OpenCode plug into the same agent selector. [V]
- **Legacy Cascade features.** [V] https://docs.devin.ai/desktop/cascade.md; [V] JetBrains changelog https://docs.devin.ai/windsurf/plugins/changelog
  - **Planning:** Todo lists, a Planning Mode that writes an editable `plan.md` (July 2025), and later automatic planning.
  - **Queued messages.**
  - **@-mention earlier conversations.** The agent retrieves summaries and checkpoints from them.
  - **Multiple Cascade panes.**

### Edits, review and checkpoints
- **Revert.** You can revert to any earlier step in the conversation. The revert cannot be undone. [V, Cascade docs]
- **Named checkpoints.** [V, Cascade docs]
- **Cascade bar.** Navigates diffs with accept/reject-all, plus per-edit accept/reject with an edit counter. [V, JetBrains changelog]
- **Worktree merge.** A **Merge** button in the changes toolbar brings a worktree session's changes back into the workspace. [V] https://docs.devin.ai/desktop/devin-local/worktrees.md
- **Code review.** A GitHub app for PR review (Windsurf Reviews, later Devin Review). [V/K]

### Context
- **Fast Context.** A SWE-grep subagent running up to 8 parallel tool calls per turn over 4 turns. It brings retrieval under 1 second. [S] https://cognition.ai/blog/swe-grep
- **Codemaps (2025-11-04).** AI-annotated, hierarchical maps of the code for a given question, with list and visual (graph) views. They include a "trace guide" explaining why lines are grouped together, and can be passed to the agent with `@codemap`. [V] https://cognition.com/blog/codemaps
  - **This is highly relevant to Code-XR's visualisation angle.**
- **Rules.**
  - `.devin/rules/` is preferred; `.windsurf/rules/` and `.windsurfrules` are still read. `AGENTS.md` is supported. [V, FAQ]
  - Activation modes: always on, manual, model decision and glob. [K]
- **Memories.** Generated automatically by the agent and kept across conversations. They do not cost credits. Global and workspace scopes. [V, JetBrains changelog 2025-05]
- **Workflows.** Markdown procedures invoked as `/name` slash commands, stored in `.devin/workflows/`, up to 12k characters each. A workflow can call other workflows. [V, Cascade docs]
- **Ignore file.** `.devinignore` (formerly `.codeiumignore`). [V]

### Tool execution
- **Permission model.** Devin Local uses allow/ask/deny permission rules and approval requests, with per-MCP-tool permissions. [V, Devin Local overview]
- **OS-level sandbox.** Writable paths follow the permission scopes, `Read(...)` deny rules hide paths, and domain allow/deny lists filter network access. Enterprise can enforce it.
- **Legacy terminal settings.** Turbo mode auto-runs commands except those on a deny list, with allow/deny lists. These remain as fallbacks. [V]
- **Tool-call limit.** Cascade stopped after 40 tool calls per prompt unless Auto-Continue was on. [V]
- **Browser and deploys.** Previews (an in-IDE browser where you can select an element and send it to the agent) and App Deploys (to Netlify). [K]
  - **Devin Cloud** also has desktop, browser and computer use on its own VM. [V, testingcatalog]
- **Hooks.**
  - Cascade Hooks, configured in `.windsurf/hooks.json`. [S]
  - `post_setup_worktree` runs after a worktree is created, for example to copy `.env` files or install dependencies. [V, Cascade docs]
  - Devin Local lists hooks among its customizations. [V]

### Background agents and worktrees
- **Worktrees.** [V] https://docs.devin.ai/desktop/devin-local/worktrees.md
  - Chosen per session at start, from the "agent location" selector: a new or an existing worktree. A conversation cannot move once it has started.
  - Stored in `~/.windsurf/worktrees/<repo>/<random>`.
  - Hidden from the SCM panel by default.
  - Cascade kept at most 20 worktrees per workspace. [V, Cascade docs]
- **Cloud handoff.** Plan locally, then hand off to Devin Cloud with one click. The cloud agent keeps going after the laptop closes. [V]

### MCP and extensions
- **MCP.** Supported, with OAuth, MCP prompts, per-server toggles in the header, and @-mentions of MCP servers. [V, JetBrains changelog]
- **Extensions.** Carried over to `~/.devin/extensions`. The marketplace is believed to be Open VSX. [K; the FAQ does not confirm it]

### Distinctive features and complaints
- **Worth imitating:**
  - The Kanban agent board as home screen.
  - Spaces.
  - Codemaps.
  - Auto-generated memories.
  - Workflows as slash commands.
  - ACP to host third-party agents.
  - Notifications when an agent finishes or needs input.
  - Duplicating a session.
- **Complaints:**
  - Brand churn (Codeium → Windsurf → Devin Desktop).
  - Cascade was deprecated on a short timeline, with migration work.
  - The editor is now "one step deeper" behind the board.
  - The JetBrains plugin is in maintenance mode.
  - Doubts about token-efficiency claims. [S]

---

## 3. Trae (ByteDance)

*The fetch budget ran out before Trae's official pages could be read. Most of this section is [K]/[S].*

### Positioning and pricing
- **Product.** A VS Code fork, launched January 2025. There is an international version (trae.ai) and a China version (trae.cn). [K]
- **Pricing.** Started out free with frontier models. A Pro plan (around $10/mo, with "fast request" quotas and slow queues after that) arrived in about May 2025. [K]
- **Models.**
  - **International:** GPT, Gemini and others. [K]
  - **Claude:** availability shrank after Anthropic restricted Chinese-controlled companies in September 2025. [K, uncertain]
  - **China version:** Doubao, DeepSeek, Kimi and GLM. [K]
- **Third-party reviews from 2026** still describe it as free or low-cost. [S] https://aipedia.wiki/tools/trae/, https://codepick.dev/en/compare/trae-vs-cursor/

### Layout and UX
- **Chat and Builder.** The original side panel had **Chat** and **Builder** (agent) modes. [K]
- **Custom agents (`@Agent`).** You define an agent from a prompt plus a selected set of tools (built-in tools and MCP servers), then invoke it with `@`. [S] https://www.trae.ai/blog/product_thought_0428
- **SOLO mode** ("context engineer"). Launched with Trae 2.0 in July 2025; generally available in about November 2025. [S] https://www.trae.ai/blog/product_solo; Product Hunt "Trae 2.0 - SOLO"
  - **Layout:** a full-screen agent view with a task list on the left and the conversation in the centre.
  - **Tool panel** on the right, with switchable tabs: Editor, Terminal, Browser, Docs and Figma.
  - **SOLO Builder** produces web apps from a PRD and can deploy them (to Vercel).
  - **SOLO Coder** handles complex work in existing repositories. It has a **plan** step, runs several tasks in parallel, and shows a **DiffView**. [K]
- **Trae Agent.** An open-sourced CLI agent harness that scores well on SWE-bench. [K]
- **Cue.** The tab-completion and next-edit engine. [K]

### Edits, review and checkpoints
- **Review.** Per-file and per-hunk accept/reject. [K]
- **Checkpoints.** A "restore to this point" control on chat turns. The implementation is not documented. [K]

### Context
- **`#` context.** `#Code`, `#File`, `#Folder`, `#Workspace`, `#Doc` and `#Web`. `#Doc` indexes custom documentation sets from a URL or uploaded files. [S] https://www.trae.ai/blog/product_thought_0609 ("Mastering Context in Trae")
- **Rules.**
  - User rules in `user_rules.md`.
  - Project rules in `.trae/rules/project_rules.md`, later several files under `.trae/rules/`. [S] e.g. https://agentconfig-ing.pages.dev/files/trae-rules
  - Possibly `AGENTS.md` support in 2026. [uncertain]
- **Codebase index.** A local workspace index. [K]

### Tool execution
- **Terminal.** The agent runs terminal commands after confirmation, or automatically with an auto-run setting and an allowlist/blocklist. [K]
- **Browser.** A built-in browser preview. SOLO has a Browser tab. [S/K]

### Background agents
- **No well-known cloud-agent product** comparable to Cursor's or Devin's. Parallelism is local, through SOLO tasks. [K, uncertain for late 2026]

### MCP and extensions
- **MCP.** A marketplace with one-click add, tied to custom agents. [S/K]
- **Extensions.** Open VSX. Settings can be imported from VS Code and Cursor. [K]

### Distinctive features and complaints
- **Worth imitating:**
  - The SOLO three-pane layout (tasks | chat | tabbed tools).
  - Custom agents defined as a prompt plus a tool set.
  - `#Doc` indexing of external documentation.
  - Very low price.
- **Complaints:**
  - **Telemetry.** A July 2025 analysis found it sending data to ByteDance even with telemetry turned off. [S] https://www.theregister.com/2025/07/28/bytedance_trae_telemetry/, https://www.techradar.com/pro/security/bytedance-ai-tool-caught-spying-on-users
  - **Resource use:** reported as heavy on memory and CPU. [S] https://neowin.net/news/report-bytedances-vs-code-fork-trae-is-a-resource-hog-that-spies-on-you
  - **Queues** on the free tier.
  - **Model availability** varies by region.

---

## 4. Void (open source, Y Combinator)

### Status and positioning
- **Product.** An open-source VS Code fork, Apache-2.0 [K], billed as "the open-source Cursor alternative". Beta in mid-2025. [S] https://www.infoq.com/news/2025/06/void-ide-beta-release/, https://www.ycombinator.com/companies/void
- **Development is paused.** [V] https://codersera.com/blog/void-ide-complete-guide-2026/
  - The repository is still public and the last build still runs.
  - No new features ship, and issues and PRs are not reviewed.
  - The README warns that features may stop working over time.
- **Pricing.** Free, bring your own key: cloud providers, or local models through Ollama, vLLM or any OpenAI-compatible endpoint. Ollama models are detected automatically, and it can run fully offline. **There is no backend in the request path.** [V]

### Layout and UX
- **Chat sidebar.** Built in React. [V]
- **Three modes:** [V]
  - **Normal chat.**
  - **Agent:** can search, create, edit and delete files, run the terminal, and call MCP tools.
  - **Gather:** read-only exploration of the codebase.
- **Quick Edit.** Select code, describe a change, and get an inline diff. Mapped to Ctrl+K [K]. Chat opens with Ctrl+L [K].
- **Autocomplete.** Tab to accept. [V]

### Edits, review and checkpoints
- **Inline diffs.** Accept/reject per diff block. [K]
- **Fast Apply and Slow Apply.** Fast Apply has the model emit search/replace blocks; Slow Apply rewrites the whole file. [K]
- **Checkpoints.** Snapshots of changes made by the model, which can be rolled back. [V] Implemented as in-app snapshots of file contents, not git. [K, uncertain]
- **Lint feedback.** The agent sees lint errors after editing. [K]

### Context and tools
- **Context.** @file/folder mentions and `.voidrules`. No cloud index. [K]
- **MCP.** Supported. MCP channels run in the main process. [V]
- **Terminal.** Commands run with approval toggles. [K]

### Architecture
Directly relevant to an Electron IDE. [V]
- **Browser process:** the React sidebar, the edit/apply system, autocomplete and settings.
- **Common layer:** shared types, model capabilities and prompt templates.
- **Main Node process:** LLM calls (which avoids CSP and CORS problems and reaches local endpoints), MCP and system services.

### Distinctive features and complaints
- **Worth imitating:**
  - **The process split:** LLM traffic and MCP in the main process, UI in the renderer.
  - Direct-to-provider BYOK with local models.
  - Gather (read-only) mode.
  - Fast-apply search/replace.
- **Weaknesses:**
  - Abandoned.
  - No cloud or background agents.
  - No index.
  - More manual MCP setup.

---

## 5. Kiro (AWS)

*Partly verified through search titles. Most details are [K] or from secondary sources.*

### Positioning and pricing
- **Timeline.**
  - Preview: July 2025. [S] https://venturebeat.com/business/amazon-launches-kiro-its-own-claude-powered-challenger-to-windsurf-and-codex
  - **GA:** November 2025, adding property-based tests ("spec correctness"), the **Kiro CLI**, team controls, multi-root workspaces and **checkpointing** (IDE 0.6). [S] https://kiro.dev/blog/general-availability/, https://kiro.dev/changelog/ide/0-6/
- **Platform.** Built on Code OSS. Models are routed through Amazon Bedrock. Claude Sonnet is the default, plus an "Auto" router. [S] https://lushbinary.com/blog/kiro-ide-developer-guide-specs-hooks-agents-pricing/; [K]
- **Pricing in credits (May 2026).** [S, lushbinary]
  - Free: 50 credits per month.
  - Pro: $20 for 1,000 credits.
  - Pro+: $40 for 2,000 credits.
  - Power: $200 for 10,000 credits.
  - Credits are consumed per agent operation.
  - An August 2025 pricing change drew a backlash. [K]

### Layout and UX
- **Session type.** Each new session is either **Vibe** (chat-first) or **Spec**. [K]
- **Kiro panel.** A sidebar with Specs, Agent Hooks, Steering and MCP servers. [K]
- **Autonomy.** An **Autopilot** mode (applies edits) and a **Supervised** mode (asks per change). [K]
- **Sub-agents.** Built-in: general-task-execution, context-gatherer and custom-agent-creator. Custom ones can have restricted tools. [S, lushbinary]

### Spec-driven development
This is Kiro's signature feature. [S] https://builder.aws.com/content/3DbBI7LQgNIcs6UUj7IPPvqFHOp/aws-kiro-the-agentic-ide-that-makes-specs-the-unit-of-work
- **Location:** `.kiro/specs/<feature>/`.
- **Three files:**
  - `requirements.md`: user stories with acceptance criteria in **EARS** notation ("WHEN … THE SYSTEM SHALL …").
  - `design.md`: architecture, data models, sequence diagrams and error handling.
  - `tasks.md`: a checklist of implementation tasks linked to requirements. Each task has a **"Start task"** code-lens, and its status updates live.
- **Phase gates.** The user approves each phase before the next begins. The spec is described as the source of truth.
- **Property-based testing (GA).** Requirements are turned into properties and tested with generated inputs. [S] https://www.ciol.com/generative-ai/kiro-reaches-ga-with-property-based-tests-cli-and-team-controls-10799180

### Edits, review and checkpoints
- **Checkpointing (0.6).** Rewind to an earlier point in the session. [S, changelog title] Implementation unknown.
- **Diffs.** Shown inline with accept/reject, and Supervised mode asks per file. [K]

### Context
- **Steering files** in `.kiro/steering/`. [S, lushbinary]
  - Defaults are `product.md`, `tech.md` and `structure.md`, generated by the agent.
  - Inclusion modes: always, `fileMatch` (glob) or manual (`#steering-name`).
  - `AGENTS.md` is also supported. [K, uncertain]
- **`#` context providers:** `#codebase`, `#file`, `#folder`, `#git diff`, `#terminal`, `#problems`, `#url`, `#docs`, `#spec` and `#steering`. [K]

### Tool execution and hooks
- **Agent Hooks.** An event is tied to an action. [S, lushbinary]
  - **Events:** file save, create and delete; manual trigger; and later prompt-submit and agent-stop.
  - **Actions:** either a natural-language prompt to the agent, or a shell command.
  - Defined in `.kiro/hooks/*.kiro.hook` [K]. A secondary source says JSON.
  - Typical uses: update tests when a file is saved, sync documentation, scan for secrets.
- **Terminal.** Commands need approval unless they are trusted by prefix or wildcard. [K]
- **MCP.** Configured in `.kiro/settings/mcp.json`, at user or workspace level. [S]
- **Powers (December 2025).** Installable bundles of MCP servers, steering and hooks for one technology (Stripe, Supabase, Figma and so on). They are **loaded dynamically** when keywords in the conversation match, to save context. [K]

### Background agents
- **Kiro autonomous agent (re:Invent, December 2025).** A "frontier agent" that runs asynchronously in the cloud for hours or days, works across several repositories, opens PRs, and learns from review feedback. It was later opened to individual developers. [S] https://kiro.dev/blog/introducing-kiro-autonomous-agent/, https://www.constellationr.com/insights/news/aws-kiro-launches-autonomous-agents-individual-developers
- **Kiro CLI.** The same agent in the terminal. It evolved from the Amazon Q Developer CLI. [S/K]

### Extensions
- **Open VSX** extensions. VS Code settings can be imported. [K]

### Distinctive features and complaints
- **Worth imitating:**
  - **Specs** (requirements, design, tasks) with per-task "Start" buttons and live status.
  - EARS acceptance criteria.
  - Steering inclusion modes.
  - Event hooks that fire a prompt or a shell command.
  - Powers that load on demand.
  - Property-based tests derived from specs.
- **Complaints:**
  - Slow and token-heavy.
  - Specs are overkill for small changes.
  - Credit pricing changed and was confusing.
  - An early waitlist and capacity limits.
  - Lock-in to the AWS ecosystem. [K/S]

---

## Cross-cutting patterns (late 2026)

1. **The agent manager is becoming the home screen.**
   - Cursor 3 has its Agents Window, Devin Desktop its Kanban ACC and Spaces, Trae its SOLO three-pane layout.
   - The classic editor survives, one click away. This is a frequent complaint, so **ship both, with the IDE as the default and the agent manager as a dockable or full-screen view.**
2. **One session model across local, worktree, cloud and SSH.** A session has a *location*, picked at creation (Devin's "agent location" selector; Cursor's tab runs in a worktree, cloud or SSH). Handoff between them is a first-class action.
3. **Git worktrees are the standard isolation for parallel local agents.**
   - Store them outside the repo: `~/.windsurf/worktrees/<repo>/<rand>`.
   - Provide a setup hook (`post_setup_worktree`) for `.env` files and installs.
   - Hide them from SCM by default.
   - Provide an explicit **Merge** or "move to foreground" action.
   - Cap how many are kept: Cascade kept 20.
4. **Checkpoints are file snapshots separate from git.** They are tied to chat turns. Restoring reverts files but keeps the transcript (Cursor), and named checkpoints exist too (Windsurf). Cursor explicitly tells users to rely on git for anything permanent.
5. **Modes have converged on Ask, Agent and Plan.** Additions include Debug (Cursor), Gather/read-only (Void), Bypass Permissions (Devin), and Vibe vs Spec (Kiro). Plan produces an **editable Markdown artifact with to-dos** that can be run by a different model, or in the background.
6. **The composer has the same standard controls everywhere:**
   - model picker plus Auto router
   - @-file and folder pills
   - images
   - slash commands, workflows and skills
   - a message **queue** with reordering and **steer now**
   - voice
   - side chats
   - a search over chat history
7. **Instruction files are converging on `AGENTS.md`.** Every product also has its own rules folder (`.cursor/rules/*.mdc`, `.devin/rules/`, `.kiro/steering/`, `.trae/rules/`). They share four activation types: always, glob, model-decides (from a description) and manual (@-mention).
8. **Hooks are JSON config that spawns processes,** exchanging JSON on stdin and stdout with allow/deny/ask decisions. Events cover the session lifecycle, before and after tool use, shell, MCP, file reads and edits, prompt submit and stop. Kiro's variant can fire a natural-language prompt as well as a shell command.
9. **Approvals have three tiers:** an allowlist, an OS sandbox (workspace writable, network denied unless allowlisted), and a classifier or model judgement for everything else, with explicit cards for out-of-workspace reads and deletions.
10. **MCP is universal.** Products add packaging on top: plugins and marketplaces (Cursor), Powers loaded on demand (Kiro), custom agents as a prompt plus tools (Trae), and per-tool permissions (Devin). ACP is the emerging way to host *other vendors'* agents (Devin Desktop).
11. **Every fork uses the Open VSX extension marketplace.** Microsoft-only extensions (Pylance, C/C++, Remote) are the known gap.
12. **Review has moved from per-file to a single multi-file diff view** with per-hunk keep/undo, a review bar with counters, then stage, commit and open PR. Agents attach **proof**: screenshots, demos and canvases.
13. **Code understanding as a visual artifact.** Windsurf Codemaps (maps of code for a question, plus trace guides, passed to the agent with `@codemap`) is the closest precedent to Code-XR's visualisation strength.

---

## Features to imitate in Code-XR IDE (ranked)

1. **A session-based agent chat panel in the classic VS Code layout.**
   - A right-hand secondary sidebar with tabs for several concurrent chats.
   - History per project, with search.
   - Modes: Ask, Agent and Plan.
   - Composer: model picker (BYOK plus local Ollama, as in Void), @file/@folder pills, images, slash commands, a queue with steering.
2. **Turn-linked checkpoints.** Snapshot the files an agent touches before each edit (in a store under the app data folder, not in git), show "Restore to here" on each user message, and keep the transcript when restoring.
3. **Inline diff review in Monaco plus a multi-file "Changes" view.**
   - Keep or undo per hunk and per file.
   - A review bar with a counter and next/previous.
   - Accept-all and reject-all.
4. **An approval model for tools.**
   - Per-session mode: Ask every time, Allowlist, or Auto.
   - A command allowlist and denylist.
   - Explicit approval cards for out-of-workspace reads, deletions and network.
   - Optional sandbox later.
5. **Rules and `AGENTS.md`.** Read root and nested `AGENTS.md` files, plus `.codexr/rules/*.md` with frontmatter (`alwaysApply`, `globs`, `description`). Add a customization panel showing what is loaded.
6. **Plan mode that produces an editable Markdown plan with checkboxes** and a "Build" button. Optionally, Kiro-style specs (requirements, design, tasks) with "Start task" code-lens.
7. **Parallel agents on git worktrees,** with an Agents view (a list or Kanban by status: running, needs input, ready for review), a Merge button, a setup hook and OS notifications when an agent finishes or needs input.
8. **MCP client** (stdio plus HTTP) in the Electron main process, as in Void, with per-server toggles and per-tool permissions.
9. **Hooks.** A `hooks.json` file (project and user) for the events preToolUse, beforeShellExecution, afterFileEdit, beforeSubmitPrompt and stop, exchanging JSON on stdin and stdout and returning allow, deny or ask.
10. **Workflows and skills as slash commands** from `.codexr/workflows/*.md`.
11. **Codemap-style visual context.** A distinctive edge for Code-XR: let the agent attach Code-XR metric and dependency visualisations as context (`@codemap`/`@metrics`), and render the agent's touched-files graph.
12. **Codebase semantic index** (local embeddings with Merkle-style incremental updates) plus a fast grep subagent. Lower priority, because agentic grep is already competitive (Cursor even removed many manual @-context types).
13. **Hosting other vendors' agents over ACP** (Claude Code, Codex, Gemini CLI) as alternative backends in the same chat UI.
14. **Open VSX extension support** (already a goal), with a clear notice about Microsoft-only extensions.
15. **Proof artifacts.** Embedded browser preview with element-pick-to-chat, and screenshots attached to agent results.

---

## Gaps and items to re-verify

The fetch budget was exhausted, so these were not checked against primary sources:
- **Trae:** the official docs and changelog (docs.trae.ai): current pricing and models, SOLO Coder details, checkpoints, terminal approval.
- **Kiro:** docs (kiro.dev/docs): exact hook file format, Powers, how checkpointing works, current models, the autonomous-agent pricing.
- **Void:** the GitHub README (exact licence; whether a fork or successor exists).
- **Cursor:** current status of Memories and the exact names of the built-in modes (Debug).
- **Devin Local:** the full hooks and rules activation documentation (docs.devin.ai/desktop/devin-local/customizations.md).
