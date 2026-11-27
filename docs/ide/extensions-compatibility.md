# Extension compatibility of the Code-XR IDE

Story #264 of epic #251. Which VS Code extensions run in the IDE, measured rather than assumed, and how to measure a new one. The design is in [extensions.md](extensions.md).

## How it is measured

`apps/ide/scripts/extensionCompat.mjs` (logic in `apps/ide/src/main/extensions/compatProbe.ts`, tests in `apps/ide/test/extensionCompat.test.ts`) does, for each `.vsix`:

1. Installs it through the IDE's own install path (`ExtensionStore`: the same unpack, zip-slip and symlink checks, manifest validation and folder layout as the *Extensions* view), in a throw-away store.
2. Starts the real extension host (`apps/ide/src/extensionHost/index.ts`) in a Node process of its own, with a trusted, empty folder open.
3. Fires every activation event the extension declares (and the implicit ones VS Code adds), plus `*` and `onStartupFinished`.
4. Records whether the extension activated or failed, every `vscode` API it used that the host does not implement (the same report the *Extensions* output shows), the errors it logged, and how many commands it registered.

What it answers: *does the code start in the IDE, and what does it miss at start-up*. What it does not answer: whether every feature works. A feature behind a command or a language request can still reach a missing API later, which the *Extensions* output then names. Webviews and tree views are checked in the real window by the *Code-XR extension in the IDE* CI job and by hand (see below).

Run it:

```bash
cd apps/ide
npm run compat -- --markdown path/to/one.vsix path/to/a/folder/of/vsix
npm run compat -- --markdown --open-vsx redhat.vscode-yaml esbenp.prettier-vscode   # downloads first (same client and SHA-256 check as the IDE)
```

`--json <file>` also writes the full results. The exit code is 1 when a package failed to install, activate or answer.

The *Popular extensions in the extension host* job of `.github/workflows/ci.yml` runs it on about thirty popular extensions from Open VSX on every pull request and writes the table to the job summary. It is a measurement, never a gate: a third-party release must not turn the build red.

## Results

### Packages checked locally (2026-11-27)

Microsoft's [extension samples](https://github.com/microsoft/vscode-extension-samples) built from source, VS Code's own built-in `ini`, `swift` and two themes packed as `.vsix`, two test extensions written for #261, and the Code-XR extension itself.

| Extension | Version | Result | Missing vscode API at start-up | Notes |
|---|---|---|---|---|
| amontesl.code-xr | 1.2.1 | activated | none | 107 commands registered; also checked in the real window (tree, LivePanel in a webview, XR) |
| codexr-test.cat-coding | 0.0.1 | activated | none | Webview panel and view; checked in the real window |
| codexr-test.todo-tree-demo | 0.0.1 | activated | none | Tree view, menus, `when` clauses; checked in the real window |
| vscode-samples.configuration-sample | 0.0.1 | activated | none | |
| vscode-samples.helloworld-minimal-sample | 0.0.1 | activated | none | |
| vscode-samples.lsp-sample | 1.0.0 | activated | none | Language client and server; diagnostics and completion checked in the real window. The probe stops it while the client is still starting, which it logs as a `deactivate()` error |
| vscode-samples.progress-ts | 0.0.1 | activated | none | |
| vscode-samples.quickinput-sample | 0.0.1 | activated | none | |
| vscode-samples.status-ts | 0.0.1 | activated | none | |
| vscode.ini | 10.0.0 | no code | — | Language, grammar |
| vscode.swift | 10.0.0 | no code | — | Language, grammar, snippets |
| vscode.theme-monokai | 10.0.0 | no code | — | Colour theme |
| vscode.theme-solarized-light | 10.0.0 | no code | — | Colour theme |

### Popular extensions from Open VSX

Measured by the CI job; see the table below once filled in, or the job summary of any recent pull request for the current numbers.

<!-- compat:popular -->

## Known limits

- **Language packs** (`MS-CEINTL.vscode-language-pack-*`) install and are listed, and have no visible effect: the IDE's interface is its own and does not read VS Code's UI strings.
- **File icon themes and product icon themes** are listed in the details page but not applied yet.
- **Missing API** is reported, never fatal: the call returns a harmless stub (an empty disposable, `undefined`) and the *Extensions* output names it once. An extension that depends on it for a feature will lack that feature.
- **Webview permissions**: no webview gets camera, microphone, XR or popups.
- **Debuggers, tasks, authentication providers, notebooks, the test explorer, SCM providers, comments, chat participants, terminals created by extensions and custom editors** are among the larger API areas not implemented; [vscode-api-inventory.md](vscode-api-inventory.md) lists the surface.
- **The Visual Studio Marketplace** is not used (its terms allow only Microsoft products): extensions published only there are not installable from the view. A `.vsix` the person has the right to use installs from file.
