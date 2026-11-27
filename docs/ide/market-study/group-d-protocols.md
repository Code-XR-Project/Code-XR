# Group D — Protocols, auth, checkpoints, diff review, rules files, MCP, worktrees

Research date: 2026-11-27. Target: agent-first IDE (Electron 45 + Monaco, TypeScript, Node main process) that lets users plug in the AI subscriptions they already pay for (Claude, ChatGPT, Gemini) plus API keys.

**Confidence labels used below**

- **[verified]**: read directly from the published npm tarball, its JSON schema or source, or from an official doc page during this session.
- **[source: secondary]**: from news or blog coverage. The primary source was not re-read.
- **[from prior knowledge]**: not re-checked this session, because the WebFetch budget ran out part-way through. Treat these as likely but re-verify.

---

## 0. TL;DR

| Need | Answer |
|---|---|
| Protocol to drive external coding agents | **ACP (Agent Client Protocol)**, JSON-RPC 2.0 over stdio (newline-delimited JSON), agent runs as a child process of the IDE. Use protocol **v1** (`protocolVersion: 1`); v2 is "Preview, not frozen". |
| TS SDK | **`@agentclientprotocol/sdk@2.12.0`** (Apache-2.0). The old `@zed-industries/agent-client-protocol` is the legacy name. SDK 2.x removed `ClientSideConnection`; use the new `client()` app API. |
| Claude (Pro/Max or API key) | `npx -y @agentclientprotocol/claude-agent-acp` (v0.113.0, Apache-2.0, Node ≥22, bin `claude-agent-acp`). It wraps `@anthropic-ai/claude-agent-sdk`. The old `@zed-industries/claude-code-acp` is **deprecated**. |
| ChatGPT (Plus/Pro) or OpenAI key | `npx -y @agentclientprotocol/codex-acp` (v2.12.1, Apache-2.0, bin `codex-acp`; bundles `@openai/codex`). The old `@zed-industries/codex-acp` is **deprecated**. |
| Gemini | `gemini --acp` (`@google/gemini-cli@0.71.1`; `--experimental-acp` is deprecated). **Since 2026-06-18 Gemini CLI no longer serves Google AI Pro/Ultra consumer subscriptions.** Subscription users go through Antigravity: `agy acp` (proprietary). |
| Agent catalogue | The **ACP Registry** at `https://cdn.agentclientprotocol.com/registry/v1/<version>/registry.json`, which lists about 40 agents with npx, uvx or binary launch specs. |
| Tools for agents | MCP. Latest spec **2026-07-28**. TS SDK v2 is split into `@modelcontextprotocol/server` / `client` / `core` @2.4.0 (Apache-2.0). Legacy `@modelcontextprotocol/sdk@1.32.2` (MIT) speaks up to `2025-11-25`. Pass the IDE's own MCP server to agents in `session/new.mcpServers`. |
| Subscription terms | Allowed: launching the **unmodified official agent binary** (Claude Code via the Agent SDK, Codex, Gemini CLI or agy), which runs its **own** login flow. Forbidden: the IDE itself offering "Sign in with Claude", or collecting or proxying OAuth tokens. See §3. |

---

## 1. Agent Client Protocol (ACP)

Spec site: https://agentclientprotocol.com (v1 docs under `/protocol/v1/…`, v2 under `/protocol/v2/…`). GitHub org: `agentclientprotocol` (moved there from `zed-industries`). Schemas ship inside the SDK at `schema/v1/schema.json`, `schema/v1/schema.unstable.json` and `schema/v2/schema.json` [verified].

### 1.1 Transport

- JSON-RPC 2.0. The client (the IDE) spawns the agent as a subprocess and talks **newline-delimited JSON over stdin/stdout**. stderr is for logs.
- All paths in payloads are **absolute**. Line numbers are 1-based.
- `_meta` is allowed on every type for extensions. Custom methods and categories start with `_`.
- The SDK also exports experimental WebSocket, HTTP and server transports (`/experimental/ws-client`, `/experimental/http-client`, `/experimental/server`) [verified exports]. Stdio is the one every agent supports.

### 1.2 Version status [verified]

- **v1** (`protocolVersion: 1`) is the stable baseline and the SDK default import.
- **v2** (`protocolVersion: 2`) is in "Preview … not frozen". Its main changes:
  - `authenticate` becomes `auth/login` and `logout` becomes `auth/logout`.
  - `session/load` is removed in favour of `session/resume` with a `replayFrom` cursor.
  - `session/set_mode` is removed; modes become config options.
  - The client `fs/*` and `terminal/*` methods are **removed**.
  - `tool_call` is merged into an upsert `tool_call_update`, and `plan` becomes `plan_update` with a `planId`.
  - The `session/prompt` response becomes an ack carrying a `messageId`; turn completion arrives via `state_update`.
  - Diffs become structured `changes` plus an optional `git_patch`.
  - Peers should support v1 and v2 side by side.
- The Claude adapter serves both and can be pinned with `CLAUDE_AGENT_ACP_PROTOCOL=v1|v2|auto` [verified README].
- **Recommendation:** build on v1 now and keep the v2 entry point in mind.

### 1.3 Full method list (v1 stable schema, SDK 2.12.0) [verified]

**Agent-side** (the IDE calls these):

| Method | Notes |
|---|---|
| `initialize` | Negotiates `protocolVersion` and capabilities, and returns `authMethods`. |
| `authenticate` | `{ methodId }`. Used for `agent`-type auth methods. |
| `logout` | Needs `agentCapabilities.auth.logout`. |
| `session/new` | `{ cwd, mcpServers, additionalDirectories?, systemPrompt?, _meta? }` → `{ sessionId, modes?, configOptions? }`. |
| `session/load` | Needs `agentCapabilities.loadSession`. Replays history as `session/update`s. |
| `session/list`, `session/delete`, `session/resume`, `session/close` | Each needs its `sessionCapabilities.*`. |
| `session/set_mode` | `{ sessionId, modeId }` (legacy; config options are preferred). |
| `session/set_config_option` | `{ sessionId, configId, value }`. **This is how the model picker works** (category `model`). |
| `session/prompt` | `{ sessionId, prompt: ContentBlock[] }` → `{ stopReason }`. |
| `session/cancel` | **Notification.** |

