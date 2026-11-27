# ADR 0002: Run VS Code extensions in the Code-XR IDE with our own extension host and Open VSX

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Adrián Montes Linares (@aMonteSl)
- **Context:** ADR 0001 (Electron + Monaco), the IDE epics #11 and #163, and the extensions epic (stream `ide-extensions`)
- **Design notes:** [`docs/ide/extensions.md`](../docs/ide/extensions.md)

## Context

The Code-XR IDE is a custom Electron + Monaco workbench (ADR 0001): about 30,000 lines of hand-written TypeScript with its own explorer, tabs, Source Control, terminal, Problems, Output, settings, command palette, LSP bridge, debugger and AI agent hub. People coming from VS Code expect their extensions: a colour theme, a language they need highlighted, a linter, a formatter. And Code-XR itself is a VS Code extension: running it unchanged inside the IDE would prove the IDE is a real host and would keep one code base for both.

Three questions must be answered:

1. **How do extensions run?** A VS Code extension is a Node.js module that `require('vscode')` and calls an API of about 700 functions and classes, plus a `package.json` whose `contributes` section declares themes, grammars, languages, snippets, commands, menus, views, settings and keybindings without any code.
2. **Where do they come from?** The Visual Studio Marketplace is the default source in VS Code.
3. **What is legal and safe?**

## Options considered

### A. Fork Code-OSS, or embed VS Code's workbench with `@codingame/monaco-vscode-api`

`monaco-vscode-api` (MIT) re-packages VS Code's own services on top of Monaco, including the real extension host (in a worker or a Node process) and the real workbench parts. It is the route with the highest compatibility: the API is VS Code's own code. OpenVSCode Server, code-server, VSCodium and Eclipse Che (Che-Code) reach the same result by forking VS Code outright.

Rejected for now. Its services take over exactly what the IDE has built by hand and is still building in parallel (layout, theming, keybindings, views, the editor model and its tabs); adopting it means replacing the workbench, not adding a feature. It pins the IDE to Monaco builds that follow VS Code's monthly releases, and ADR 0001 already rejected a fork for its maintenance cost. It stays the fallback if the coverage gaps of option C turn out to dominate (see "Revisit when").

### B. Eclipse Theia's plugin system

Theia (EPL-2.0) implements the VS Code API in its own plugin host. Its implementation cannot be lifted out without Theia's dependency-injection framework, which ADR 0001 rejected, and its coverage is still partial in the areas that matter to Code-XR (webviews, tree views).

### C. Our own extension host, Theia-style, scoped to what people use (chosen)

Follow VS Code's process model with our own code:

- **Declarative contributions are handled by the workbench itself**, with no extension code running: colour themes (VS Code theme JSON turned into a Monaco theme and the workbench's colour tokens), TextMate grammars (`vscode-textmate` + `vscode-oniguruma`, both MIT, the libraries VS Code uses), languages and their language configuration, snippets, and the settings schema. This is most of what people install by count: themes and language support.
- **Extension code runs in a separate Node process per window**, the *extension host*, started with Electron's own Node (`ELECTRON_RUN_AS_NODE`), like the language servers (#21). It intercepts `require('vscode')` and hands each extension an API object of its own. Extensions never run in the renderer and never get the renderer's privileges; a crash or a hung extension never takes the window down.
- **The API is implemented incrementally**, by what popular extensions and `vscode-languageclient` call: commands, messages and quick picks, output channels, status bar, configuration, text documents and their events, diagnostics, language features bridged to Monaco providers, workspace file system and file watchers, tree views and webviews. **Anything not implemented degrades instead of throwing**: unknown `register*` functions return a no-op `Disposable`, and every such call is logged once per extension in an *Extensions* channel of the Output panel. That log is the coverage measurement that decides what to implement next.

Trade-offs accepted: compatibility is partial and has to be measured per extension; proposed APIs, notebooks, the debug API, authentication providers, custom editors and remote development are out of scope at first; a language pack only translates VS Code's own UI strings, which the IDE does not use, so it installs but changes nothing visible.

## Marketplace: Open VSX, never the Visual Studio Marketplace

The [Visual Studio Marketplace Terms of Use](https://cdn.vsassets.io/v/M190_20210811.1/_content/Microsoft-Visual-Studio-Marketplace-Terms-of-Use.pdf) allow installing Marketplace offerings only in Visual Studio products and services. The IDE therefore uses **[Open VSX](https://open-vsx.org)**, the vendor-neutral registry run by the Eclipse Foundation, which VSCodium, Theia, Gitpod, Eclipse Che, code-server and Cursor use. Its REST API is public and needs no key (`/api/-/search`, `/api/{namespace}/{name}`, the `.vsix` and its `sha256`). The registry URL is a setting, so a company can point the IDE at its own Open VSX instance. A `.vsix` file can also be installed from disk.

Consequences: some Microsoft extensions are not on Open VSX and their licences forbid use outside VS Code (Pylance, C/C++, C# Dev Kit, Remote Development, Live Share, GitHub Copilot). The IDE neither works around this nor downloads them from Microsoft. Their open-source counterparts are on Open VSX (basedpyright, clangd, etc.).

## Licensing

- The IDE is GPL-3.0; the extension host and the API shim are our own code. Libraries used: `vscode-textmate`, `vscode-oniguruma`, `vscode-uri` (MIT). The API typings (`@types/vscode`) are MIT and only used to check the shim.
- Extensions are not shipped with the IDE: the person installs them at run time, each under its own licence, which the Extensions view shows before installing.

## Security

An extension is arbitrary code that runs with the person's rights, as in VS Code. The IDE does not pretend otherwise, and applies the same rules VS Code does, plus what its own baseline (README "Security baseline") requires:

- **Nothing is downloaded unless the person asks** (searching or installing in the Extensions view). The `.vsix` is checked against the `sha256` the registry publishes, and unpacked with path checks (no `..`, no absolute paths, no links) into `<userData>/extensions/`.
- **Installing shows who publishes it** (Open VSX's verified-publisher flag), its licence, and that it will run code with the person's rights.
- **Workspace trust (#177):** in Restricted Mode only extensions that declare `capabilities.untrustedWorkspaces.supported` are activated, as in VS Code. Declarative contributions (themes, grammars) still apply.
- **The renderer stays sandboxed.** Extension code never runs in it. Webviews of extensions run in sandboxed iframes from their own origin with their own CSP, and talk to the host only through `postMessage` relayed by the main process. The renderer CSP gains `'wasm-unsafe-eval'` only, for the Oniguruma regex engine of TextMate grammars (VS Code does the same); `eval` stays forbidden.
- Every extension can be disabled or uninstalled, and the host can be restarted, from the Extensions view.

## Revisit when

- The *Extensions* coverage log shows that the extensions people actually use fail on API areas too large to write by hand (notebooks, debug, custom editors), or
- `monaco-vscode-api` can be adopted per service without replacing the workbench.

Then option A becomes the better trade, and this host is retired.
