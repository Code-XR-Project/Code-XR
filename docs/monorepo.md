# Monorepo layout

Code-XR became an npm-workspaces monorepo so that the VS Code extension and the upcoming Code-XR IDE (Electron + Monaco, epic #11) can share the analysis backend, the XR scenes and the analysis logic from one repository, with one history, one issue tracker and one CI.

## Tree

```
.
├── apps/
│   ├── vscode-extension/   the published extension (npm workspace "code-xr")
│   └── ide/                the Code-XR IDE, placeholder only
├── backend/
│   ├── src/                Python analysis backend
│   └── tests/              its unittest suites and goldens
├── packages/               shared workspaces, planned (see packages/README.md)
├── docs/                   repository-level docs (this file)
├── media/                  release screenshots, GIFs, video index (not shipped)
├── pages/                  GitHub Pages redirect
├── .github/workflows/      CI (Windows, Linux, macOS) and Pages deploy
├── .claude/                AI/dev context and skills, shared by the whole repo
├── .vscode/                launch and task configs (open the repo root)
├── package.json            workspace root: workspaces, mirrored scripts, overrides
└── package-lock.json       the only lockfile
```

## What moved where

| Before | After |
|---|---|
| `src/`, `test/`, `templates/`, `examples/`, `resources/`, `scripts/`, `manual_test/`, `docs/` | `apps/vscode-extension/<same name>/` |
| `package.json`, `tsconfig.json`, `webpack.config.js`, `eslint.config.mjs`, `esbuild.config.mjs` | `apps/vscode-extension/` (`.vscode-test.mjs` moved too and was deleted in 1.2.1: the integration lane it configured had no tests) |
| `README.md`, `CHANGELOG.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md` | `apps/vscode-extension/` (they ship in the VSIX). The root has its own `README.md` and a copy of `LICENSE`. |
| `src/code_analysis/python/` | `backend/src/` |
| `test/python/` | `backend/tests/` |
| `package-lock.json` | stays at the root (workspace lockfile) |
| `media/`, `pages/`, `.github/`, `.claude/`, `.vscode/`, `.nvmrc`, `.mcp.json`, `CLAUDE.md` | unchanged, at the root |

Inside `apps/vscode-extension/` every relative path is the same as it was at the old repository root. Documents and skills written before the move that say `src/...`, `test/...` or `templates/...` mean `apps/vscode-extension/src/...` and so on; `src/code_analysis/python/` means `backend/src/` and `test/python/` means `backend/tests/`.

## What had to change for the move

- **Workspaces.** The root `package.json` declares `apps/*` and `packages/*` and mirrors every extension script (`npm test`, `npm run package:vsix`, ...) by delegating to the `code-xr` workspace. `overrides` moved to the root because npm ignores it inside a workspace. Dependency versions in the lockfile are unchanged.
- **Hoisted `node_modules`.** The extension scripts call their tools as `node ../../node_modules/<tool>/...`, keeping the original "run the JS entry with node, no shell shims" approach. `scripts/package-vsix.mjs` resolves `@vscode/vsce` through Node instead of a fixed path.
- **VSIX packaging.** vsce now runs with `--no-dependencies` (webpack already bundles every runtime dependency; without the flag vsce would pull the hoisted root `node_modules` into the VSIX) and with `--baseContentUrl` / `--baseImagesUrl` pointing at `apps/vscode-extension`, so the README's relative links keep working on the Marketplace.
- **Backend copy.** `webpack.config.js` copies `../../backend/src` into `dist/code_analysis/python` (same destination as before, so the packaged extension is unchanged) and now fails the build if the backend is missing. The development fallbacks in `executePython.ts` and `gitRevisionExporter.ts` point at `<repo>/backend/src`.
- **Tests.** Tests that read backend sources or repository-level config (`.vscode/`, `.claude/`) were retargeted. The text-scanning policies in `uiPolicy.test.cjs` now fail when a scanned folder does not exist, so a future move cannot turn them into silent passes.
- **Editor.** `.vscode/launch.json` and `tasks.json` stay at the root and point into `apps/vscode-extension`.
- **CI.** Runs from the root, on Windows, Linux and macOS, for pull requests to `master` and to release branches (`v1.2.1`, ...).

## Proof that the extension did not change

Built with `CODEXR_NO_SOURCEMAPS=1 npm run package:vsix` before and after the move, on the same machine:

- same 360 files in the VSIX, and every file byte-identical except `dist/extension.js`, the lazy chunk and `package.json`;
- `package.json` differs only in the script paths and the `overrides` block moving to the root;
- the bundle and the lazy chunk differ, token by token, only in webpack's numeric module ids (they are derived from module paths) and in the development fallback paths to the backend;
- unit tests 707/708 before and after on Linux (the one failure is a pre-existing Windows-path assertion), Python suites 52/52, HTML DOM suite 12 + 5, per-language analysis fixtures green.

## Cross-platform rules

Linux, Windows and macOS are all first-class. In practice:

- Build paths with `path.join` / `path.resolve` (TypeScript, JS) and `pathlib` (Python), never with string concatenation or hard-coded separators.
- Prefer `node <script>` in npm scripts over shell-specific syntax; npm runs scripts with `cmd.exe` on Windows and `sh` elsewhere.
- Keep the CI matrix on all three operating systems. Linux and macOS currently report without blocking (the repository was developed on Windows with a CRLF working tree); make them required once their fallout is fixed.