**There is no `session/set_model` in stable v1.** It existed as an unstable method in 2025 SDKs. Today the model, mode and thought level are all `SessionConfigOption`s with `category` set to `mode`, `model`, `model_config` (sic, truncated in schema) or `thought_level` [verified category enum begins `mode`, `model`, `mo…`; the exact remaining names are uncertain].

**Client-side** (the agent calls the IDE):

| Method | Capability gate |
|---|---|
| `session/request_permission` | baseline |
| `session/update` (notification) | baseline |
| `fs/read_text_file` `{sessionId, path, line?, limit?}` | `clientCapabilities.fs.readTextFile` |
| `fs/write_text_file` `{sessionId, path, content}` | `clientCapabilities.fs.writeTextFile` |
| `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` | `clientCapabilities.terminal` |
| `elicitation/create` (request), `elicitation/complete` (notification) | elicitation capability |
| `$/cancel_request` | protocol-level |

**Unstable v1 additions** (from `/unstable` entry point) [verified]:
- Auth: `auth/status`, `auth/status_update`.
- Providers: `providers/list`, `providers/set`, `providers/disable`.
- Sessions: `session/fork`, `session/archive`, `session/unarchive`, `session/set_title`, `session/status`, `session/options`.
- MCP-over-ACP: `mcp/message`, both directions.
- Proxy chains: `proxy/initialize`, `proxy/successor`.

### 1.4 `session/update` kinds (`update.sessionUpdate` discriminator) [verified, v1 stable]

`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `plan_update`, `plan_removed`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`, `notice`, `compaction_update`, `compaction_summary_chunk`, `subagent_update`, `session_message`, `session_message_chunk`.

Unstable adds `prompt_suggestions_update` and `cursor_update`.

Supporting enums:

- **ToolKind:** `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`.
- **ToolCallStatus:** `pending`, `in_progress`, `completed`, `failed`.
- **ToolCallContent:**
  - `{type:"content", content: ContentBlock}`
  - `{type:"diff", path, oldText|null, newText}`
  - `{type:"terminal", terminalId}`
  - `{type:"session", …}` (subagent reference; needs the `subagents` client capability)
- **ToolCall** fields: `toolCallId`, `title` (required), `name?`, `kind`, `status`, `content[]`, `locations[]` (`{path, line?}`), `rawInput`, `rawOutput`.
- **PlanEntry:** `{content, priority: high|medium|low, status: pending|in_progress|completed}`.
- **StopReason:** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- **PermissionOptionKind:** `allow_once`, `allow_always`, `reject_once`, `reject_always`.
- **Permission outcome:** `{outcome:"selected", optionId}` or `{outcome:"cancelled"}`. After `session/cancel` the client **MUST** answer every pending permission with `cancelled`.
- **ContentBlock types:** `text`, `image`, `audio`, `resource_link`, `resource` (embedded). Gated by `promptCapabilities.{image,audio,embeddedContext}`.

### 1.5 Capability negotiation — JSON examples

`initialize` request:

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{
  "protocolVersion":1,
  "clientInfo":{"name":"code-xr-ide","title":"Code-XR IDE","version":"0.1.0"},
  "clientCapabilities":{
    "fs":{"readTextFile":true,"writeTextFile":true},
    "terminal":true,
    "auth":{"terminal":true}
  }}}
```

`initialize` response (shape):

```json
{"jsonrpc":"2.0","id":0,"result":{
  "protocolVersion":1,
  "agentInfo":{"name":"claude-agent-acp","version":"0.113.0"},
  "agentCapabilities":{
    "loadSession":true,
    "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
    "mcpCapabilities":{"http":true,"sse":true},
    "sessionCapabilities":{"list":{},"resume":{},"close":{}},
    "auth":{"logout":{}}
  },
  "authMethods":[
    {"id":"claude-ai-login","name":"Claude Subscription","type":"terminal","args":["--cli","auth","login","--claudeai"]},
    {"id":"console-login","name":"Anthropic Console","type":"terminal","args":["--cli","auth","login","--console"]}
  ]}}
```

`AuthMethod` is a union discriminated by `type` [verified]:

- `agent` is the default when `type` is absent. The IDE calls `authenticate({methodId})` and the agent does the work, for example opening a browser.
- `terminal`: **the IDE runs the agent's own command plus `args` in an interactive terminal**. It is offered only if the client advertised `clientCapabilities.auth.terminal: true`. Some agents also put a `_meta["terminal-auth"] = {command,args,label}` hint on the method.
- **Implement both.** Your xterm.js/node-pty integrated terminal satisfies `terminal` auth.

`session/new` request with the IDE's MCP server:

```json
{"jsonrpc":"2.0","id":1,"method":"session/new","params":{
  "cwd":"/home/u/project",
  "mcpServers":[
    {"name":"codexr-ide","command":"/abs/path/to/node","args":["/abs/ide-mcp.js","--port-file","/tmp/x"],"env":[{"name":"IDE_TOKEN","value":"…"}]},
    {"type":"http","name":"docs","url":"http://127.0.0.1:7777/mcp","headers":[{"name":"Authorization","value":"Bearer …"}]}
  ]}}
```

- Stdio MCP is mandatory for agents. `type:"http"` and `type:"sse"` are only allowed if `mcpCapabilities.http` / `.sse` are true.
- `command` must be an **absolute path**; v2 rejects relative ones.
- MCP-over-ACP (`type:"acp"`, unstable) lets the IDE serve MCP **over the same ACP connection** with no extra process. Both the Claude and Codex adapters support it [verified README].

Prompt plus streamed updates:

```json
{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"s1","prompt":[
  {"type":"text","text":"Fix the failing test"},
  {"type":"resource_link","uri":"file:///home/u/project/src/a.ts","name":"a.ts"}]}}

