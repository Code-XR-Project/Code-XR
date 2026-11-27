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

### Popular extensions from Open VSX (2026-11-27)

Thirty popular extensions, latest Open VSX release, measured by the CI job (Linux, no folder content, nothing else installed). **23 activate, 4 have no code (themes, the Docker pack, the Spanish language pack), 2 fail and 1 does not answer within 30 s.**

The first measurement had five failures. Three were fixed in the host from what the probe reported: extensions shipped as ES modules could not `import 'vscode'` (Prettier), enums of unimplemented areas were missing and reading them at start-up threw (`TestRunProfileKind`: Python; `QuickInputButtonLocation`: GitLens), and `VSCODE_NLS_CONFIG` was not set (Markdown All in One). What remains:

- **vue.volar** reads `extensions.getExtension('vscode.typescript-language-features').isActive`: it is built on VS Code's built-in TypeScript extension, which the IDE does not have.
- **yzhang.markdown-all-in-one** gets past its `VSCODE_NLS_CONFIG` read now, then fails building its completion provider (`Object.entries` of undefined); it relies on VS Code's built-in Markdown support.
- **golang.go** does not finish activating within 30 s without the Go toolchain installed; it was not investigated further.

"Missing vscode API" is what the extension touched and got a stub for: it keeps running without that feature (for example GitLens without its custom editors and terminal integration, Python without its test explorer and terminals). Error lines about a language server that could not start (rust-analyzer, Java) come from the runner having no such toolchain, not from the IDE.

| Extension | Version | Result | Missing vscode API at start-up | Notes |
|---|---|---|---|---|
| redhat.vscode-yaml | 2.1.2026112008 | activated | languages.registerSelectionRangeProvider | 1 commands registered; 1 error line(s): (node:2379) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs ar... |
| esbenp.prettier-vscode | 12.4.0 | activated | none | 3 commands registered |
| dbaeumer.vscode-eslint | 3.0.34 | activated | none | 6 commands registered |
| eamodio.gitlens | 2026.11.260409 | activated | workspace.registerFileSystemProvider, window.registerWebviewPanelSerializer (panels are not restored after a restart), window.onDidChangeTerminalShellIntegration, window.registerCustomEditorProvider, window.registerFileDecorationProvider, window.registerTerminalLinkProvider | 799 commands registered; 2 error line(s): TypeError: Cannot read properties of undefined (reading 'fsPath')   [   57 →    8a] GitProviderService.registrationComplete — failed [1ms] |
| ms-python.python | 2026.10.0 | activated | tests.createTestController, window.onDidWriteTerminalData, window.createTerminal, window.onDidStartTerminalShellExecution, window.registerTerminalLinkProvider, lm.registerTool | 33 commands registered; 1 error line(s): Dir "/tmp/codexr-compat-EMtJbf/workspace/.pixi/envs" is not watchable (directory does not exist) |
| rust-lang.rust-analyzer | 0.4.3134 | activated | none | 58 commands registered; 3 error line(s): /tmp/codexr-compat-J7VwN8/extensions/rust-lang.rust-analyzer-0.4.3134/server/rust-analyzer --version: {   stdout: '',   stderr: '',   status: undefined,   error: Error: spawn /... |
| golang.go | 0.58.0 | timeout | window.registerWebviewPanelSerializer (panels are not restored after a restart) | No answer within 30000 ms. |
| streetsidesoftware.code-spell-checker | 4.10.0 | activated | window.onDidChangeActiveNotebookEditor, window.registerTerminalProfileProvider, languages.registerInlineCompletionItemProvider | 79 commands registered |
| usernamehw.errorlens | 3.30.0 | activated | none | 20 commands registered |
| pkief.material-icon-theme | 5.40.0 | activated | none | 11 commands registered |
| vscodevim.vim | 1.32.4 | activated | none | 70 commands registered; 2 error line(s): Unhandled promise rejection in an extension: Error: ENOENT: no such file or directory, open '/tmp/codexr-compat-XoLvQb/storage/global/vscodevim.vim/.registers' |
| christian-kohler.path-intellisense | 2.8.0 | activated | none |  |
| editorconfig.editorconfig | 0.18.2 | activated | none | 2 commands registered |
| yzhang.markdown-all-in-one | 3.6.2 | failed | none | 29 commands registered; Cannot convert undefined or null to object; 1 error line(s): Failed to activate: TypeError: Cannot convert undefined or null to object     at Object.entries (<anonymous>)     at new MdCompletio... |
| gruntfuggly.todo-tree | 0.0.215 | activated | none |  |
| mechatroner.rainbow-csv | 3.24.1 | activated | languages.registerDocumentRangeSemanticTokensProvider | 25 commands registered |
| formulahendry.code-runner | 0.12.2 | activated | none | 4 commands registered |
| dracula-theme.theme-dracula | 2.25.1 | no-code | none |  |
| github.github-vscode-theme | 6.3.5 | no-code | none |  |
| llvm-vs-code-extensions.vscode-clangd | 0.6.0 | activated | none | 3 commands registered |
| vue.volar | 3.3.14 | failed | none | Cannot read properties of undefined (reading 'isActive'); 1 error line(s): Failed to activate: TypeError: Cannot read properties of undefined (reading 'isActive')     at Gr (/tmp/codexr-compat-EuPd4O/extensions/vue.vo... |
| svelte.svelte-vscode | 110.3.2 | activated | none | 10 commands registered |
| bradlc.vscode-tailwindcss | 0.16.0 | activated | none | 2 commands registered |
| hashicorp.terraform | 2.40.1 | activated | lm.registerMcpServerDefinitionProvider | 32 commands registered |
| tamasfe.even-better-toml | 0.21.2 | activated | languages.registerDocumentSemanticTokensProvider | 5 commands registered |
| james-yu.latex-workshop | 10.20.1 | activated | window.registerWebviewPanelSerializer (panels are not restored after a restart), window.registerCustomEditorProvider, languages.registerWorkspaceSymbolProvider, languages.registerColorProvider, languages.registerSelectionRangeProvider | 71 commands registered |
| oderwat.indent-rainbow | 8.3.1 | activated | none |  |
| ms-azuretools.vscode-docker | 2.0.0 | no-code | none |  |
| redhat.java | 1.59.2026112708 | activated | window.registerCustomEditorProvider | 29 commands registered; 5 error line(s): Language Support for Java (Syntax Server) client: couldn't create connection to server. Launching server using command /tmp/codexr-compat-hggjk7/extensions/redhat.java-1.59.202... |
| ms-ceintl.vscode-language-pack-es | 1.131.0 | no-code | none |  |

## Known limits

- **Language packs** (`MS-CEINTL.vscode-language-pack-*`) install and are listed, and have no visible effect: the IDE's interface is its own and does not read VS Code's UI strings.
- **File icon themes and product icon themes** are listed in the details page but not applied yet.
- **Missing API** is reported, never fatal: the call returns a harmless stub (an empty disposable, `undefined`) and the *Extensions* output names it once. An extension that depends on it for a feature will lack that feature.
- **Webview permissions**: no webview gets camera, microphone, XR or popups.
- **Debuggers, tasks, authentication providers, notebooks, the test explorer, SCM providers, comments, chat participants, terminals created by extensions and custom editors** are among the larger API areas not implemented; [vscode-api-inventory.md](vscode-api-inventory.md) lists the surface.
- **The Visual Studio Marketplace** is not used (its terms allow only Microsoft products): extensions published only there are not installable from the view. A `.vsix` the person has the right to use installs from file.
