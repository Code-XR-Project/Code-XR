# Agent Flow: Visualizing AI Coding Agents in Extended Reality

*Research notes for a fifth Code-XR analysis type. Prepared 2026-11-28 for the TFM. Each claim about prior work cites a source from the reference list (bracketed numbers). Statements marked **(design proposal)** are our recommendations and are not established findings.*

---

## 0. Problem statement

Code-XR already turns a codebase into a scene on a virtual "analysis table" in four ways: classic metrics charts, a dependency graph, a historical comparison and a project-evolution movie. All four describe the **product**, meaning the code at one or more points in time. AI coding agents such as Claude Code, Codex CLI and Gemini CLI add a new object of study: a **process**. In each turn the agent searches, reads, edits and runs commands, and a repository changes as a result. Today a developer who wants to know what the agent did has three options: scroll through a chat transcript, read a terminal log, or review a final diff. None of these shows *where in the system* the agent went, *in what order*, *what it looked at but left alone*, or *how far its changes reach*.

The proposed **Agent Flow** mode draws this process on top of the structures Code-XR already renders. The idea combines three established lines of research: software cities, trace and interaction-history visualization, and replayable animation of repository activity. The new element is the actor, an LLM agent, and the data source, agent protocols and transcripts.

---

## 1. Foundations in software visualization

### 1.1 Code cities and their immersive descendants

Wettel and Lanza's **CodeCity** represents classes as buildings and packages as districts. Building height and footprint encode metrics such as number of methods and number of attributes [1]. In a controlled experiment, the city gave higher correctness and lower completion time than an IDE plus spreadsheet baseline on comprehension tasks over large systems [2]. This gives empirical support to the metaphor Code-XR's table already uses. **Getaviz** generalized the idea into a toolset that generates structural, behavioral and evolutionary views, including city variants, specifically so they can be compared in empirical studies [3].

Several projects moved the city into immersive environments:

- **Code Park** (Khaloo et al.) places code in a walkable 3D "park" of rooms and reports a user study on how easily participants learned and remembered the code [4].
- **CityVR** (Merino et al.) is a gameful VR code city for Pharo. Its study found high engagement, and also found that navigation in VR took considerable time [5].
- Merino et al. also argued that immersive AR can **overcome classic problems of 3D software visualization** (occlusion, navigation, text legibility) [6]. Their systematic review of software-visualization evaluations criticized the field for thin evaluation, which should shape the thesis's study design (Section 4.6) [7].
- **ExplorViz** (Fittkau, Krause, Hasselbring) showed software cities in VR with gesture control [8]. More important for us, ExplorViz was designed around **live trace visualization** of large software landscapes: runtime behavior is drawn as communication on top of a static city [9]. Agent Flow uses the same pattern, with dynamic behavior over a stable structural layout.
- **VR-Git** (Oberhauser) immerses users in a Git repository's commit history in VR [10].

**Layout stability.** Steinbrückner and Lewerentz's **Evo-Streets** use hierarchical, stable street layouts so that a city keeps its shape as the software evolves. This preserves the viewer's mental map across versions [11]. Agent Flow needs the same property, because files created by the agent mid-session must appear without reshuffling the city. A fixed layout also makes different sessions comparable. Mindwalk (Section 2.4) makes the same choice with deterministic layouts [27].

### 1.2 Animated repository activity

**code_swarm** (Ogawa and Ma) animates commits as particles that are attracted to developers. The result is an "organic" view of project activity in which motion carries meaning [12]. **Gource** animates a repository's directory tree as a radial graph, with contributor avatars flying to the files they touch, and is widely used for retrospective storytelling [13]. Both are the direct visual ancestors of an agent "avatar" moving between files. Both also show the main weakness of that style: the animations are engaging, but they are poor at supporting precise questions such as "which file was edited third?" Section 3 returns to this.

### 1.3 Execution-trace visualization

