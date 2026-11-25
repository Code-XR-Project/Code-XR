# Code-XR

Code-XR analyzes source code and lets you walk through it in extended reality: code metrics, the dependency graph, Git history and collaborative sessions, all local, VR optional.

This repository is an **npm-workspaces monorepo**. It holds the published VS Code extension, the Python analysis backend it runs, and the space for the upcoming standalone Code-XR IDE (Electron + Monaco).

> Looking for the extension itself, its features and how to install it? Read **[apps/vscode-extension/README.md](apps/vscode-extension/README.md)**. That file is also the Marketplace page.

## Layout

| Path | What lives there | Status |
|---|---|---|
| [`apps/vscode-extension/`](apps/vscode-extension/) | The VS Code extension (`aMonteSl.code-xr`): TypeScript sources, XR scene templates and browser runtimes, examples, resources, user docs, tests and packaging scripts. | Active, published |
| [`apps/ide/`](apps/ide/) | The standalone Code-XR IDE (Electron + Monaco). | Placeholder, not started |
| [`backend/`](backend/) | The Python analysis backend (Lizard metrics, dependency engine, XR/LivePanel/DOM data producers) and its unit tests. Shipped inside the extension at `dist/code_analysis/python`. | Active |
| [`packages/`](packages/) | Code shared between the apps. Empty today: see [`packages/README.md`](packages/README.md) for what moves here and when. | Planned |
| [`docs/`](docs/) | Repository-level documentation (monorepo layout, cross-platform notes). Extension user docs stay in `apps/vscode-extension/docs/`, next to the README that links them. | Active |
| [`media/`](media/) | Release screenshot and GIF masters, the shot list ([`SHOTLIST.md`](media/SHOTLIST.md)) and the video index. Nothing reads this folder at HEAD: the extension README loads its images from absolute URLs pinned to the release tag, and the website keeps its own copies. Not shipped. | Archive |
| [`pages/`](pages/) | The GitHub Pages redirect to the website. | Active |

More detail, including why the XR templates and the shared TypeScript logic are not split into packages yet, is in [`docs/monorepo.md`](docs/monorepo.md).

## Getting started

Requirements: Node.js (version in [`.nvmrc`](.nvmrc)), npm, Git, and Python 3 for the backend and its tests. Linux, Windows and macOS are all supported.

```bash
npm ci              # installs every workspace from the repository root
npm test            # typecheck + lint + compile-tests + unit tests of the extension
npm run test:backend   # Python backend unit tests
npm run lint:python    # ruff over backend/ (pip install -r backend/requirements-dev.txt first)
npm run package:vsix   # builds apps/vscode-extension/artifacts/code-xr-<version>.vsix
```

Every script of the extension is mirrored at the root and delegates to the `code-xr` workspace, so `npm run <script>` works from either folder. Always install from the root: the workspace shares one `node_modules/` and one `package-lock.json`.

To debug the extension, open the repository root in VS Code and press F5 (**Run CodeXR Extension**).

## License

[GPL-3.0-only](LICENSE).
