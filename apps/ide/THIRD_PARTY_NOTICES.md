# THIRD-PARTY NOTICES

The Code-XR IDE (GPL-3.0-only) bundles the third-party material listed here. Each entry says what is used, where it lives in this package and under which licence. Runtime dependencies that are installed rather than copied (Electron, Monaco) carry their own licence files in their packages.

## Material Icon Theme (file and folder icons)

- Project: Material Icon Theme (`material-icon-theme` on npm, 5.40.0)
- Source: https://github.com/material-extensions/vscode-material-icon-theme
- License: MIT

Usage in this package:

- The file and folder icons of the explorer and the editor tabs (#138) are SVG files of this set, copied unchanged into `src/renderer/public/file-icons/` by `scripts/syncFileIcons.mjs`. Only the icons that `src/renderer/fileIcons.ts` can return are copied; `test/fileIcons.test.ts` checks that every copy is byte-identical to the package's.
- They are served from the app bundle (`codexr://app/file-icons/`); nothing is loaded from a CDN.

Licence text:

```
The MIT License (MIT)
Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## vscode-jsonrpc (language server connection)

- Project: `vscode-jsonrpc` on npm, 9.0.3, part of vscode-languageserver-node
- Source: https://github.com/microsoft/vscode-languageserver-node
- License: MIT

Usage in this package:

- Bundled into the main process (`out/main/index.cjs`) by Vite: the JSON-RPC connection over stdio to the language servers (#21, `src/main/lsp/languageServer.ts`).
- `vscode-languageserver-types` (3.18.4, same project, same licence) is used for its TypeScript types only (`import type`); none of its code is bundled.
- `typescript-language-server` (6.1.0, Apache-2.0, https://github.com/typescript-language-server/typescript-language-server) is not bundled: it is installed as a dependency and run from `node_modules` as a separate process, and carries its own licence file there, like Electron and Monaco.

Licence text:

```
Copyright (c) Microsoft Corporation

All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## qrcode-generator (QR code of the headset address)

- Project: `qrcode-generator` on npm, 2.0.4, by Kazuhiko Arase
- Source: https://github.com/kazuhikoarase/qrcode-generator
- License: MIT

Usage in this package:

- Bundled into the renderer by Vite, through the extension's shared core: the QR code a standalone headset scans to open a shared scene (#19, `apps/vscode-extension/src/core/xr/headsetQr.ts`). Declared as a dependency of the extension workspace, like the rest of the core's. "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

## marked (Markdown parser)

- Project: `marked` on npm, 14.0.0, by Christopher Jeffrey and the marked contributors
- Source: https://github.com/markedjs/marked
- License: MIT

Usage in this package:

- Bundled into the renderer by Vite: parses the Markdown preview (#179, `src/renderer/editor/markdownModel.ts`). The same version Monaco already depends on.

## DOMPurify (HTML sanitiser)

- Project: `dompurify` on npm, 3.4.15, by Cure53 and contributors
- Source: https://github.com/cure53/DOMPurify
- License: Apache-2.0 or MPL-2.0 (dual licensed; used here under Apache-2.0)

Usage in this package:

- Bundled into the renderer by Vite: sanitises the Markdown preview's HTML before it reaches the page (#179, `src/renderer/editor/markdownPreview.ts`). The same version Monaco already depends on.

## MCP TypeScript SDK (the Code-XR MCP server)

- Project: `@modelcontextprotocol/sdk` on npm, 1.32.2, by Anthropic, PBC and the Model Context Protocol contributors
- Source: https://github.com/modelcontextprotocol/typescript-sdk
- License: MIT

Usage in this package:

- Bundled by Vite into the Code-XR MCP server (`out/codexrMcp/index.cjs`, AF10, `src/codexrMcp/`) that external agents run to query the project's analysis. Only that bundle carries it; the main process has its own small MCP client (`src/main/agents/mcp/`).
- The bundle also carries the SDK's own dependencies: `zod` (4.6.7, MIT, https://github.com/colinhacks/zod), `zod-to-json-schema` (3.25.2, ISC, https://github.com/StefanTerdell/zod-to-json-schema), `ajv` (8.20.0, MIT, https://github.com/ajv-validator/ajv), `ajv-formats` (3.0.1, MIT), `fast-deep-equal` (3.1.3, MIT), `json-schema-traverse` (1.0.0, MIT) and `fast-uri` (3.0.6, BSD-3-Clause, https://github.com/fastify/fast-uri).

## vscode-textmate (TextMate grammars of extensions)

- Project: `vscode-textmate` on npm, 9.3.2, by Microsoft Corporation
- Source: https://github.com/microsoft/vscode-textmate
- License: MIT

Usage in this package:

- Bundled into the renderer by Vite: tokenizes files with the TextMate grammars that VS Code extensions contribute (#258, `src/renderer/extensions/textmate.ts`).

## vscode-oniguruma (regular expressions of TextMate grammars)

- Project: `vscode-oniguruma` on npm, 2.0.1, by Microsoft Corporation; WebAssembly build of Oniguruma 6.9.5 by K.Kosako
- Source: https://github.com/microsoft/vscode-oniguruma, https://github.com/kkos/oniguruma
- License: MIT (bindings); BSD-2-Clause (Oniguruma)

Usage in this package:

- Bundled into the renderer by Vite, with its `onig.wasm` served from the app (#258). It is why the CSP allows `'wasm-unsafe-eval'`.

Oniguruma's licence text, as `vscode-oniguruma` ships it:

```
Oniguruma LICENSE
-----------------

Copyright (c) 2002-2020  K.Kosako  <kkosako0@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.
```

## yauzl (reading .vsix archives)

- Project: `yauzl` on npm, 3.4.0, by Josh Wolfe
- Source: https://github.com/thejoshwolfe/yauzl
- License: MIT

Usage in this package:

- Bundled into the main process by Vite: reads the `.vsix` (zip) files of extensions before they are unpacked (#254, `src/main/extensions/vsix.ts`).

## jsonc-parser (JSON with comments)

- Project: `jsonc-parser` on npm, 3.3.1, by Microsoft Corporation
- Source: https://github.com/microsoft/node-jsonc-parser
- License: MIT

Usage in this package:

- Bundled into the main process by Vite: reads extension manifests, colour themes, language configurations and snippets, which VS Code allows to contain comments (#254).

## PDF.js (PDF viewer)

- Project: `pdfjs-dist` on npm, 6.5.438, by Mozilla and the PDF.js contributors
- Source: https://github.com/mozilla/pdf.js
- License: Apache-2.0

Usage in this package:

- Bundled into the renderer by Vite: draws PDFs in the PDF viewer tab (#256, `src/renderer/viewers/pdfViewer.ts`). The library is a chunk loaded on the first PDF only.
- Its worker (`pdfjs-dist/build/pdf.worker.mjs`) is bundled the same way and served from the app's origin, so the CSP's `worker-src 'self'` covers it.
- The text-layer rules in `src/renderer/viewers/viewers.css` are a trimmed copy of the `.textLayer` block of its `web/pdf_viewer.css`.
- The optional `@napi-rs/canvas` dependency is only used by PDF.js under Node and is not bundled.

## Agent Client Protocol TypeScript SDK (agent chats)

- Project: `@agentclientprotocol/sdk` on npm, 2.12.0, by Zed Industries and the Agent Client Protocol contributors
- Source: https://github.com/agentclientprotocol/typescript-sdk
- License: Apache-2.0

Usage in this package:

- Bundled by Vite into the main process: speaks the Agent Client Protocol with the coding agents a chat runs (Claude Code, Codex, Gemini CLI; AF1, `src/main/agentSessions/acpConnection.ts`). The agents themselves are separate programs installed by the person and are not part of this package.

## xterm.js search and web-links addons (terminal find and links)

- Project: `@xterm/addon-search` 0.16.0 and `@xterm/addon-web-links` 0.12.0 on npm, by the xterm.js authors (released with `@xterm/xterm` 6.0.0)
- Source: https://github.com/xtermjs/xterm.js
- License: MIT

Usage in this package:

- Bundled into the renderer by Vite, in the terminal's chunk (`src/renderer/terminal/xtermView.ts`), which loads with the first terminal (#286).
- The search addon finds text in a terminal's scrollback and counts the matches for the find widget; the web-links addon detects http(s) URLs, which open through `workspace.openExternalLink` (the main process checks the scheme).

Licence text:

```
Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
