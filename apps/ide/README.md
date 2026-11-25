# Code-XR IDE (placeholder)

This folder will hold the standalone **Code-XR IDE**, built on **Electron + Monaco** (decision recorded in ADR 0001, epic #11).

**Nothing is implemented here yet, on purpose.** The monorepo was prepared first so that the IDE can reuse, without publishing packages between repositories:

- the Python analysis backend in [`../../backend/`](../../backend/);
- the XR scene templates and browser runtimes, today in [`../vscode-extension/templates/`](../vscode-extension/templates/);
- the analysis and metrics logic, today in [`../vscode-extension/src/`](../vscode-extension/src/).

When work starts, this folder becomes an npm workspace (its own `package.json`, picked up by the `apps/*` glob in the root `package.json`) with the usual Electron split: `main/`, `preload/` and `renderer/`. Installers for Linux (AppImage/deb), Windows (exe/msi) and macOS (dmg) are planned through electron-builder or Electron Forge, built by a three-OS CI matrix.

See [`../../docs/monorepo.md`](../../docs/monorepo.md) for the overall layout.