{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Looking…"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Edit src/a.ts","kind":"edit","status":"pending","locations":[{"path":"/home/u/project/src/a.ts"}]}}}
{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1"},"options":[
  {"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"always","name":"Always allow","kind":"allow_always"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}
{"jsonrpc":"2.0","id":9,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","content":[{"type":"diff","path":"/home/u/project/src/a.ts","oldText":"…","newText":"…"}]}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"plan","entries":[{"content":"Run tests","priority":"high","status":"in_progress"}]}}}
{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}
```

### 1.6 TypeScript SDK [verified]

- Package: **`@agentclientprotocol/sdk`**, latest **2.12.0** (2026-11-24), **Apache-2.0**. Legacy name: `@zed-industries/agent-client-protocol` (0.4.x era).
- Entry points:
  - `@agentclientprotocol/sdk`: stable v1.
  - `/unstable`: v1 plus unstable features.
  - `/experimental/v2` and `/experimental/v2/unstable`.
  - `/schema/v1/schema.json`.
- **Breaking change in 2.x:** `ClientSideConnection` / `AgentSideConnection` and the `Client` interface were **removed**. Use the app API:

```ts
// main process (Node). Agent spawned with child_process.spawn.
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';

const proc = spawn(npxPath, ['-y', '@agentclientprotocol/claude-agent-acp'], { cwd, env, stdio: ['pipe','pipe','pipe'] });
const stream = ndJsonStream(Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
                            Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>);

const app = client({ name: 'code-xr-ide' })
  .onNotification(methods.client.session.update, ({ params }) => renderer.send('acp:update', params))
  .onRequest(methods.client.session.requestPermission, ({ params, signal }) => askUser(params, signal))
  .onRequest(methods.client.fs.readTextFile, ({ params }) => readFromBufferOrDisk(params))   // unsaved Monaco buffers!
  .onRequest(methods.client.fs.writeTextFile, ({ params }) => stageWriteForReview(params));

await app.connectWith(stream, async (ctx) => {
  const init = await ctx.request(methods.agent.initialize, { protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: true } } });
  const session = await ctx.buildSession({ cwd, mcpServers: [ideMcp] }).start();
  await session.prompt('Fix the failing test');   // updates arrive via onNotification or session.nextUpdate()
});
```

- Handlers receive `{ method, params, signal, requestId, agent }`.
- Notifications are dispatched in order but async handlers can overlap, so **serialize per session**.
- (Method-name constants are verified. The exact field name of the returned session, e.g. `session.sessionId`, is verified. The `Writable.toWeb` cast is standard Node ≥17.)

### 1.7 Agents that speak ACP, and launch commands

Source: ACP Registry `registry.json` (snapshot v2026.09.07) plus `npm view` on 2026-11-27 [verified]. The registry pins versions; the latest npm versions are given where checked.

| Agent | Registry id | Launch (stdio) | Licence | Auth methods advertised |
|---|---|---|---|---|
| **Claude Agent** | `claude-acp` | `npx -y @agentclientprotocol/claude-agent-acp` (npm 0.113.0, Node ≥22). Standalone binaries on GitHub releases bundle `claude`; override with `CLAUDE_CODE_EXECUTABLE`. | Apache-2.0 (adapter). Depends on `@anthropic-ai/claude-agent-sdk` 0.3.331, which is proprietary ("SEE LICENSE IN README"). The registry labels it "proprietary". | Terminal-type: `claude-ai-login` → runs `claude-agent-acp --cli auth login --claudeai`; `console-login` → `--cli auth login --console`; on remote, SSH or `NO_BROWSER`: `claude-login` → `--cli` (`claude /login` TUI). `ANTHROPIC_API_KEY` in env also works [from prior knowledge]. |
| **Codex** | `codex-acp` | `npx -y @agentclientprotocol/codex-acp` (npm 2.12.1; bundles `@openai/codex` ^0.172.0; `CODEX_PATH` overrides) | Apache-2.0 | `chat-gpt` (browser OAuth; hidden with `NO_BROWSER=1`), `chat-gpt-device-code`, `api-key` (`CODEX_API_KEY` > `OPENAI_API_KEY`), `gateway` (opt-in). Env `INITIAL_AGENT_MODE` = `read-only`, `workspace-write`, `agent` or `agent-full-access`. |
| **Gemini CLI** | `gemini` | `npx -y @google/gemini-cli --acp` (npm 0.71.1). `--experimental-acp` is "deprecated, use --acp instead". | Apache-2.0 | `oauth-personal` (Log in with Google), `gemini-api-key` (`_meta.api-key.provider=google`), `vertex-ai`, `gateway`. **Consumer AI Pro/Ultra OAuth stopped being served on 2026-06-18.** |
| **Google Antigravity** | `antigravity-acp` | `agy acp` (binary; `agy acp --login`) | proprietary | `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` (ADC), `terminal-login` |
| GitHub Copilot CLI | `github-copilot-cli` | `npx -y @github/copilot --acp` | proprietary | GitHub login |
| Cursor | `cursor` | `cursor-agent acp` (binary) | proprietary | Cursor account |
| OpenCode | `opencode` | `opencode acp` | MIT | provider keys, plus "Sign in with ChatGPT" (official partner) |
| Goose | `goose` | `goose acp` | Apache-2.0 | provider config |
| Qwen Code | `qwen-code` | `npx -y @qwen-code/qwen-code --acp --experimental-skills` | Apache-2.0 | Qwen OAuth or key |
| Kimi CLI | `kimi` | `kimi acp` | MIT | Moonshot |
| Auggie (Augment) | `auggie` | `npx -y @augmentcode/auggie --acp` (env `AUGMENT_DISABLE_AUTO_UPDATE=1`) | proprietary | Augment |
| Cline | `cline` | `npx -y cline --acp` | Apache-2.0 | provider keys |
| Kilo | `kilo` | `kilo acp` / `npx @kilocode/cli acp` | MIT | |
| Mistral Vibe | `mistral-vibe` | `vibe-acp` | Apache-2.0 | |
| Amp | `amp-acp` | `amp-acp` | Apache-2.0 | |
| Others | — | Factory Droid (`droid exec --output-format acp-daemon`), Junie (`--acp=true`), Devin (`devin acp`), Grok Build (`grok agent stdio`), Qoder, Codebuddy, Poolside, Cortex, Stakpak, VT Code, fast-agent (uvx), etc. | | |

**ACP Registry** [verified]:

- Docs: https://agentclientprotocol.com/get-started/registry
- Repo: `github.com/agentclientprotocol/registry`
- Versioned CDN JSON: `https://cdn.agentclientprotocol.com/registry/v1/<vYYYY.MM.DD-hash>/registry.json`
- Each entry has `id`, `name`, `version`, `description`, `license`, `icon`, and `distribution` of one of these forms:
  - `{npx:{package,args,env}}`
  - `{uvx:{package,args}}`
  - `{binary:{"<os>-<arch>":{archive,cmd,args}}}`
- Zed announced it at https://zed.dev/blog/acp-registry.
- **The IDE can ship an "Add agent" gallery straight from this JSON.** Pin one snapshot, verify downloads, and let the user opt in.

---

## 2. Auth in practice (what the IDE does per provider)

1. Spawn the adapter with a **minimal env**: PATH, HOME, plus any key the user typed into the OS keychain via `safeStorage`.
2. Call `initialize` with `auth.terminal: true` and read `authMethods`.
3. Call `session/new`. If it fails with JSON-RPC error `-32000` "Authentication required" [from prior knowledge: error code `auth_required` = -32000], show the auth picker:
   - `type:"terminal"`: open an IDE terminal tab running `<agentCommand> <args>`, wait for exit, then retry `session/new`.
   - `type` absent (agent-handled): call `authenticate({methodId})`. The agent opens the browser itself (Codex `chat-gpt`, Gemini `oauth-personal`).
   - API-key methods: write the key into the agent's env on the **next spawn** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` / `CODEX_API_KEY`, `GEMINI_API_KEY`), then call `authenticate` with that method id.
4. Credentials stay where each vendor's CLI stores them: `~/.claude/` or the macOS keychain, `~/.codex/auth.json`, `~/.gemini/`. **The IDE never reads or stores the OAuth tokens.** This is also what keeps it compliant (§3).

---

## 3. Terms: subscriptions in third-party apps

### Anthropic (Claude Free/Pro/Max)

Source: https://code.claude.com/docs/en/legal-and-compliance, read 2026-11-27 [verified].

Forbidden:

> "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."

Developers building on the Agent SDK "should use API key authentication".

Allowed:

> "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code…"

Conditions for products that run Claude Code:

- The binary is unmodified.
- No authentication method may be removed or restricted.
- No reselling or intermediating of usage.
- No use of the Claude Code or Anthropic name or logo in your product name.

Also: "Anthropic reserves the right to take measures to enforce these restrictions … without prior notice." Usage limits "assume ordinary, individual usage of Claude Code and the Agent SDK".

Background: in Feb 2026 Anthropic blocked third-party harnesses that used subscription OAuth (OpenClaw et al.) [source: secondary; gigazine, winbuzzer].

**What this means for us** (interpretation, not legal advice):

- Do: launch `claude-agent-acp`, which runs the official Claude Code CLI or Agent SDK locally, and let the user run *its* login (`--cli auth login --claudeai`) in a terminal. Tokens live in Claude Code's own store and the IDE never touches them. This is the same pattern Zed and JetBrains use.
- Don't: build our own "Sign in with Claude" button that does OAuth, read `~/.claude/.credentials.json`, or forward tokens to our own model calls.
- Grey area to flag to the user: the Agent SDK sentence ("developers … should use API key authentication") versus the end-user carve-out for the unmodified binary. The adapter is Agent-SDK-based. Zed ships it, but **this remains UNCERTAIN for a distributed product**.
- Safest UX: default to the "Claude Code (your login)" path, show the vendor's own flow, and offer an API key as the alternative. Do not market it as "use your Claude Pro in our IDE".

### OpenAI (ChatGPT Plus/Pro)

- Codex App Server docs (https://learn.chatgpt.com/docs/app-server, redirected from developers.openai.com) [verified]: app-server ChatGPT auth "has never been permitted for commercial or hosted services". **"Sign in with ChatGPT"** was created for those cases, and the docs recommend local or open-source apps migrate to it.
- Sign in with ChatGPT with plan usage [source: secondary; The New Stack, flaviocopes]:
  - Beta in July 2026; plan usage announced at DevDay on 2026-09-29.
  - Plus and Pro users can let partner apps draw on their plan, with per-app weekly caps.
  - **Open-source tools running on the user's machine reportedly need no approval** (they self-register on first sign-in).
  - Commercial or hosted apps need the partner form at https://openai.com/form/sign-in-with-chatgpt-interest/.
  - Developer docs: https://developers.openai.com/siwc
  - UI guidance: a "Using ChatGPT plan" label and a "Manage usage" link near the model picker.
- Practical path for us: launch the official `codex` via `codex-acp` and let the user pick `chat-gpt` login. Zed does this. Codex is Apache-2.0. If the IDE is open source and local, this looks fine.
- **UNCERTAIN:** whether a non-partner commercial IDE may expose the codex-acp ChatGPT login. Treat it like Anthropic: the user logs in through Codex's own flow, and the IDE never stores tokens.

### Google (Gemini)

- Gemini CLI ToS (`docs/resources/tos-privacy.md`) [verified]: "Directly accessing the services powering Gemini CLI" using "third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation… grounds for suspension". Running the **official** Gemini CLI via ACP is how Zed integrates and is not this case.
- Discussion #22970 (2026-03-18) [source: secondary]: Pro models became paid-only and abuse detection expanded for "Gemini CLI oAuth with third-party software". Questions about ACP or Zed were left without a definitive answer.
- **Google blog, 2026-05-19** [verified]:
  - From **2026-06-18**, Gemini CLI and the Code Assist IDE extensions **stop serving Google AI Pro/Ultra subscribers and free Code Assist individuals**.
  - Gemini CLI keeps working with **paid Gemini API keys** and Code Assist Standard/Enterprise.
  - Consumers are moved to **Antigravity CLI (`agy`)**, which speaks ACP via `agy acp`.
- **Practical path:**
  - For a "Gemini subscription", offer Antigravity (`agy acp`, proprietary, user installs it) with its own `oauth-personal` flow.
  - For keys, offer `gemini --acp` with `gemini-api-key`.

---

## 4. Checkpoints in open-source agents

### Gemini CLI (`GitService`) [verified from @google/gemini-cli-core source]

- Shadow repo at `~/.gemini/history/<project-hash>/` with its own `.git`.
- Hardening:
  - Its own `.gitconfig` sets user "Gemini CLI" and `commit.gpgsign=false`.
  - `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` point at private files.
  - Inherited `GIT_DIR` / `GIT_WORK_TREE` are cleared, and the environment is sanitized.
  - It copies the user's `core.excludesFile`, the project `.git/info/exclude` (path-checked against traversal), and `.gitignore` into the shadow repo.
- Operations run with `GIT_DIR=<history>/.git GIT_WORK_TREE=<projectRoot>`:
  - `createFileSnapshot(msg)`: `git add -A` then `commit`.
  - `restoreProjectFromSnapshot(hash)`: `git restore --source <hash> .` then `git clean -f -d` [the last two from prior knowledge].
- Triggered **before any file-modifying tool is approved** (when `general.checkpointing.enabled` / `--checkpointing` is on). It also saves the conversation and the pending tool call to `~/.gemini/tmp/<hash>/checkpoints/*.json`.
- `/restore [name]` lists checkpoints and restores files plus conversation, then re-proposes the tool call.

### Cline [from prior knowledge + docs.cline.bot]

- Shadow git repo in VS Code `globalStorage/…/checkpoints/<cwdHash>/.git`, with `core.worktree` set to the workspace.
- Commits after each tool use (file edit or command).
- Nested `.git` directories are temporarily renamed (`.git_disabled`) during `git add` so submodules and nested repos are captured as files, then restored. This is fragile if the process crashes.
- Excludes are built in: build dirs, media and binaries, `.env`, LFS patterns.
- Checkpoints are refused in home, Desktop, Documents and Downloads.
- UX per checkpoint:
  - "Compare" shows a diff vs. the current state.
  - "Restore Files", "Restore Task Only" and "Restore Files & Task" are the three restore actions.

### Roo Code (fork of the Cline design) [from prior knowledge, DeepWiki]

- `ShadowCheckpointService` stores under `globalStorageUri/checkpoints/<taskId>` (per task) or a workspace hash.
- Also uses the nested-git rename trick.
- `saveCheckpoint()` runs before file-writing tools, `restoreCheckpoint(hash)` uses `git clean -f -d` plus `git reset --hard`, and `getDiff(from,to)`.
- Has a timeout and a "checkpoints disabled" fallback when the initial commit is too slow on huge repos.

### Claude Code rewind [verified, code.claude.com/docs/en/checkpointing]

- **Not git.** It keeps a per-file snapshot store, capturing the state before each user prompt that starts a turn.
- Keeps the 100 most recent checkpoints, persisted with the session; a retention sweep runs at about 30 days (`cleanupPeriodDays`).
- `/rewind` or Esc Esc offers: restore code and conversation, conversation only, code only, summarize from or up to here.
- Limitations:
  - **Bash-made changes are not tracked.**
  - Background subagent edits are not restored.
  - External edits are not tracked.
  - Symlinks and hard links are skipped.
- The Agent SDK exposes "file checkpointing" (`enableFileCheckpointing`, `rewindFiles(userMessageId)`) [from prior knowledge; doc at platform.claude.com/docs/en/agent-sdk/file-checkpointing].

### Pitfalls for our own implementation

| Problem | Mitigation |
|---|---|
| Huge repos and `node_modules` | Respect `.gitignore` plus `info/exclude` plus a default exclude list. Cap file size (skip >5–10 MB). Time out the first snapshot and degrade to "checkpoints off" with a notice. |
| Nested git repos and submodules | Prefer **not** renaming `.git` (crash-unsafe). Either exclude nested repos, or snapshot via `git ls-files -co --exclude-standard` plus `git hash-object -w` / `update-index --index-info` into the shadow index, which never touches the user tree. |
| Never touch the user's real repo | Separate `GIT_DIR` outside the project (userData), `GIT_WORK_TREE=project`, and a private `GIT_INDEX_FILE`. Clear the user's global config, hooks (`core.hooksPath=/dev/null`), gpgsign, fsmonitor, LFS filters (`-c filter.lfs.smudge= -c filter.lfs.process=`) and autocrlf. |
| Windows | Set `core.autocrlf=false`, `core.longpaths=true` and `core.symlinks=false`; watch for path-length and file-locking issues (antivirus, open handles) on restore. Ship or detect git (`dugite` bundles git for Electron, MIT). |
| Bash changes | ACP edit tool calls give exact diffs, but shell commands don't. A **git snapshot per turn** (and before `execute` tool calls) catches them. A per-file store (Claude style) doesn't. |
| Concurrency | One mutex per project. Gemini uses `withPathLock`. |

**Recommended design:** shadow git in `app.getPath('userData')/checkpoints/<projectHash>.git`, using `git --git-dir=… --work-tree=<root>`.

- Snapshot at the start of each user turn and before each `tool_call` whose `kind` is `edit`, `delete`, `move` or `execute`.
- Store a mapping of `{sessionId, promptIndex, toolCallId} → commit`.
- Restore through `git read-tree` / `checkout-index` limited to the changed paths. Show a diff preview first.

---

## 5. Diff review UX in Monaco-based editors

- **Monaco primitives:**
  - `monaco.editor.createDiffEditor(el, {renderSideBySide, originalEditable:false, renderMarginRevertIcon:true, ignoreTrimWhitespace:false, experimental:{showMoves:true}, hideUnchangedRegions:{enabled:true}})`
  - `diffEditor.getLineChanges()` and `onDidUpdateDiff` give the hunks.
  - Inline mode is `renderSideBySide:false`. `useInlineViewWhenSpaceIsLimited` is automatic.
- **Inline accept/reject in a normal editor**, the Cursor / VS Code Chat style:
  - Keep the agent's proposed content as the model value, and keep the original in a hidden `ITextModel`.
  - Compute hunks with Monaco's diff worker, or with `diff` (jsdiff, BSD-3, the same library both ACP adapters depend on).
  - Render deletions as **view zones** (`changeViewZones`) holding read-only red lines, and insertions with `deltaDecorations` whole-line green background plus a glyph margin.
  - Put "Keep / Undo" **content widgets** (or `editor.addAction` plus CodeLens) per hunk.
  - Undo = `pushEditOperations` that reverts just that range back to the original text.
- **VS Code chat editing (Copilot agent mode)**, from official docs (code.visualstudio.com/docs/agents/run/review-code-edits) [from prior knowledge; the page was not re-read]:
  - Edits are applied **directly to disk/buffers immediately**. A "working set" or changed-files list in the chat shows each file with +/- counts.
  - Each file opens with an inline diff overlay and per-hunk **Keep / Undo**, file-level Keep/Undo, and "Keep all / Undo all" for the session.
  - Navigation runs through a floating toolbar.
  - `chat.editing.autoAcceptDelay` auto-keeps after N seconds.
  - **Checkpoints** (`chat.checkpoints.enabled`) offer "Restore checkpoint" on each request.
  - Editing a previous prompt reverts subsequent edits.
- **Mapping to ACP:**
  - If we advertise `fs.writeTextFile`, the agent's writes come to us. We can (a) apply them and record the original, as VS Code does (recommended), or (b) hold them pending until the user accepts. Option (b) breaks agents that read back their own writes, so use it only for an explicit "ask before write" mode.
  - Tool-call `diff` content gives `oldText`/`newText` per path for the timeline card.
  - Serve `fs/read_text_file` from **unsaved Monaco buffers** so the agent sees what the user sees, as Zed does.

---

## 6. Rules / instructions files: what a host should load

| File | Owner / reader | Location semantics |
|---|---|---|
| `AGENTS.md` | Open standard (agents.md), now stewarded by the **Agentic AI Foundation** under the Linux Foundation (founded Dec 2025 by OpenAI, Anthropic and Block, which contributed AGENTS.md, MCP and goose respectively [source: secondary]). Read by Codex, Cursor, Copilot, Gemini/agy, OpenCode, Amp, Jules, Zed, etc. | Plain Markdown, no schema. **Nested files: the closest AGENTS.md to the edited file wins**; explicit user chat instructions override. Codex concatenates root→cwd and caps total size (`project_doc_max_bytes`, 32 KiB default) [from prior knowledge]. |
| `CLAUDE.md` | Claude Code | `~/.claude/CLAUDE.md` (user), `./CLAUDE.md` or `./.claude/CLAUDE.md` (project), `CLAUDE.local.md` (private), subdirectory files loaded lazily, and `@path` imports. Claude Code also reads `AGENTS.md` only via `@AGENTS.md` import [from prior knowledge]. |
| `GEMINI.md` | Gemini CLI / agy | Hierarchical: `~/.gemini/GEMINI.md`, then project ancestors and subdirs. Filename configurable via `context.fileName` (can be set to `AGENTS.md`). |
| `.cursor/rules/*.mdc` | Cursor | Frontmatter `description`, `globs`, `alwaysApply`. Legacy `.cursorrules`. |
| `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md` | GitHub Copilot / VS Code | Path-specific files use `applyTo: "glob"` frontmatter. VS Code also honours `AGENTS.md` (`chat.useAgentsMdFile`). |
| `.windsurfrules`, `.clinerules/`, `.roo/rules/` | Windsurf, Cline, Roo | Directory of md files. |

**Host recommendation:**

- With ACP agents, **don't inject rules yourself**. Each agent already loads its own file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) from `cwd`, and double-injecting wastes tokens.
- The IDE should:
  1. Show an "Instructions" panel that detects all of these files.
  2. Offer to create `AGENTS.md` as the canonical file, plus a one-line `CLAUDE.md` containing `@AGENTS.md`, plus `GEMINI.md` → `context.fileName` guidance.
  3. For the IDE's *own* built-in agent (API-key mode), load `AGENTS.md` (nearest-wins, root→leaf concatenation with a byte cap), then `CLAUDE.md` / `GEMINI.md` as fallbacks, then `.cursor/rules` with `alwaysApply` or a glob match.
  4. Treat all of it as untrusted repo content (prompt-injection surface). Show it, don't execute it.

---

## 7. MCP

- **Latest spec: `2026-07-28`** [verified, @modelcontextprotocol/server README]. Earlier versions: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. Spec: https://modelcontextprotocol.io/specification/2026-07-28.
- **TS SDK v2** (the stable line) is split into:
  - `@modelcontextprotocol/server` 2.4.0
  - `@modelcontextprotocol/client` 2.4.0
  - `@modelcontextprotocol/core` 2.4.0
  - All Apache-2.0, zod ^4.
  - Adapters: `@modelcontextprotocol/node`, `/express`, `/hono`, `/fastify`.
  - Docs: https://ts.sdk.modelcontextprotocol.io/v2/
- **v1 legacy:** `@modelcontextprotocol/sdk` 1.32.2 (MIT, Node ≥18), protocol up to `2025-11-25`. Agents bundling older clients negotiate down, and v2 servers still accept older versions [inferred; verify in the migration guide].
- Exports verified in `@modelcontextprotocol/server`: `McpServer`, `StdioServerTransport`, `serveStdio`.

Stdio server sketch (v1 API, widely documented; the v2 API is similar, so check the migration guide):

```ts
import { McpServer } from '@modelcontextprotocol/server';           // v1: '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/server'; // v1: '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod';
const server = new McpServer({ name: 'codexr-ide', version: '0.1.0' });
server.registerTool('ide_get_diagnostics', {
  description: 'Problems reported by the IDE language servers for a file',
  inputSchema: { path: z.string() },
}, async ({ path }) => ({ content: [{ type: 'text', text: JSON.stringify(await ipc('diagnostics', path)) }] }));
await server.connect(new StdioServerTransport());
```

**Exposing host tools to external agents.** There are three options:

1. **Stdio bridge process.** The IDE ships a tiny `ide-mcp.js`, run via Electron's own Node: `process.execPath` with `ELECTRON_RUN_AS_NODE=1`. It connects back to the main process over a local socket or named pipe with a per-session random token, passed in `env`. The IDE then passes it in `session/new.mcpServers` as a stdio server with an absolute `command`. Works with **every** ACP agent.
2. **Loopback HTTP (Streamable HTTP)** server on `127.0.0.1:<random>` with a bearer token header. Only for agents advertising `mcpCapabilities.http`.
3. **MCP-over-ACP** (`type:"acp"`, unstable): no extra process. Supported by the Claude and Codex adapters.

Useful IDE tools to expose:

- `get_diagnostics`
- `get_open_editors` / `get_selection`
- `open_file(path,line)`
- `get_terminal_output`
- `run_task`
- `search_symbols` (LSP)
- `get_git_diff`

Note that the Claude Code VS Code extension does this kind of thing too (its own IDE MCP over a WebSocket lock file) [from prior knowledge].

---

## 8. Background agents with git worktrees

Patterns seen [source: secondary plus prior knowledge; vendor pages not re-read]:

- **Cursor** (2.x/3.x): parallel agents, each in a `git worktree` (`~/.cursor/worktrees/<repo>/<id>`), with a `.cursor/worktrees.json` setup script (install deps, copy `.env`). Results are compared side by side, and an **"Apply"** button merges the chosen agent's changes back into the main working tree. Cloud "background agents" run in remote VMs and open a branch or PR.
- **Codex app** (desktop, 2026): threads run in "Local", "Worktree" or "Cloud" mode. Worktree mode creates `$CODEX_HOME/worktrees/…` on a detached HEAD. "Sync with local" / "Apply to local" or "create branch" hands the work back.
- **Conductor** (Mac): one isolated workspace (worktree plus branch) per Claude Code or Codex agent, a diff viewer, then "create PR" or merge. Per-repo setup script; copies gitignored files such as `.env`.
- **Claude Squad** (OSS, AGPL-3.0, Go, tmux): each agent gets a tmux session plus a worktree. Commit, push or "checkout" to pause and continue.
- **Crystal / Nimbalyst** (OSS, Electron): worktree per session with a diff view, then "rebase from main" and "squash and rebase to main". Emdash (YC W26) is another OSS multi-agent worktree IDE.
- Claude Code itself: `claude --worktree` / `EnterWorktree` [from prior knowledge].

**Merge-back UX consensus:**

1. Show a per-task diff vs. the base commit.
2. Offer "Apply to working tree": a 3-way merge or `git diff base..task | git apply --3way`, with conflicts going to the normal merge editor.
3. Offer "Create branch / PR".
4. Offer "Discard": `git worktree remove --force` plus `branch -D`.
5. Allow a setup script per repo.
6. Cap concurrency, and show status badges (working, needs input, ready for review).

Pitfalls:

- `node_modules` and build caches are duplicated per worktree. Use pnpm's store, symlinks, or a per-repo setup hook.
- Ports collide when several dev servers run. Allocate a port per worktree via env.
- A branch can't be checked out in two worktrees. Use unique `agent/<id>` branches or detached HEAD.
- Run `git worktree prune` on startup.
- On Windows, long paths: put worktrees under userData.
- Gitignored files (`.env`) are missing in new worktrees. Copy them opt-in.

---

## 9. Implementation recommendations for an Electron IDE

### 1. AgentHost in the main process (or a utilityProcess)

- One `AcpConnection` per agent process, spawned with `child_process.spawn` (no shell).
- Pass an explicit env whitelist plus keys from `safeStorage`.
- Set `cwd` to the workspace (or the worktree).
- Use `@agentclientprotocol/sdk@^2.12` with the **stable v1** import. Keep the SDK out of the renderer.
- Forward normalized events to the renderer over a typed IPC channel, in line with the existing `apps/ide` IPC contract and security baseline.
- Serialize `session/update` handling per session.

### 2. Agent catalogue

- Ship three first-class presets: Claude (`@agentclientprotocol/claude-agent-acp`), Codex (`@agentclientprotocol/codex-acp`) and Gemini (`gemini --acp` with an API key; `agy acp` for subscriptions).
- Add an "Add agent from ACP Registry" list fed by a **pinned** registry snapshot.
- Resolve `npx` to an absolute path. Better: `npm install` into `userData/agents/<id>@<ver>` and run `node <bin>` with Electron's Node (`ELECTRON_RUN_AS_NODE=1`), which removes the system Node requirement. Note that claude-agent-acp needs Node ≥22; Electron 45 ships Node 22.x [inferred, verify]. Alternatively use its standalone binaries.
- Download only on explicit user consent, per the project's "no network without consent" principle.

### 3. Auth UI

- Advertise `auth.terminal: true` and implement terminal auth in the integrated terminal (node-pty).
- Show each agent's methods verbatim, using the vendor's wording.
- **Never** read or store vendor OAuth tokens. Only store API keys the user enters, in `safeStorage`.
- Show a "Signed in via Claude Code / Codex / Gemini" status from `auth/status` where available, otherwise infer it from whether `session/new` succeeds.
- Keep the copy compliant. "Claude Code (sign in with your Claude account)" is fine; don't put the Anthropic logo in product branding.

### 4. Client capabilities to implement

- `fs.readTextFile`: serve dirty Monaco buffers.
- `fs.writeTextFile`: apply to the buffer and disk, and record the original for review.
- `terminal`: run commands in visible IDE terminals with a `type:"terminal"` embed in the tool card.
- Permission dialog: `allow_once`, `allow_always` (persist per agent and tool kind), `reject_once`, `reject_always`.
- Config-option pickers for mode, model and thought level, driven by `configOptions` / `config_option_update`, so there's no hard-coded model list.
- Slash commands from `available_commands_update`.
- A plan panel from `plan` / `plan_update`.
- Usage/context meter from `usage_update`.
- History from `session/list` plus `session/load` / `resume`.

### 5. Review and checkpoints

- Apply agent edits immediately, as VS Code chat editing does.
- Maintain a **session working set**: files plus original snapshots.
- Inline per-hunk Keep/Undo via view zones and decorations; file-level and session-level Keep all / Undo all; a multi-file diff view through `createDiffEditor`.
- Shadow-git checkpoints per user turn and before `execute` tool calls, stored in userData with isolated git env (see §4). Restore with a preview.
- Bundle git with `dugite` if no system git is found.

### 6. IDE MCP server

- Run a stdio bridge as an Electron-as-Node child, with a token-authenticated local pipe to the main process.
- Inject it into every `session/new` via `mcpServers`.
- Expose diagnostics, selection, open editors, terminal output, run task, LSP symbol search and open file.
- Use `@modelcontextprotocol/server@2.4` (spec 2026-07-28). Fall back to `@modelcontextprotocol/sdk@1.32` if the v2 API is too new for the agents in use; the version is negotiated at runtime either way.

### 7. Background agents

- "New task in worktree" runs `git worktree add <userData>/worktrees/<repo>/<id> -b agent/<id> <base>`, then the optional setup script, then spawns the agent with `cwd` set to the worktree.
- Task list with status, diff vs. base, then Apply (`git apply --3way`), Create branch/PR, or Discard (remove the worktree and branch).
- Concurrency cap, `git worktree prune` at startup, and per-worktree `PORT`.

### 8. Rules

- Detect and edit `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules` and `copilot-instructions.md`.
- Don't inject them into ACP agents, which load their own.
- Offer "create AGENTS.md" plus pointer files.

### 9. Own agent (API-key mode, optional)

- For users with only API keys, the cheapest route is still to run the adapters: claude-agent-acp with `ANTHROPIC_API_KEY`, codex-acp with `OPENAI_API_KEY`, gemini with `GEMINI_API_KEY`. This avoids writing our own agent loop.
- A built-in loop through the Vercel AI SDK or the vendor SDKs is a later option.

### 10. Testing

- ACP has an in-process mode, `client().connect(agentApp)`, for unit tests with a fake agent.
- Run a smoke test per preset in CI with `--version` only, so no network or login is needed.

---

## Sources

- ACP: https://agentclientprotocol.com/protocol/overview, https://agentclientprotocol.com/protocol/v2/migration, https://agentclientprotocol.com/protocol/schema, https://agentclientprotocol.com/get-started/registry, registry JSON https://cdn.agentclientprotocol.com/registry/v1/v2026.09.07-50f99cd/registry.json, https://zed.dev/blog/acp-registry
- npm tarballs inspected: `@agentclientprotocol/sdk@2.12.0`, `@agentclientprotocol/claude-agent-acp@0.113.0`, `@agentclientprotocol/codex-acp@2.12.1`, `@google/gemini-cli@0.71.1`, `@google/gemini-cli-core` (GitService), `@modelcontextprotocol/sdk@1.32.2`, `@modelcontextprotocol/server@2.4.0`
- Anthropic terms: https://code.claude.com/docs/en/legal-and-compliance ; checkpointing https://code.claude.com/docs/en/checkpointing ; coverage https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/ , https://danielrusnok.substack.com/p/claude-plan-login-third-party-apps-mcp
- OpenAI: https://learn.chatgpt.com/docs/app-server , https://thenewstack.io/sign-in-with-chatgpt/ , https://flaviocopes.com/sign-in-with-chatgpt/ , https://developers.openai.com/siwc
- Google: https://github.com/google-gemini/gemini-cli/blob/HEAD/docs/resources/tos-privacy.md , https://github.com/google-gemini/gemini-cli/discussions/22970 , https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ , https://antigravity.google/docs/ide/extensions/acp/ , https://geminicli.com/docs/cli/acp-mode/ , https://geminicli.com/docs/cli/checkpointing
- Checkpoints: https://docs.cline.bot/core-workflows/checkpoints , https://deepwiki.com/RooCodeInc/Roo-Code/5.6-checkpoint-system , https://docs.roocode.com/features/checkpoints
- VS Code review: https://code.visualstudio.com/docs/agents/run/review-code-edits , https://code.visualstudio.com/docs/copilot/chat/chat-checkpoints
- AGENTS.md: https://www.agents.md , https://openai.com/blog/agentic-ai-foundation
- Worktrees: https://superset.sh/compare/conductor-vs-crystal , https://nimbalyst.com/blog/best-git-worktree-tools-ai-coding-2026/ , https://forum.cursor.com/tag/worktrees

Note: the shared WebFetch budget ran out part-way through. Items marked [from prior knowledge] in §4 (Cline/Roo), §5 (VS Code settings names), §6 (Codex size cap) and §8 (vendor worktree specifics) were not re-read this session.
