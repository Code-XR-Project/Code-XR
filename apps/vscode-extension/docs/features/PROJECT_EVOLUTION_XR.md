# Project Evolution XR

`Project Evolution` is a chronological XR analysis mode that turns local Git
history into a replayable movie of the project. It complements historical
comparison: historical comparison compares two selected sources side by side,
while project evolution shows one full-table chart changing through many
versions.

## Behavior

- The mode appears in the `Visualization mode` selector as `Project evolution`.
- The mode uses its own orange visual identity in the selector and applies a
  matching table theme while the movie is active.
- If the analyzed target is not inside a local Git repository, the option is
  disabled and explains the reason on hover/raycaster focus.
- By default, CodeXR builds an automatic timeline from older commits to newer
  commits: the **first-parent history of the checked-out branch (HEAD)**, from
  its very first commit. A merge is one step of the branch it landed on.
  Stashes, notes, other branches and commits newer than the checkout are never
  frames (until 1.2.1 the timeline was `git log --all`).
- The whole history is listed and spread over at most 240 candidate revisions,
  first and last included, then sampled to the movie's frames (24 by default),
  so a long history always starts at its beginning. Until 1.2.1 only the newest
  240 commits were considered.
- A range movie is resolved by Git, not looked up in a window: any branch, tag
  or commit the picker offers works as either end, in either order. Two ends on
  diverging branches start from their merge base. The working copy as an end is
  the last frame.
- Tags that point at a tree or a blob are not offered: they have no history.
- The movie always ends on the working copy, the branch as it stands now,
  whether or not it has uncommitted changes.
- The visualization uses a single chart occupying the normal analysis table,
  not the dual chart layout used by historical comparison.

## Playback

The XR panel exposes a compact player:

- generate automatic movie;
- choose automatic, range or manual timelines without carrying stale selections
  between modes;
- page through available Git sources with previous/next arrows;
- mark range starts in green and range ends in red;
- show manual picks with their selection order (the movie itself always plays
  oldest first, and a manual movie holds at most 24 frames: a 25th pick is
  refused with a message);
- play and pause;
- previous and next frame;
- speed presets;
- clear the generated movie for everyone in the shared XR room;
- current frame label, frame count and progress status.

Each frame points the chart datasource at that frame's own file,
`/evolution/revision-N/data<i>.json`, and asks the analysis table to
renormalize. The files are written once and never changed, so participants
seeking at the same time cannot overwrite each other's frame (until 1.2.1 every
frame was copied over a shared `data.json`, which raced). Playback waits for the chart/table to settle, then holds briefly
before advancing, so the movie reads as a sequence of stable scenes instead of a
rapid data swap. While playback is active, a small overlay above the table shows
the current revision, date and frame number. When playback reaches the last
frame, the final chart remains visible and the panel reports completion until
the user generates another movie or presses `Clear movie`; Play on the last
frame starts the movie over. The Field Mapping panel remains
available, so users can change the chart and dimensions while reviewing the
evolution.

Only the current movie is kept on disk: a new movie removes the older
`revision-N` folders, so an export always ships the movie the room was looking
at. `Clear movie` removes the whole `/evolution/` folder, clears the shared
Project Evolution entity, hides the movie chart, and resets every connected
client to the empty Project Evolution panel. It does not delete the normal
analysis `data.json`.

### Cancel, Clear and leaving the mode (1.2.1)

Generating a movie is a job on the extension host with an id, a state
(`queued`, `running`, `cancelled`, `failed`, `done`) and a 30-minute deadline;
each revision's analysis also has its own 5-minute watchdog, and each Git
command a 3-minute one. While a movie is being generated the `Clear movie`
button reads `Cancel`:

- **Cancel** stops the generation for the whole room: it kills the running Git
  and Python processes, discards anything the job would still produce, and
  keeps the movie generated before it.
- **Clear movie** deletes the current movie. If a generation is running, it is
  cancelled and waited for first, so no late movie can appear after the clear.
- **Leaving the mode** changes nothing on the server: the generation goes on
  for the room and its movie appears when it is ready.

The progress bar counts revisions finished (analyzed or discarded) out of the
total, so it only moves forward and reaches the end. Revisions are analyzed
without a VS Code notification each, and each revision's snapshot is deleted as
soon as it is analyzed.

A second Generate while one runs is answered `busy` to that participant only.
A participant who opens the panel mid-generation sees the room's job (the
references reply carries its state). A revision whose analysis times out is
discarded like any other unusable revision; the movie is built from the rest.

## Architecture

`ProjectEvolutionService` reuses the local Git snapshot materialization used by
historical comparison. It never changes the active branch and does not call
remote provider APIs.

The service writes frame payloads under `/evolution/` and publishes a shared
entity:

```ts
{
  entityKind: 'project-evolution',
  entityId: 'main',
  mode: 'project-evolution',
  result: {
    revision: number,
    mode: 'project-evolution',
    frames: ProjectEvolutionFrame[],
    generatedAt: string
  }
}
```

Which revisions a movie can show is decided by `projectEvolutionTimeline.ts`
(automatic and range timelines) over `GitRepositoryService.listTimelineSources`,
which streams `git log --first-parent` line by line, so a very large history
cannot overflow a buffer.

The browser runtime, `projectEvolutionRuntime.js`, is assembled from the parts
listed in `templates/components/codexr/project-evolution/projectEvolutionRuntime/manifest.json`.
It listens for the shared entity and keeps all connected clients on the same
generated movie.

### Export

The export's Git timeline is the same history: the first-parent history of
HEAD. "Entire history" exports all of it, "Only the latest N commits" the
newest N, with no hidden cap (until 1.2.1 N was silently clamped to 1000). The
prompt says how many commits the checked-out branch has and that other
branches, stashes and notes are not exported.

## Initial Limits

- Version units are local Git commits of the checked-out branch's first-parent
  history.
- "Pushes" are represented by commits already present in the local repository.
- GitHub, GitLab or other hosting provider APIs are not queried in this version.
- In a partial clone, revisions whose files are not on this computer are left
  out ("not on this computer (partial clone)"); nothing is downloaded. The
  oldest Git tested is 2.43, as for
  [Historical Comparison](HISTORICAL_COMPARISON_XR.md#limits-and-future-evolution).
- Frames are precalculated before playback to avoid analysis work during the
  animation.
