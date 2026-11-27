// Installers for the Code-XR IDE (#20), built by electron-builder.
//
//   npm run dist --workspace=code-xr-ide          the current OS's installers
//
// The app itself is apps/ide/out (main, preloads, renderer: every npm
// dependency is bundled by Vite except node-pty), plus the three runtime
// packages that run as files: node-pty (native), and typescript-language-
// server with TypeScript, which run as a separate process (#21). Those three
// are unpacked from the asar archive so they can be loaded and spawned.
//
// The extension's core expects its own package beside it (installRoot in
// src/main/appIcon.ts is process.resourcesPath once packaged): the Python
// backend, the scene templates, the examples, the icons and avatars, and the
// vendored scene libraries, copied as extra resources. The Python venv itself
// is still created on first run, after consent (#15).
//
// Unsigned: see the "Installers" section of the README for what that means
// on each OS.
const EXTENSION = '../vscode-extension';
// The installer icon is the IDE's own 512x512 copy: electron-builder refuses
// anything smaller on macOS, and the extension's icon.png is 256x256 since
// 1.2.1 (the Marketplace listing does not need more).
const INSTALLER_ICON = 'build-resources/icon.png';
// The installed Electron (package.json holds a range; the binaries are per release).
const { version: electronVersion } = require(require.resolve('electron/package.json'));

module.exports = {
    appId: 'org.codexr.ide',
    productName: 'Code-XR IDE',
    executableName: 'code-xr-ide',
    electronVersion,
    // node-pty ships N-API prebuilds for every OS and loads them in Electron
    // as in Node (#137): nothing to compile, so no toolchain on the CI runners.
    npmRebuild: false,
    nodeGypRebuild: false,
    copyright: 'Copyright (C) Adrián Montes Linares',
    directories: { output: 'release', buildResources: 'build-resources' },
    // No space in a file name (productName has one): easier to download and script.
    artifactName: 'Code-XR-IDE-${version}-${arch}.${ext}',
    files: ['out/**/*', 'package.json', 'THIRD_PARTY_NOTICES.md', '!**/*.map'],
    asarUnpack: [
        '**/node_modules/node-pty/**',
        '**/node_modules/typescript-language-server/**',
        '**/node_modules/typescript/**',
    ],
    extraResources: [
        { from: `${EXTENSION}/dist/code_analysis`, to: 'dist/code_analysis' },
        { from: `${EXTENSION}/templates`, to: 'templates' },
        { from: `${EXTENSION}/examples`, to: 'examples' },
        { from: `${EXTENSION}/resources`, to: 'resources', filter: ['icon.png', 'icon.svg', 'avatars/**/*', 'languages_icons/color/**/*'] },
        { from: `${EXTENSION}/test/vendor/scene-libraries`, to: 'test/vendor/scene-libraries' },
        { from: `${EXTENSION}/LICENSE`, to: 'LICENSE' },
        { from: `${EXTENSION}/THIRD_PARTY_NOTICES.md`, to: 'THIRD_PARTY_NOTICES-extension.md' },
    ],
    linux: {
        target: ['AppImage', 'deb'],
        category: 'Development',
        icon: INSTALLER_ICON,
        maintainer: 'Code-XR Project',
    },
    deb: { packageName: 'code-xr-ide', artifactName: '${name}_${version}_${arch}.${ext}' },
    win: { target: ['nsis'], icon: INSTALLER_ICON },
    nsis: { artifactName: 'Code-XR-IDE-Setup-${version}.${ext}', oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false },
    mac: {
        target: ['dmg'],
        category: 'public.app-category.developer-tools',
        icon: INSTALLER_ICON,
        // Not signed with a developer certificate nor notarised (thesis
        // prototype). '-' signs ad hoc, which Apple silicon requires for any
        // app to start at all; Gatekeeper still asks on first open (README).
        identity: '-',
    },
    // No auto-update feed: an update check is a network call and needs consent
    // (project principle); the IDE's opt-in check reads GitHub releases itself.
    publish: null,
};
