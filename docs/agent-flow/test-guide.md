# Agent Flow: manual test guide

Agent Flow is the fifth analysis type of Code-XR (epic #319). It puts an AI
coding agent's session on the XR table: the project is a city (districts are
folders, buildings are files, height is code lines), and a probe walks the
city as the agent reads, searches, edits and runs commands. This guide checks
it end to end in the VS Code extension and in the Code-XR IDE. It takes about
20 minutes.

The design and the related work are in [research.md](research.md).

## What you need

- A project folder you can analyse with Code-XR (the extension's own
  `apps/vscode-extension` works well: it has about 900 files).
- At least one agent session about that folder. Any of these will do:
  - a Claude Code session started in the folder (its transcript is in
    `~/.claude/projects/<folder with every non-alphanumeric character replaced by "-">/`);
  - a Codex CLI session started in the folder (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`);
  - a chat in the Code-XR IDE with the folder open.
- A browser for the XR scene (Chrome or Edge on the desktop is enough; a
  headset is optional).

Nothing here sends anything over the network: the transcripts are read
locally, and the scene is served by the local Code-XR server.

## 1. VS Code extension: open a past session

1. Open the project folder in VS Code with the extension installed.
2. In the Code-XR sidebar, expand **AI Agents**. The section now reads
   "Agent Flow" and lists **Watch an agent in XR** plus up to five recent
   agent sessions of this folder, newest first, each with its agent and age.
   With no sessions, it says so instead.
3. Click a session.
   - Expected: if no XR scene of the folder is open, Code-XR starts the project
     XR analysis first (the usual progress notification), then opens the scene
     in the browser on the **Agent flow** mode.
   - Expected: the table shows the city. Folders are coloured districts,
     files are buildings. The status line of the controller says which session
     is loaded.
4. The command palette entry **Code-XR: Watch an Agent in XR (Agent Flow)**
   does the same through a quick pick.

## 2. Reading the scene

Every agent is a small robot worker with a name tag: the main agent in
emerald, each sub-agent in its own colour. Check each action while it plays:

| What the agent did | What you should see |
|---|---|
| Handed a task to a sub-agent (Claude Code's Agent/Task tool) | A beam from the main worker, and a new smaller worker that pops out and works in parallel; when its work ends it flies back and dissolves |
| Read a file | The worker stands on the roof and sweeps a cyan scanning cone down the facade; the roof stays tinted cyan |
| Searched (grep, glob, find) | A violet radar ripple on the table, and beacons popping up on the matched buildings |
| Edited a file | Scaffolding and a small crane on the building, orange floors stacking up by the added lines (a red slice drops off for removed lines) |
| Created a file | A foundation slab and the building rising from the ground inside the scaffold |
| Deleted a file | The building leans and sinks with a dust puff |
| Ran a command | The worker walks to the test tower (front-left corner): its lights chase, then a green check, or a red siren with red tape on the files written in that turn |
| Waited for your permission (IDE chats) | The worker stops with a pulsing amber "!" sign; red if you rejected it |
| Edited a file nobody read first | Yellow and black hazard stripes round the building's base |
| Touched a file outside the analysis | It appears in the strip on the right of the table |

The city is Code-XR's own chart, modeled on babia-boats: folders are plates
that rise one level per nesting depth, and the biggest files sit in the
middle of the spiral. The timeline at the front has one lane per worker.

## 3. The controller (Agent flow view)

The controller panel shows the session list, the transport, the toggles and
the session metrics.

1. **Agents**: one chip per worker with its colour and step count; a chip is
   bright while that worker is busy.
2. **Transport**: Play / pause, Back and Next (one step), Prev turn and Next
   turn (jump between the person's prompts). The timeline along the table edge
   has one tick per step, coloured by verb, and one band per turn.
3. **Speed**: 0.5x to 4x.
4. **Toggles**:
   - Trail: the path of the probe.
   - Heat: buildings coloured by how often the agent touched them.
   - Blast radius: for each edited file, the files that import it; the
     dependents the agent never read get pulsing amber tape and the rest of
     the city is dimmed (this needs the dependency
     graph of the analysis, so open it once from the dependency mode if the
     toggle shows nothing).
   - Turn rings: one ring per turn around the files it touched.
5. **Metrics**: turns, reads, writes, searches, runs, read/write ratio,
   revisit rate, blind writes (edits to a file never read first), unverified
   edits (edits with no command run after them), unread dependents, failures,
   and the code-line and complexity deltas.
6. **Refresh** reloads the session list; **Close** leaves the session.

Expected: stepping back and forward is exact (the same step always shows the
same scene), and nothing in the browser console is red.

## 4. Live: follow an agent while it works

1. With the scene open on Agent flow, start a new Claude Code or Codex session
   in the folder and give it a small task ("add a test for X").
2. Press **Refresh** in the controller. The session appears at the top with a
   red **LIVE** badge. Open it.
3. Press **Follow live**. Expected: each new step reaches the table within
   about a second of the agent doing it, and the probe follows it.
4. When the agent saves files, the project re-analysis runs as usual and the
   buildings it changed take their new heights and complexity.

## 5. Code-XR IDE

1. Open the project folder in the IDE and open its XR analysis (the right-hand
   pane, then "Open in browser" if you want the full scene).
2. Start a chat with any agent and give it a task.
3. Press **Watch in XR** in the chat header.
   - Expected: the status bar says Agent Flow is following the chat, and the
     scene switches to the Agent flow mode with this chat loaded, live.
   - With no scene open, the status bar asks you to open the XR analysis first.
4. Chats that run in a separate worktree are drawn on the project's buildings
   (the worktree paths are mapped back onto the project).
5. Other chats of the folder also appear in the scene's session list.

## 6. Collaboration

Open the scene's invitation link in a second browser (or a headset). Expected:
the guest sees the same session and playback, but cannot open or close a
session: only the person running Code-XR can choose what is shown.

## What to report

For anything wrong, note the agent (Claude Code, Codex, IDE chat), the step
in this guide, and a screenshot of the scene with the controller visible. The
browser console (F12) usually names the cause.

## Automated coverage

- `apps/vscode-extension/test/analysis/agentFlowCore.test.cjs`: transcript
  parsers, shell classification, the city layout, the dataset builder, the
  service and the room bridge.
- `apps/vscode-extension/test/analysis/agentFlowRuntime.test.cjs`: the browser
  runtime (playback, timeline, overlays) against a scripted session.
- `apps/ide/test/agentFlowFeed.test.ts`: the IDE feed and Watch in XR.
- `apps/vscode-extension/test/manual/agent-flow-harness.html`: the scene alone,
  on the scripted session, for screenshots.
