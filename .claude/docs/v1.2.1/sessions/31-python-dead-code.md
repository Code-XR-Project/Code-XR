# Session: #31 Python part (dead Python deletions, W2-58..W2-66)

Date: 2026-11-25. Branch `claude/project-thread-n2s3q6-python`, cut from `origin/v1.2.1` at `cd05e03e`, rebased once onto the merge of PR #44 (feature baseline) before anything was pushed, and with `origin/v1.2.1` merged in at the end (`9c52ca85`). Story: Code-XR-Project/Code-XR#31. The template, asset and tooling rows of the same story belong to other branches. The #36 rows of the same branch are logged in `36-python-backend.md`.

## Commits

| SHA | Subject | Row |
|---|---|---|
| `b4cd92e3` | chore(python): delete the dead livePanels reanalysis twin | W2-58 |
| `62922496` | chore(python): delete examples/ | W2-59 |
| `007d1749` | chore(python): delete the dead progress and warning logger API | W2-60 |
| `cc275125` | chore(python): delete six never-called helpers | W2-61 |
| `3172ad36` | chore(python): drop the unread --output flag and the 'project' type | W2-62 (authorized removal R7) |
| `2f2cea88` | chore(python): stop adding html/ to sys.path | W2-63 |
| `1b2f0771` | chore(python): delete the unreachable .st analyzer and dead aliases (keep .r, .hh) | W2-64 (narrowed) |
| `26515067` | chore(python): delete resume_only and the argparse CLI | W2-65 |
| `b9d1103c` | chore(python): drop four redundant per-file stderr emissions | W2-66 |

Each deletion was proved with the four checks of the cleanup skill (no import, no path string in TS or Python, no dynamic loader, no test or doc pin), and every pin found was classified (G guard, S shape, L log literal) in its commit body.

## Measurements (lizard 1.17.31, ruff 0.17.6 `--isolated`, `backend/src`)

| What | Before (`cd05e03e`) | After W2-66 |
|---|---|---|
| `.py` files / lines | 24 / 3,847 | 22 / 3,464 |
| functions | 132 | 116 |
| functions over CCN 10 / 15 | 17 / 10 | 15 / 10 |
| ruff default rules / E4,E7,E9,F | 308 / 29 | 271 / 25 |
| VSIX (W2-59) | 359 entries, 6,445,591 bytes | 358 entries, 6,443,806 bytes; `dist/extension.js` identical |

## Gates

- After every commit: `npm run test:python` and `npm run test:analysis`. The byte snapshot of every backend entry point used for #36 (sha256 `3e955ce926a2e080`) was taken on top of these commits.
- `npm test`: 715/715 after PR #44 on every commit that touched TS or tests; `test:htmlanalysis` 5/5 for W2-63.

## Deliberately not done, and why

- **`.hh` kept in W2-64** (the row said it was unreachable). It is reachable: `languageMetadata` lists `.hh`, and an XR file analysis of a `.hh` file reports `commentLines` 1 through the comment analyzer. `.r` is kept too (reasons in the `1b2f0771` body). The comment in `test_analyzer_extension_coverage.py` that called them dead was corrected.
- **`DOM_ONLY_LANGUAGE_EXTENSION_MAP` kept in W2-61.** The feature-baseline test (`featureSurface.cjs`) reads it; only its never-called getter went.
- **The `parsed.warning` branch in `executePython.ts` (W2-60)** is now unreachable from Python but left as it is: it is TS, and a no-op branch costs nothing. A candidate for a later TS cleanup.

## Behaviour quirks found (record only)

- None new beyond the `.hh`/`.r` reachability above.

## F5 checks for the maintainer

1. Run an XR file analysis on a `.hh` file: comment lines must still be counted.
2. Run a LivePanel file analysis and a directory analysis: results unchanged. The backend's stderr diagnostics no longer carry the four per-file "Analyzing file / File loaded / File extension / Found N comment lines" lines nor the `(resume_only=False)` suffix.
