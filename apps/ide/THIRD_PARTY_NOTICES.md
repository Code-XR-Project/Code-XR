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
