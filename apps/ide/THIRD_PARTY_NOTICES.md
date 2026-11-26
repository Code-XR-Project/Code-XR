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

- Bundled into the renderer by Vite: the QR code a standalone headset scans to open a shared scene (#19, `src/renderer/sceneQr.ts`). "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
