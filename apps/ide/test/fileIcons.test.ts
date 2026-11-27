import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bundledIconNames, fileIconStyleSheet, iconClass, iconFor, iconUrl, LIGHT_VARIANTS } from '../src/renderer/fileIcons.ts';

const IDE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = path.join(IDE_ROOT, 'src', 'renderer', 'public', 'file-icons');
const CONTRACT = path.resolve(IDE_ROOT, '..', '..', 'backend', 'src', 'utils', 'metric_language_contract.py');

/** Every extension of the metric contract, read from the Python source so the two cannot drift. */
function contractExtensions(): string[] {
    const source = fs.readFileSync(CONTRACT, 'utf8');
    const extensions = [...source.matchAll(/"\.([a-z0-9+]+)"/g)].map((match) => match[1] ?? '');
    assert.ok(extensions.length >= 50, `expected the contract's extensions, found ${extensions.length}`);
    return extensions;
}

describe('iconFor', () => {
    it('gives every language of the metric contract its own icon', () => {
        for (const extension of contractExtensions()) {
            const icon = iconFor(`sample.${extension}`, 'file');
            assert.notEqual(icon, 'file', `.${extension} falls back to the generic icon`);
        }
    });

    it('maps the contract languages to the expected icons', () => {
        const expected: Record<string, string> = {
            'main.py': 'python', 'app.rb': 'ruby', 'Main.java': 'java', 'lib.c': 'c', 'lib.h': 'h', 'lib.cpp': 'cpp', 'lib.hpp': 'hpp',
            'Prog.cs': 'csharp', 'server.erl': 'erlang', 'calc.f90': 'fortran', 'player.gd': 'godot', 'main.go': 'go', 'index.js': 'javascript',
            'Main.kt': 'kotlin', 'init.lua': 'lua', 'view.m': 'objective-c', 'view.mm': 'objective-cpp', 'index.php': 'php', 'tool.pl': 'perl',
            'App.scala': 'scala', 'Token.sol': 'solidity', 'App.swift': 'swift', 'app.ts': 'typescript', 'Button.tsx': 'react_ts',
            'suite.ttcn3': 'proto', 'App.vue': 'vue', 'build.zig': 'zig', 'index.html': 'html',
        };
        for (const [name, icon] of Object.entries(expected)) {
            assert.equal(iconFor(name, 'file'), icon, name);
        }
    });

    it('matches the whole file name before the extension, ignoring case', () => {
        assert.equal(iconFor('package.json', 'file'), 'nodejs');
        assert.equal(iconFor('data.json', 'file'), 'json');
        assert.equal(iconFor('Dockerfile', 'file'), 'docker');
        assert.equal(iconFor('README.md', 'file'), 'readme');
        assert.equal(iconFor('notes.md', 'file'), 'markdown');
        assert.equal(iconFor('LICENSE', 'file'), 'license');
        assert.equal(iconFor('.gitignore', 'file'), 'git');
        assert.equal(iconFor('requirements.txt', 'file'), 'python-misc');
        assert.equal(iconFor('tsconfig.node.json', 'file'), 'tsconfig');
        assert.equal(iconFor('MAIN.PY', 'file'), 'python');
    });

    it('prefers the longest known extension', () => {
        assert.equal(iconFor('api.d.ts', 'file'), 'typescript-def');
        assert.equal(iconFor('app.test.ts', 'file'), 'test-ts');
        assert.equal(iconFor('app.spec.js', 'file'), 'test-js');
        assert.equal(iconFor('my.module.ts', 'file'), 'typescript');
        assert.equal(iconFor('release.tar.gz', 'file'), 'zip');
    });

    it('treats a leading dot as part of the name, and falls back to the generic file icon', () => {
        assert.equal(iconFor('.bashrc', 'file'), 'file');
        assert.equal(iconFor('notes.xyz', 'file'), 'file');
        assert.equal(iconFor('Makefile.bak', 'file'), 'file');
        assert.equal(iconFor('noextension', 'file'), 'file');
        assert.equal(iconFor('trailingdot.', 'file'), 'file');
        assert.equal(iconFor('', 'file'), 'file');
    });

    it('gives folders an open and a closed icon, with special ones by name', () => {
        assert.equal(iconFor('anything', 'directory'), 'folder');
        assert.equal(iconFor('anything', 'directory', true), 'folder-open');
        assert.equal(iconFor('src', 'directory'), 'folder-src');
        assert.equal(iconFor('src', 'directory', true), 'folder-src-open');
        assert.equal(iconFor('Tests', 'directory'), 'folder-test');
        assert.equal(iconFor('.github', 'directory', true), 'folder-github-open');
        assert.equal(iconFor('node_modules', 'directory'), 'folder-node');
        // A folder named like a file is still a folder.
        assert.equal(iconFor('package.json', 'directory'), 'folder');
    });

    it('builds app-relative URLs only', () => {
        assert.equal(iconUrl('python'), './file-icons/python.svg');
    });
});

describe('fileIconStyleSheet', () => {
    const sheet = fileIconStyleSheet();

    it('has one rule per icon, pointing into the app bundle', () => {
        assert.ok(sheet.includes(`.${iconClass('python')} { background-image: url("./file-icons/python.svg"); }`));
        assert.ok(sheet.includes(`.${iconClass('folder-src-open')} { background-image: url("./file-icons/folder-src-open.svg"); }`));
        for (const url of sheet.matchAll(/url\("([^"]*)"\)/g)) {
            assert.match(url[1] ?? '', /^\.\/file-icons\/[a-z0-9_-]+\.svg$/);
        }
    });

    it('swaps the light variants in under the light theme only', () => {
        const [dark, light = ''] = sheet.split('@media (prefers-color-scheme: light)');
        assert.ok(dark?.includes('url("./file-icons/toml.svg")'));
        assert.ok(!dark?.includes('_light.svg'));
        assert.ok(light.includes(`.${iconClass('toml')} { background-image: url("./file-icons/toml_light.svg"); }`));
    });
});

describe('bundled icons', () => {
    it('ships exactly the icons the tables can return', () => {
        const onDisk = fs.readdirSync(ICON_DIR).filter((file) => file.endsWith('.svg')).map((file) => file.slice(0, -4)).sort();
        assert.deepEqual(onDisk, bundledIconNames(), 'run `node scripts/syncFileIcons.mjs` in apps/ide');
        for (const light of LIGHT_VARIANTS) {
            assert.ok(onDisk.includes(`${light}_light`), `${light}_light.svg is missing`);
        }
    });

    it('are unchanged copies of material-icon-theme', () => {
        const require = createRequire(import.meta.url);
        const source = path.join(path.dirname(require.resolve('material-icon-theme/package.json')), 'icons');
        for (const name of bundledIconNames()) {
            assert.ok(
                fs.readFileSync(path.join(ICON_DIR, `${name}.svg`)).equals(fs.readFileSync(path.join(source, `${name}.svg`))),
                `${name}.svg differs from the package: run \`node scripts/syncFileIcons.mjs\` in apps/ide`,
            );
        }
    });

    it('are plain SVG with nothing that could load or run', () => {
        for (const name of bundledIconNames()) {
            const svg = fs.readFileSync(path.join(ICON_DIR, `${name}.svg`), 'utf8');
            assert.match(svg, /^<svg[\s>]/, name);
            assert.doesNotMatch(svg, /<script|<foreignObject|href=|url\(\s*['"]?(?!#)|\bon[a-z]+=/i, name);
        }
    });
});
