# Session log: #31 (templates part) — W2-53..W2-57

Date: 2026-11-25. Branch `claude/project-thread-n2s3q6-runtime`, cut from `origin/v1.2.1` at `399494af`, merged with `origin/v1.2.1` twice (PR #44 feature baseline at the start; PRs #45-#47 at the end). The same branch also carries #37, logged in `37-runtime-dedup.md`. Row amendments from `docs/cleanup/w2-revalidation.md` applied.

## Commits

| Commit | Subject | Row |
|---|---|---|
| `1639ebf5` | chore(templates): delete unreferenced htmlLiveReload.js | W2-53 |
| `5ed3fad4` | chore(templates): delete uncalled baseName() | W2-54 |
| `677d178b` | chore(visual-style): delete the abandoned feature (asset, runtime, test) | W2-55 |
| `7b4d98f5` | docs(components): project-evolution entry, DOM-without-common rule, picker stays standalone, CPX-05 exception | W2-56 |
| `4fe1dc98` | chore(virtual-screen): delete two per-frame logs and pin them out | W2-57 (+ ROADMAP E ruling) |

## Measurements

| Metric | Before | After |
|---|---|---|
| `templates.consoleLog` (ratchet) | 117 | 103 (W2-53 -11, W2-57 -3) |
| `src.files` / `src.unreachableLines` | 369 / 2,317 | 368 / 2,278 (W2-55) |
| `dist/extension.js` (production build) | sha256 `b5e5ad7a1775…`, 1,257,156 B | identical (H1 for W2-55) |
| VSIX | 6,444,316 B, 358 entries | 6,439,782 B, 356 entries (W2-55; W2-53 measured after its own commit) |
| Unit tests | 715 | 708 (the 7 tests of the deleted visual-style runtime) |

## Decisions worth knowing

- **W2-53, W2-55** are authorized removals R6 and R5 of the feature baseline: the snapshot keeps naming them, so `featureSurface.cjs --write` was not needed.
- **W2-55**: the six negative `xrDataSource.test.cjs` guards (`:236, :261-262, :272-273, :280`) are kept verbatim; the test also asserts `existsSync === false` for the asset module and the runtime ("becomes existsSync-false" in the row).
- **W2-57**, range corrected to `followAndTransform.js:589-600`. The ROADMAP E diagnostic sites: `:565-567` and `:573-581` (applyFollowTransform failure paths) are **kept** — they are the only signal of a real failure and fire only in a broken state; `pointerAndDrag.js:104` ("drag intersection missing") is **deleted** — a ray parallel to the plane is an expected geometric case, already handled by returning null. Three negative guards pin the deleted logs out.
- **Guardrail baseline**: on Linux `measureGuardrails --write` also rewrites the informational block (`src.lines`, largest-file order), which was measured on Windows. W2-53 edited only the ratcheted key; later commits took the full regeneration when a real metric moved.

## Gates

`npm test` on every commit (715 → 708 after W2-55). W2-53/W2-55: `npm run package:vsix` + zip listing. W2-55: H1 production build, dist-identical. W2-54: `test:xr-mode-harness` passed.

**Browser harnesses in this environment.** The proxy blocks aframe.io, unpkg and jsdelivr, and the preinstalled Chromium (build 1243) is newer than the one Playwright 1.61 expects (1228). Both were worked around outside the repo, without installing anything: `PLAYWRIGHT_BROWSERS_PATH` pointed at a scratch folder whose `chromium*-1228` entries are symlinks to the preinstalled 1243 builds, and a `--require` preload routed the pinned CDN URLs to the same versions unpacked from `npm pack` tarballs. With that, `test:xr-harness` and `test:xr-mode-harness` pass. `test:xr-immersive-harness` passes its static contract and desktop-baseline checks, then fails at "desktop: W must move the rig forward" — **identically on the parent commit** (software GL, about 12 fps headless), so it was not usable as a gate here. `test:project-evolution-harness` was not needed by any row.

## Deliberately not done

- `followAndTransform.js` / `pointerAndDrag.js`: the other success-path logs (`follow enabled`, `drag start`, `placeInFrontOfUser success`, …) fire once per user action, not per frame; out of W2-57's scope.
- The `SSE_SCRIPT` placeholder set by `createStructure.ts` is used by no template (found while checking #37's SSE clients). Not a W2 row; candidate for a dead-code row.

## F5 checks for the maintainer

1. XR file analysis: open the scene, share a screen, drag it around with the mouse and with a controller; the DevTools console stays quiet while dragging and while "follow" is on.
2. DOM visualization: live reload still updates the page after editing the source file (htmlLiveReload.js was a dead twin of the live client).
