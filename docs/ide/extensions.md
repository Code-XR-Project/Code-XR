# VS Code extensions in the Code-XR IDE

Epic #251. Decision: [ADR 0002](../../adr/0002-vscode-extensions-in-the-ide.md). This document is the design and the current state; it is updated by every story of the epic.

## What works

| Kind of extension | Status | Story |
|---|---|---|
| Install from Open VSX (search, details with README, install, update) | Done | #254, #255 |
| Install from a `.vsix` file | Done | #254 |
| Enable, disable, uninstall, disable all | Done | #254, #255 |
| Colour themes (JSON, JSON with comments, `include` chains, `.tmTheme`) | Done | #257 |
| Languages, `language-configuration.json`, TextMate grammars (with injections and embedded languages), snippets | Done | #258 |
| Extensions with code (commands, messages, output, configuration, documents, diagnostics, language features) | Next | #259, #260 |
| Tree views, view containers, webviews | Planned | #261 |
| The Code-XR extension itself | Planned | #262 |
| File icon themes, product icon themes | Not yet: listed in the details page | — |
| Language packs | Install, no visible effect (the IDE does not use VS Code's UI strings) | #264 |

## Processes and files

```
renderer (sandboxed)                main process                         disk
--------------------                ------------                         ----
extensions/extensionsView.ts  --IPC-->  extensions/extensionsService.ts   <userData>/extensions/
extensions/contributionsController.ts   ├─ extensionStore.ts  ------------>  extensions.json
extensions/monacoContributions.ts       ├─ vsix.ts (yauzl)                    <publisher>.<name>-<version>/
extensions/textmate.ts (+ onig.wasm)    ├─ openVsx.ts  ---- https ---->  Open VSX registry
                                        ├─ contributions.ts (themes, grammars, snippets)
                                        └─ manifest.ts, plist.ts (pure)
```

- **Contract:** `src/shared/extensions.ts` (`ExtensionsApi`, `EXTENSION_IPC_CHANNELS`, the types), exposed as `window.codexr.extensions`.
- **Store:** one folder per installed version under `<userData>/extensions/`, and `extensions.json` (what is installed, from where, what is disabled). It is never in a project, so a folder cannot enable an extension (#263). `--disable-extensions` on the command line turns every extension off for one session.
- **Install:** the main process downloads (Open VSX) or reads (`.vsix`) the archive, reads its `extension/package.json` (localised with `package.nls.json`), shows a native confirmation with the publisher, whether the registry verified it, the licence, the source and whether it runs code, then unpacks it into a staging folder and renames it into place. The previous version is removed after the new one is recorded.
- **Unpacking** (`vsix.ts`): only entries under `extension/`; each must be a relative path with no `..`, `\`, drive letter, NUL or empty segment; no symbolic links (Unix mode in the external attributes); at most 30,000 entries, 256 MB a file and 768 MB in total (sizes checked while inflating, not only as declared). A failure leaves nothing behind.
- **Open VSX** (`openVsx.ts`): `GET /api/-/search`, `GET /api/{namespace}/{name}[/{targetPlatform}][/{version}]`, the files the answer links (README, icon, `.vsix`, `.sha256`). The platform build (`linux-x64`, `win32-x64`, `darwin-arm64`...) is preferred, the universal one is the fallback. Downloads must be https (or the registry's own origin); the archive must match the registry's SHA-256, and a registry that publishes none is refused. Icons reach the page as `data:` URLs, so the renderer's CSP stays offline. The registry is the setting `extensions.gallery.serviceUrl` (https, or http on this machine); requests go through Electron's `net.fetch`, which honours the system proxy.
- **Network:** only when the person searches, opens a registry page or installs. The view's *Browse popular extensions* is a button, not something the view does on open.

## Declarative contributions

The main process reads the files the manifest names, always through `resolveInExtension` (inside the extension's folder, links included), and hands the renderer the parsed result; grammars travel by an opaque reference (`<extension id>#<index>`), never by path.

- **Colour themes.** The theme picker (*Preferences: Color Theme*, `Ctrl/Cmd+K Ctrl/Cmd+T`) lists the extensions' themes after Follow the OS / Dark / Light and previews them as you move. Choosing one stores two settings: `workbench.colorThemeExtension` (the theme id, `ext:<extension>/<theme>`) and `workbench.colorTheme` (`dark` or `light` from the theme's `uiTheme`, so `prefers-color-scheme`, the file icons, xterm and the scene follow). `themeModel.ts` turns the theme into a Monaco theme (default colours, one rule per TextMate scope, plus Monarch aliases such as `constant.numeric` -> `number` so Monaco's own tokenizers are coloured too) and into the workbench's colour tokens (`--editor`, `--panel`, `--chrome`, `--status`...) set on the root element, with every theme colour also as `--vscode-*` for extension webviews later. A theme whose extension is disabled or removed falls back to following the OS, with a notification.
- **Languages.** Registered in Monaco with their extensions, file names, patterns and first-line regex; `language-configuration.json` (comments, brackets, auto-closing and surrounding pairs, folding, word pattern, indentation and on-enter rules, patterns compiled safely) applies to languages Monaco does not already know. Files opened before their language was registered are moved off plain text. Monaco cannot unregister a language: a removed extension's file associations stay until the window reloads.
- **TextMate grammars.** `vscode-textmate` with the Oniguruma engine as WebAssembly (`vscode-oniguruma`, `onig.wasm` served by the app). A grammar loads when Monaco first meets its language. Injections (`injectTo`) and embedded languages are passed through. Tokens carry their innermost scope, which theme rules match by prefix. Lines over 20,000 characters are not tokenized and a line gives up after 500 ms, as in VS Code. An extension's grammar replaces Monaco's own tokenizer for that language.
- **Snippets.** A completion provider per language with the snippets (`prefix`, `body`, `description`, `scope`), inserted as Monaco snippets.

## Security

- CSP: `script-src 'self' 'wasm-unsafe-eval'` (WebAssembly only; `eval` and `new Function` stay blocked, which the smoke run checks).
- Nothing an extension declares runs in the renderer: themes and grammars are data; snippets are text.
- Extensions with code will run in a separate extension host process (#259), activated only in trusted folders unless they declare support for Restricted Mode (#263).

## How to try it

1. `npm run ide:dev` (or `ide:start`).
2. Extensions view (activity bar, puzzle icon, or `Ctrl/Cmd+Shift+X`): type `dracula`, *Install*, confirm the native dialog. Or the view's download icon / *Extensions: Install from VSIX…* with a `.vsix` file.
3. *Preferences: Color Theme* and pick the new theme; the editor and the workbench change colour.
4. Install a language extension (for example `tamasfe.even-better-toml` for the grammar, or a `.vsix` of VS Code's built-in `ini`/`swift` extensions), open a file of it: the status bar names the language and the file is highlighted.
5. Disable or uninstall from the row; the theme falls back to the OS one.

The unit tests are `apps/ide/test/extensions.test.ts` (manifest, VSIX reader with zip-slip and symlink archives, store, contributions, Open VSX client against a fake registry) and `apps/ide/test/extensionsRenderer.test.ts` (theme conversion, language configuration, the view model).
