---
name: session-close
description: End-of-session ritual for CodeXR — update V1.2.1_STATUS.md and the CHANGELOG, sync area docs, confirm tests ran, and commit on the correct branch. Use when finishing a feature, bug fix, refactor, or docs task, or when the user says "wrap up", "commit this", or "we're done".
---

# Close a CodeXR session

The repo, not chat history, is the memory between sessions. Before ending, walk this checklist top to bottom.

## 1. Tests actually ran

`npm test` green (plus the narrowest area script — see the `verify` skill). If anything was skipped, record it as an open item in the status doc instead of staying silent.

## 2. Update the volatile state — same session, not later

- **`.claude/docs/V1.2.1_STATUS.md`** (the active status doc; `V1.2.0_STATUS.md` is a closed historical record): append to the session log what landed (scope, mechanism, measurements before/after, tests with counts, gates green); update the "Now" column of a baseline row you moved; add newly discovered inconsistencies to the debt notes (never fix docs silently).
- **`apps/vscode-extension/CHANGELOG.md`** `[1.2.1]` (provisionally dated): user-visible changes only, correct subsection (Removed/Changed/Fixed); internal hygiene is already summarized under "Internal improvements".

## 3. Sync any doc whose subject changed

| Changed | Update |
|---|---|
| Module responsibilities, contracts, seams | `.claude/docs/ARCHITECTURE.md` |
| npm scripts, launch configs, test layers | `.claude/docs/DEVELOPMENT.md` |
| Python CLI, field schema, venv | `.claude/docs/PYTHON_ANALYSIS.md` |
| Scene generation, runtimes, chart system | `.claude/docs/XR_COMPONENTS.md` + `templates/components/COMPONENTS.md` (load order!) |
| Doc added/removed/repurposed | `.claude/docs/INDEX.md` |

## 4. Commit hygiene

- Branch: `v1.2.1` or a `feature/*` branch off it — **never commit directly to `master`** (it is the PR target).
- Expect CRLF noise in `git status` on this machine; stage deliberately, don't `git add -A` blindly across the ~250-file working tree.
- One unit of work per commit series; don't bundle unrelated working-tree drift into your commit.
- `.claude/**` never ships in the VSIX; `docs/**`, `templates/**`, `examples/**` do (package.json `files` allowlist) — double-check nothing internal landed in a shipped folder.

## 5. Report

State what ran, what changed, what's confirmed vs inferred, and any open questions you appended to the status doc.