**Extravis** (Cornelissen et al.) pairs a *massive sequence view*, a compressed timeline of the whole trace, with a *circular bundle view*, a hierarchy on a circle with call relations drawn as hierarchically bundled edges [14]. The bundling technique comes from Holten [15]. Extravis maps closely onto our problem. An agent session is a trace of tool calls rather than method calls. A compact timeline plus a structural view with bundled transitions is a proven combination for answering "what happened, and where?"

### 1.4 Developer interaction history and navigation

Kersten and Murphy's **Mylyn** models a *task context*: a degree-of-interest (DOI) value for each program element, raised by interactions (selections, edits) and decayed over time. It was shown to improve programmer productivity when used to filter the IDE [16]. DOI is a ready-made model for "attention" in Agent Flow. An agent's reads and edits can feed the same accumulate-and-decay function, so recent focus glows and old focus fades.

Robillard, Coelho and Murphy found that **effective developers investigate code methodically**, following structural dependencies with a plan. Less effective ones navigated opportunistically and revisited the same places [17]. Ko et al. described maintenance as cycles of *seeking, relating and collecting* information, with a large share of time spent on navigation [18]. These studies supply hypotheses that can be checked against agent behavior. Does an agent follow dependency edges or jump through search results? Is a high revisit rate a sign of disorientation, as it is in humans?

### 1.5 Provenance

Agent Flow is in effect a **provenance visualization**: it records which inputs (files read, search results, command output) preceded which outputs (edits). The W3C PROV data model gives a vocabulary of *entities*, *activities* and *agents* with relations such as `used` and `wasGeneratedBy` [19]. Ragan et al. characterize provenance in visual analytics by type (data, interaction, rationale) and purpose (recall, replication, presentation) [20]. Mapping agent events onto PROV gives the export format a principled schema, and it supports a "why did this line change?" query that walks backwards from an edit to the reads that preceded it **(design proposal)**.

---

## 2. Visualizing AI and LLM agent behavior

### 2.1 Observability and trace viewers

The LLM-ops ecosystem has converged on **span trees**: an agent run is a trace, and each LLM call or tool call is a nested span with inputs, outputs, latency and token counts. **LangSmith** [21], **Langfuse** [22], **Arize Phoenix** [23] and **AgentOps** [24] all present runs this way, as a waterfall or tree with an inspector panel. The **OpenTelemetry GenAI semantic conventions** standardize the vocabulary, including agent spans such as `invoke_agent` and tool spans such as `execute_tool` [25]. These tools are good at debugging prompts and latency. However, they have **no notion of the codebase as a space**. A `read_file` span is a row of text, not a location in an architecture. This gap is the contribution Agent Flow can claim.

### 2.2 Event sources: ACP and agent hooks

