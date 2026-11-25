# Shared packages (planned)

`packages/*` is a workspace glob in the root `package.json`. It is empty today, by design.

The target is two packages that both apps (the VS Code extension and the future IDE) depend on:

| Package | Will contain | Lives today in |
|---|---|---|
| `packages/core` | Editor-agnostic analysis and metrics logic: field schema, chart models, analysis results, dependency/evolution data shaping. | `apps/vscode-extension/src/` (`core/analysis/`, `core/charts/`, parts of `features/visualize-data/`) |
| `packages/xr-scenes` | A-Frame / BabiaXR scene templates, the browser runtimes under `templates/components/`, LivePanel and guide pages. | `apps/vscode-extension/templates/` |

## Why they were not extracted in the monorepo move

The move was kept **behaviour-neutral**: the packaged VSIX has the same 360 files; the only changes inside it are the development-only fallback path to the backend in the bundle and the script paths in `package.json`. A clean extraction of either package needs refactoring first, which belongs in its own reviewed change:

- **Templates are resolved at runtime from the extension folder.** About fifteen modules build paths such as `path.join(context.extensionPath, 'templates', ...)`, and the VSIX ships `templates/**` through the `files` allowlist. Moving them out needs a build step that stages them back into the extension, plus a different answer for the F5 "workspace direct" launch.
- **The TypeScript logic imports `vscode` throughout.** `core/analysis/` still mixes pure logic with `ExtensionContext` and the VS Code API. Pulling out `core` means first separating the editor-agnostic parts behind an interface, which is a structural refactor (see wave W5 of the v1.2.1 programme).
- **About half of the unit tests read source files as text** (`readFileSync` + regex) by path. Every file that moves needs those tests retargeted in the same commit.

The Python backend had none of these problems (the extension already copied it into `dist/` at build time), so it moved to [`../backend/`](../backend/) now.
