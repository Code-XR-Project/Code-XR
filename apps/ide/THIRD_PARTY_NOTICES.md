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