The **Agent Client Protocol (ACP)**, created by Zed, standardizes how an editor talks to an agent and is supported by many agents, including Gemini CLI, Codex CLI and a Claude adapter [26]. ACP is especially convenient for Agent Flow because tool calls are reported through `session/update` notifications. Each tool call has a `kind` from a fixed enum (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`), a status (`pending`, `in_progress`, `completed`, `failed`), optional **`locations`** (an absolute path plus an optional line, provided explicitly "so Clients can show which files the Agent is working on"), and content that can be a **diff** (`path`, `oldText`, `newText`) or a terminal [26]. This is almost exactly the event schema the visualization needs: the `kind` selects the visual verb, `locations` selects the building, and the diff feeds the metric delta.

For agents used outside ACP, two other sources work. Claude Code exposes lifecycle **hooks** (for example `PreToolUse` and `PostToolUse`) that receive tool name and input as JSON [28]. Agents also store session transcripts on disk, which is what Mindwalk replays [27].

### 2.3 Research on agent trajectories

Benchmarks such as **SWE-bench** [29] and agents such as **SWE-agent** [30] and **OpenHands** [31] produced large corpora of *trajectories*, and these are now studied empirically:

- **Agentless** (Xia et al.) splits issue resolution into explicit *localization* (file, then class or function, then edit location) and *repair*. It showed that a simple pipeline is competitive with agentic approaches [32]. This frames the read phase of an agent as hierarchical localization, which a city with districts, buildings and floors can show directly.
- **Bouzenia and Pradel** analyzed 120 thought-action-result trajectories (2,822 LLM interactions) from RepairAgent, AutoCodeRover and OpenHands. They identified recurring action sequences and anti-patterns that separate successful runs from failed ones [33].
- **Majgaonkar et al.** compared successful and failed trajectories of OpenHands, SWE-agent and Prometheus. Failed runs were **longer and more variable**. Fault localization found the faulty files in most trajectories, including 72-81% of failed ones, so failure often happens *after* the agent has found the right place [34]. The implication for visualization is that "did it look in the right place?" is not enough. The viewer must also see what happened next: churn, repeated edits, and edits with no verification after them.

Dedicated visual-analytics tools for trajectories are now appearing. **SeaView** supports inspecting and comparing SWE-agent experiments [35]. The **Agent Trajectory Explorer** supports visualizing trajectories and collecting feedback on them [36]. **AgentLens** analyzes the behavior of LLM-based autonomous agents in a multi-agent simulation [37]. Wang et al. present tree, code-diff and projection views of coding-agent solution search [38]. **TraceView** draws program-repair runs as graphs of thought, action and result nodes with typed relations such as repetition and divergence [39]. All of these are 2D and centered on text. None places the trajectory *inside the structure of the codebase*.

### 2.4 How AI IDEs show agent activity

Commercial tools show agent activity mostly as **chat plus diff review**:

- **Zed**'s agent panel can **"follow the agent as it reads and edits files"** (a crosshair toggle), moving the editor viewport along with the agent. It collects changes into a multibuffer review where each hunk can be accepted or rejected [40]. "Follow" is the closest existing analogue to a follow camera in XR.
- Cursor, Windsurf, GitHub Copilot's agent mode and Claude Code all stream tool calls as collapsible cards in a chat transcript and offer diff or checkpoint review. Devin presents a session as a replayable record of its work. These interfaces are linear and textual, and none shows a spatial overview of footprint.
- **Mindwalk** (open source, 2026) is the closest prior art found. It replays Claude Code, Codex and pi sessions on a deterministic 3D map of the repository (radial tree or treemap terrain). Files are colored by their deepest touch (seen = green, read = blue, edited = amber), deleted files appear as wireframe ghosts, and there is a playback deck with a histogram, scrubbing and marks for user turns, subagents and context compactions. Observation steps are cool-colored and mutation steps warm [27]. Mindwalk independently confirms the encoding we propose. It is a desktop web tool with no metric deltas, no dependency-graph blast radius, no immersive mode and no evaluation.
- **VoidCode VR** places Claude Code sessions as floating terminal panels in VR. It is spatial *session management*, not code visualization [41].

**Gap.** No published or open tool found combines (a) an immersive environment, (b) a metric-bearing structural model of the code (city plus dependency graph), (c) agent events mapped by their protocol `kind`, and (d) an empirical evaluation. Agent Flow in Code-XR fills that gap.

---

## 3. Design guidance distilled

### 3.1 Visual verbs: read, write, search, execute

Use **hue category plus motion type** so that the two channels reinforce each other, which also helps color-vision-deficient users:

| ACP `kind` | Hue family | Motion and shape | Rationale |
|---|---|---|---|
| `read` | cool (blue) | short pulse or "scan" of the building's façade, no change in geometry | observation leaves the artifact unchanged |
| `search` | cool (cyan) | expanding ring on the ground that lights the matched buildings at once | one-to-many: a query touches many files |
| `edit` / `move` / `delete` | warm (amber to orange) | building grows or shrinks, with brief scaffolding; delete turns into a wireframe ghost | mutation changes geometry |
| `execute` | neutral (white or grey) | a fixed "console pillar" at the table edge flashes; red on failure | commands are about the whole project, not one file |
| `think` / `fetch` | low saliency | glow on the avatar only | no code location |

The cool-observation / warm-mutation split matches Mindwalk's independent choice [27] **(design proposal, convergent with prior art)**.

### 3.2 Time: animation, small multiples and trails

Tversky, Morrison and Bétrancourt reviewed the evidence and concluded that animation rarely beats equivalent static graphics. Animation helps when it is **simple, slow, controllable** and when the change itself is the content (*congruence* and *apprehension* principles) [42]. Robertson et al. found that trend animation was enjoyed and good for *presentation*, but was **slower and less accurate for analysis** than small multiples or static traces [43]. Four rules follow:

1. Animation is for **replay and storytelling**, not for analysis. It always has play, pause, step and speed controls.
2. Provide a **static summary**, such as a persistent trail, footprint heat and per-turn small multiples, that answers questions without playing anything.
3. Use **trails (comet tails)** that fade over a window of *N* events. They give local order without the clutter of a full path. The fading follows Mylyn-style DOI decay [16].
4. Draw the full navigation path as **bundled edges** routed along the folder hierarchy [14][15], so that a hundred hops read as a few strong flows between districts.

### 3.3 Focus + context

The city is the context and the agent's current target is the focus. Recommended techniques: dim untouched buildings (but keep them), enlarge the label of the current file, and offer an on-demand "drill down" into a building to show the touched functions or line ranges (ACP `locations[].line`) [26].

### 3.4 Metric deltas

Edits change LOC and complexity. Encode a delta with a **diverging scale** centered on zero, for example blue for a decrease and orange-red for an increase. Show it as a ring or cap on the building so that it does not conflict with the warm "was edited" hue. Rely on the size change (height) as the redundant channel. Give exact numbers in the 2D LivePanel. The deltas can come from re-running Code-XR's own analyzer on the affected files after each completed `edit` **(design proposal)**.

### 3.5 Cognitive load in immersive analytics

The Immersive Analytics book (Marriott et al.) warns that immersion only pays off when the third dimension and embodiment carry meaning. Text-heavy detail belongs in 2D panels, and navigation cost is real [44]. CityVR's finding about navigation time [5] and Merino et al.'s case for AR [6] point the same way. Recommendations: a **tabletop** scale (the whole city within arm's reach, as Code-XR already does), few simultaneous animations (at most one active event animated, the rest as trails), and detail moved to a 2D panel.

---

## 4. Recommended design: Code-XR "Agent Flow" mode

### 4.1 Data pipeline **(design proposal)**

1. **Capture.** An ACP client inside the extension (live) or an importer for transcripts and hooks (post hoc) normalizes events to `{t, turn, kind, status, paths[], lines[], diff?, command?, exitCode?}`.
2. **Enrich.** Map paths to Code-XR file nodes. Compute metric deltas with the Python backend. Look up dependency-graph neighbors for each edited file.
3. **Persist.** Write a JSON session file (optionally PROV-shaped [19]) next to the existing analysis outputs, so a session can be replayed, exported and compared, like the project-evolution movie.

### 4.2 Scene layout on the table

- **Base.** A city or treemap with **districts = folders** and **buildings = files**. Height = LOC, footprint = number of functions, base color = complexity. The layout is fixed for the session (Evo-Streets-style stability [11]). Files created during the session appear in reserved slots.
- **Agent avatar ("probe").** A small luminous object that hops between buildings on each event, with a **fading light trail** over the last *N* hops.
- **Verbs.** Reads are cool pulses; writes are warm growth with scaffolding; searches are scanning rings that light the matched files; terminal commands go to a **console pillar** at the table edge (red flash on a non-zero exit).
- **Delta caps.** A diverging-color ring on each edited building, showing net ΔLOC or Δcomplexity since the session start.
- **Dependency overlay (toggle).** Reuses the dependency-graph mode. Edges out of edited files are highlighted to show the **blast radius**, meaning files that depend on what the agent changed but that it never read.

### 4.2.1 As built: our own boats city and agents as workers

Two decisions came from review with the author after the first prototype.

- **Our own city chart.** The base is not a treemap but Code-XR's own city component, `codexr-city`, whose layout ports the spiral of BabiaXR's `babia-boats` (aframe-babia-components 1.3.4, GPL-3.0). It places the heaviest block first and every next one clockwise around everything placed so far. Folders become nested quarters on plates that rise one level per nesting depth. Owning the chart instead of driving `babia-boats` from outside lets the agent layer change buildings directly: scaffolds, new floors, foundations, hazard stripes and demolitions are part of the chart's API.
- **Agents as workers.** A single abstract probe hides the parallelism of current agents, which delegate to sub-agents (Claude Code writes each sub-agent's transcript to a file of its own). Every agent is therefore a worker figure. The main agent and each sub-agent have their own colour, a delegate step spawns a worker with a beam, and each worker's action lasts until its own next step, so parallel work is visible. Each visual verb of §3.1 becomes an action at the building: a scanning cone (read), a radar ripple with beacons (search), scaffolding with a crane and growing floors (write), a test tower with a green check or red siren (execute), and an amber sign while the agent waits for the person's permission. The construction metaphor extends the code-city metaphor naturally (a city where work is going on) and keeps the verbs distinguishable without text, which matters in a headset (§3.5).

### 4.3 Time and interaction

- **Timeline scrubber** along the front edge of the table. **Turn markers** separate user prompts; event ticks are colored by `kind`; marks show failures and subagent launches. Above it, a stacked bar per turn (reads, searches, edits, commands) serves as small multiples [43].
- **Per-turn rings.** Each building carries thin stacked rings, one per turn in which it was touched. Revisits then show up as tall stacks even when nothing is playing.
- **Controls.** Play, pause, step by event, step by turn, speed, "jump to next edit or failure", and a **live mode** that tails an ongoing session.
- **"Follow the agent" camera.** Optional smooth camera follow, as in Zed's follow mode [40]. Off by default in VR to avoid motion discomfort, and on in desktop mode.
- **Provenance query.** Select an edited building to highlight the reads and searches that preceded its edits within the same turn.

### 4.4 2D LivePanel companion

A synchronized web panel shows the transcript snippet for the current event, the diff, the command output and the session metrics. It is also the accessible, low-load fallback.

### 4.5 Session metrics

| Metric | Definition | Use |
|---|---|---|
| Footprint | number of distinct files touched (read ∪ edited) | scope of exploration |
| Read/write ratio | reads ÷ edits | "investigate before acting" (cf. [17]) |
| Revisit rate | share of reads that hit an already-read file | disorientation signal (cf. [17][33]) |
| Localization distance | hops (dependency graph) from the first touched file to the first edited file | efficiency of the search |
| Blast radius | dependents of the edited files (transitive, depth *k*) | review risk |
| Unread dependents | blast-radius files the agent never read | possible oversight |
| Unverified edits | edits with no later `execute` (test or build) | quality signal, cf. "edits after last verification" in [27] |
| Churn | edits to the same region of a file across turns | flailing, cf. longer failed trajectories [34] |
| ΔLOC, Δcomplexity | per file and total | quality impact |

### 4.6 Research questions and evaluation for the TFM

- **RQ1 (comprehension).** Do developers understand *what an agent did* (files touched, order, rationale, risk) more accurately or faster with Agent Flow than with the transcript plus final diff?
- **RQ2 (oversight).** Does Agent Flow help developers detect planted problems, such as an edit to a file with unread dependents, an unverified change, or an off-task excursion?
- **RQ3 (medium).** Immersive (headset) vs. desktop rendering of the same scene: does immersion add value or only cost?

**Study design.** A within-subjects design with counterbalanced conditions: (A) transcript plus diff, (B) Agent Flow on desktop, and optionally (C) Agent Flow in XR. Use pre-recorded sessions on a known open-source project, including SWE-bench-style tasks [29] for realism. Measures: **comprehension accuracy** on a fixed question set (factual, temporal, causal and risk questions), **completion time**, **NASA-TLX** workload [45], detection rate for planted issues, a SUS or preference questionnaire, and short interviews. Follow Merino et al.'s recommendations to report tasks, participants and data openly [7]. A quantitative side study can test whether the metrics in §4.5 separate successful from failed trajectories on public SWE-bench runs, as an extension of [33][34].

---

## 5. Open questions for a possible PhD

1. **Drift prediction.** Can trajectory features measured *during* a run (rising revisit rate, growing footprint without edits, edits with no verification, localization distance) predict failure or task drift early enough to interrupt? Prior trajectory studies [33][34] analyze runs after the fact. Online prediction combined with a spatial "drift alarm" is unexplored.
2. **Trust calibration.** Lee and See describe appropriate reliance as trust matched to an automation's actual capability [46]. Does seeing an agent's footprint calibrate trust (more trust when it read the relevant dependents, less when it did not), or does an attractive visualization produce over-trust?
3. **Scalable oversight.** With several parallel agents and subagents, what visual abstractions (aggregation by district, anomaly highlighting, comparison of agents on one map) let one human supervise many agents?
4. **Human vs. agent navigation.** Do agents navigate like effective or ineffective humans [17][18]? Can Mylyn-style interaction histories [16] from humans and agents be compared on the same city?
5. **Intervention in place.** Can the XR scene become a control surface, for example pinning files as context, fencing districts as off-limits, or approving edits spatially, and does this improve outcomes?
6. **Provenance and accountability.** Can PROV-shaped agent histories [19][20] support audit and blame questions ("which agent turn introduced this complexity?") across a project's whole history, linking Agent Flow to the existing project-evolution mode?

---

## References

1. R. Wettel, M. Lanza. "Visualizing Software Systems as Cities." *4th IEEE Int. Workshop on Visualizing Software for Understanding and Analysis (VISSOFT)*, 2007. DOI: 10.1109/VISSOF.2007.4290706
2. R. Wettel, M. Lanza, R. Robbes. "Software Systems as Cities: A Controlled Experiment." *ICSE 2011*, ACM. DOI: 10.1145/1985793.1985868
3. D. Baum, J. Schilbach, P. Kovacs, U. Eisenecker, R. Müller. "GETAVIZ: Generating Structural, Behavioral, and Evolutionary Views of Software Systems for Empirical Evaluation." *IEEE VISSOFT 2017*. https://bibtex.github.io/VISSOFT-2017-BaumSKE0.html
4. P. Khaloo, M. Maghoumi, E. Taranta II, D. Bettner, J. LaViola Jr. "Code Park: A New 3D Code Visualization Tool." *IEEE VISSOFT 2017*. arXiv:1708.02174. https://arxiv.org/abs/1708.02174
5. L. Merino, M. Ghafari, C. Anslow, O. Nierstrasz. "CityVR: Gameful Software Visualization." *IEEE ICSME 2017 (TD track)*. https://scg.unibe.ch/research/cityvr
6. L. Merino, A. Bergel, O. Nierstrasz. "Overcoming Issues of 3D Software Visualization through Immersive Augmented Reality." *IEEE VISSOFT 2018*. DOI: 10.1109/VISSOFT.2018.00014
7. L. Merino, M. Ghafari, C. Anslow, O. Nierstrasz. "A Systematic Literature Review of Software Visualization Evaluation." *Journal of Systems and Software* 144, 2018. DOI: 10.1016/j.jss.2018.06.027
8. F. Fittkau, A. Krause, W. Hasselbring. "Exploring Software Cities in Virtual Reality." *IEEE VISSOFT 2015*. https://oceanrep.geomar.de/id/eprint/29388
9. F. Fittkau. *Live Trace Visualization for System and Program Comprehension in Large Software Landscapes.* PhD thesis, Kiel University, 2015. https://oceanrep.geomar.de/id/eprint/29511
10. R. Oberhauser. "VR-Git: Git Repository Visualization and Immersion in Virtual Reality." *ICSEA 2022*, IARIA. https://www.hs-aalen.de/uploads/publication/file/11067/ICSEA22-VRGit_OberhauserCR2.pdf
11. F. Steinbrückner, C. Lewerentz. "Representing Development History in Software Cities." *ACM SOFTVIS 2010*. DOI: 10.1145/1879211.1879239. See also "Understanding Software Evolution with Software Cities," *Information Visualization* 12(2), 2013.
12. M. Ogawa, K.-L. Ma. "code_swarm: A Design Study in Organic Software Visualization." *IEEE TVCG* 15(6), 2009. DOI: 10.1109/TVCG.2009.123
13. A. Caudwell. *Gource: software version control visualization.* Open-source tool. https://gource.io
14. B. Cornelissen, D. Holten, A. Zaidman, L. Moonen, J. J. van Wijk, A. van Deursen. "Understanding Execution Traces Using Massive Sequence and Circular Bundle Views." *IEEE ICPC 2007*. DOI: 10.1109/ICPC.2007.39
15. D. Holten. "Hierarchical Edge Bundles: Visualization of Adjacency Relations in Hierarchical Data." *IEEE TVCG* 12(5), 2006. DOI: 10.1109/TVCG.2006.147
16. M. Kersten, G. C. Murphy. "Using Task Context to Improve Programmer Productivity." *ACM SIGSOFT FSE 2006*. DOI: 10.1145/1181775.1181777
17. M. P. Robillard, W. Coelho, G. C. Murphy. "How Effective Developers Investigate Source Code: An Exploratory Study." *IEEE TSE* 30(12), 2004. DOI: 10.1109/TSE.2004.101
18. A. J. Ko, B. A. Myers, M. J. Coblenz, H. H. Aung. "An Exploratory Study of How Developers Seek, Relate, and Collect Relevant Information during Software Maintenance Tasks." *IEEE TSE* 32(12), 2006. DOI: 10.1109/TSE.2006.116
19. W3C. "PROV-DM: The PROV Data Model." W3C Recommendation, 2013. https://www.w3.org/TR/prov-dm/
20. E. D. Ragan, A. Endert, J. Sanyal, J. Chen. "Characterizing Provenance in Visualization and Data Analysis: An Organizational Framework of Provenance Types and Purposes." *IEEE TVCG* 22(1), 2016. DOI: 10.1109/TVCG.2015.2467551
21. LangChain. *LangSmith documentation (tracing).* https://docs.smith.langchain.com
22. Langfuse. *Langfuse documentation (tracing).* https://langfuse.com/docs
23. Arize AI. *Phoenix: AI observability and evaluation.* https://docs.arize.com/phoenix
24. AgentOps. *AgentOps documentation.* https://docs.agentops.ai
25. OpenTelemetry. "Semantic Conventions for Generative AI Agent and Framework Spans." https://opentelemetry.io/docs/specs/semconv/gen-ai/
26. Zed Industries et al. *Agent Client Protocol*: overview https://zed.dev/acp, and "Tool Calls" specification https://agentclientprotocol.com/protocol/tool-calls (accessed 2026-11-28).
27. R. Yu. *Mindwalk: a visualization tool that replays coding-agent sessions on a 3D map of your codebase.* Open source (MIT), 2026. https://github.com/cosmtrek/mindwalk
28. Anthropic. *Claude Code: Hooks reference.* https://code.claude.com/docs/en/hooks
29. C. E. Jimenez, J. Yang, A. Wettig, S. Yao, K. Pei, O. Press, K. Narasimhan. "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?" *ICLR 2024*. arXiv:2310.06770
30. J. Yang, C. E. Jimenez, A. Wettig, K. Lieret, S. Yao, K. Narasimhan, O. Press. "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering." *NeurIPS 2024*. arXiv:2405.15793
31. X. Wang et al. "OpenHands: An Open Platform for AI Software Developers as Generalist Agents." *ICLR 2025*. arXiv:2407.16741
32. C. S. Xia, Y. Deng, S. Dunn, L. Zhang. "Agentless: Demystifying LLM-based Software Engineering Agents." arXiv:2407.01489, 2024. https://arxiv.org/abs/2407.01489
33. I. Bouzenia, M. Pradel. "Understanding Software Engineering Agents: A Study of Thought-Action-Result Trajectories." arXiv:2506.18824, 2025. https://arxiv.org/abs/2506.18824
34. O. Majgaonkar, Z. Fei, X. Li, F. Sarro, H. Ye. "Understanding Code Agent Behaviour: An Empirical Study of Success and Failure Trajectories." arXiv:2511.00197, 2025. https://arxiv.org/abs/2511.00197
35. T. Bula, S. Pujar, L. Buratti, M. Bornea, A. Sil. "SeaView: Software Engineering Agent Visual Interface for Enhanced Workflow." arXiv:2504.08696, 2025. https://arxiv.org/abs/2504.08696
36. M. Desmond et al. "Agent Trajectory Explorer: Visualizing and Providing Feedback on Agent Trajectories." *AAAI 2025 (demo)*. https://ojs.aaai.org/index.php/AAAI/article/view/35350
37. J. Lu et al. "AgentLens: Visual Analysis for Agent Behaviors in LLM-based Autonomous Systems." *IEEE TVCG* 31, 2025. arXiv:2402.08995
38. J. Wang, Y. Chen, M. Pan, C.-C. M. Yeh, M. Das. "Illuminating LLM Coding Agents: Visual Analytics for Deeper Understanding and Enhancement." arXiv:2508.12555, 2025. https://arxiv.org/abs/2508.12555
39. A. Sajadi, T. Nguyen, K. Huynh, E. Parra, P. Chatterjee. "TraceView: Interactive Visualization of Agentic Program Repair Trajectories." arXiv:2606.22110, 2026. https://arxiv.org/abs/2606.22110
40. Zed Industries. *Agent Panel documentation* ("follow the agent", review changes). https://zed.dev/docs/ai/agent-panel
41. *VoidCode VR: spatial VR for AI coding sessions.* https://voidcodevr.com
42. B. Tversky, J. B. Morrison, M. Bétrancourt. "Animation: Can It Facilitate?" *International Journal of Human-Computer Studies* 57(4), 2002. DOI: 10.1006/ijhc.2002.1017
43. G. Robertson, R. Fernandez, D. Fisher, B. Lee, J. Stasko. "Effectiveness of Animation in Trend Visualization." *IEEE TVCG* 14(6), 2008 (InfoVis 2008). DOI: 10.1109/TVCG.2008.125
44. K. Marriott, F. Schreiber, T. Dwyer, K. Klein, N. Henry Riche, T. Itoh, W. Stuerzlinger, B. H. Thomas (eds.). *Immersive Analytics.* LNCS 11190, Springer, 2018. DOI: 10.1007/978-3-030-01388-2
45. S. G. Hart, L. E. Staveland. "Development of NASA-TLX (Task Load Index): Results of Empirical and Theoretical Research." In *Human Mental Workload*, Advances in Psychology 52, North-Holland, 1988. DOI: 10.1016/S0166-4115(08)62386-9
46. J. D. Lee, K. A. See. "Trust in Automation: Designing for Appropriate Reliance." *Human Factors* 46(1), 2004. DOI: 10.1518/hfes.46.1.50_30392

*Verification note: sources [4], [5], [8]–[10], [16], [17], [25]–[28], [32]–[36], [38]–[41] and [43] were checked online while writing (abstracts or pages fetched or indexed). The remaining entries are canonical works whose bibliographic details come from standard records. DOIs should be re-checked against the publisher before thesis submission.*
