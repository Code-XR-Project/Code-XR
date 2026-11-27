# Agent-first IDE (epic #265): manual test guide

Everything here has unit tests and the IDE smoke test, run on Linux, Windows and macOS in CI, and the main flow was driven in the real window on Linux with a scripted agent. What CI cannot do is sign in to a real vendor agent. These checks need you, your machine and your own subscriptions. Each row names the story it closes; when all rows of a story pass, move its card to **Done**.

## Before you start

1. Update your copy to the `ide` branch, then from the repository root: `npm ci` and `npm run ide:dev` (or `npm run ide:start`).
2. Have at least one agent you can sign in to. Any of:
   - **Claude Code** (Claude Pro/Max or an Anthropic API key): the IDE can install its adapter for you (step 2.1), or `npm install -g @agentclientprotocol/claude-agent-acp`.
   - **Codex** (ChatGPT Plus/Pro or an OpenAI key): `npm install -g @agentclientprotocol/codex-acp`.
   - **Gemini CLI** (Google account or Gemini API key): `npm install -g @google/gemini-cli`.
   Installing from the IDE needs Node.js (npm) on your PATH. The adapters are large (Claude Code and Codex each download a native binary of about 400 MB).
3. Use a small project of your own that is a git repository, with the Python analysis environment ready (status bar: "Python: ready").

## 1. Layout and first run

| # | Story | Steps | Expected |
|---|---|---|---|
| 1.1 | #278 | Start the IDE with no chats yet. | The welcome page shows "Get started" with three steps; steps already done are marked Done. **Skip** hides it for good; *Chat: Show Getting Started* in the palette (F1) reopens it as a tab. |
| 1.2 | #269 | Look at the window, then press Ctrl+Alt+M (Cmd+Alt+M on macOS) twice. | Agent layout: Chats on the left, work area in the middle, live analysis on the right. Classic is the workbench as before. The choice survives a restart. |
| 1.3 | #273 | Open your project in the Agent layout. | The right column shows the XR scene once the analysis finishes (or "Analyse this project"). The × hides the column; *View: Toggle Live Analysis Column* brings it back. |

## 2. Agents and sign-in

| # | Story | Steps | Expected |
|---|---|---|---|
| 2.1 | #267 | In the Chats view, Agents section, press **Install** on an agent that is not installed. | A description appears (package, version, licence, size, source, install scripts), then a native dialog with the exact npm command. Nothing downloads before you confirm. Progress shows as a notification; the agent becomes "Installed". **Remove** asks again before deleting. |
| 2.2 | #266 | Press **Check** on an installed agent. | It becomes "Ready", or "Needs login" with the vendor's own login buttons. |
| 2.3 | #297 | Press **Check** on Claude Code while signed out, then a login button (for example **Claude Subscription**). | Check says **Needs login**, not Ready. The button opens a terminal tab named after the method that runs the sign-in itself: the browser opens, or it prints a link and waits for the code. When it ends, the agent is checked again and says **Ready, Signed in as ...**. The IDE never asks for your password or token. Codex (ChatGPT) and Gemini (Google) open the browser from the agent itself. |
| 2.4 | #297 | On Codex press **API Key** (on Gemini CLI, **Gemini API key**), paste a key and press **Save and sign in**. Then press **Forget key**. | A password field opens under the agent. With a valid key the agent becomes **Ready** and a **Forget key** button appears; a refused key is not kept and the reason is shown. Forget key sends it back to **Needs login**. The key is never shown again. |

## 3. A coding chat

| # | Story | Steps | Expected |
|---|---|---|---|
| 3.1 | #268 | **New chat**, then ask for a small real change ("add input validation to X"). | The chat opens as a tab, streams the answer, shows the plan and each tool call (reads, edits with a diff, commands with their output). |
| 3.2 | #266 | When the agent asks to edit or run something. | A card with Allow / Always allow / Reject. The chat in the list shows "Needs your approval"; with the window in the background you get a notification with *Open chat*. |
| 3.3 | #268 | Type `/` and `@` in the composer; change the mode and model selects; send a second message while the agent works. | Slash commands and file attachments are offered; the message is queued and sent when the turn ends. **Stop** (or Esc) cancels a turn. |
| 3.4 | #275 | Ask: "Use the Code-XR tools to tell me the three most complex files". | The agent calls `get_hotspots` (tool card titled with `[Code-XR]`) and answers from your analysis. |
| 3.5 | #272 | Create two chats, rename one, search, restart the IDE. | Chats are grouped by project with status and time; tabs come back after the restart; a deleted chat closes its tab. |
| 3.6 | #298 | On a ready agent that you have already used in this project from its own CLI, press **Import chats**, keep the ticks and press **Import**. | Your earlier chats for this folder are listed with their dates; the chosen ones appear in the Chats list. Opening one shows its messages; sending a message continues it. Importing again does not duplicate them. |

## 4. Review, checkpoints, live analysis

| # | Story | Steps | Expected |
|---|---|---|---|
| 4.1 | #273 | Watch the scene while the agent edits files. | The scene updates by itself (status bar: "Code-XR re-analysis updated N file(s)"), no save needed. |
| 4.2 | #274 | After a turn that changed code. | Under the turn: "Metrics: Complexity max a -> b, LOC ...", folded detail per file. |
| 4.3 | #270 | Press **Changes (N)** in the chat header. | A tab lists the changed files with a side-by-side diff. **Keep** and **Undo** per file and for all work; Undo puts the file back on disk. |
| 4.4 | #271 | On an earlier message, **Restore files to here**. | It lists the files it will change, then puts them back as they were before that message. Your own git history is untouched (`git status` and `git log` unchanged except the file contents). |

## 5. Project instructions and worktrees

| # | Story | Steps | Expected |
|---|---|---|---|
| 5.1 | #276 | Chats view, *Project instructions*: **Create** AGENTS.md, edit it, start a new chat and ask "what are the project rules?". | The file opens from a template; the agent quotes your rules. CLAUDE.md created from the panel imports AGENTS.md. |
| 5.2 | #277 | New chat with **Separate worktree** ticked; ask for a change; then Commit and Merge into your branch. | The agent works in a worktree outside the project (branch `codexr/agent/...`); your working copy only changes on Merge. Discard removes the worktree and its branch. |

## Known limits

- The scene follows the main project, not a chat's worktree.
- Checkpoints are skipped on very large projects (over 20,000 files) and ignore git-ignored files and files over 5 MB.
- An agent reads files from disk: unsaved editor changes are not visible to it.
- The built-in agents of the AI hub (Assistant, Code reviewer, Architect) still chat in the Agents view.
