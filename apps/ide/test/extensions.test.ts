import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, engineSupported, isSafeRelativePath, localizeManifest, ManifestError, parseManifest, summarizeContributions } from '../src/main/extensions/manifest.ts';
import { extractVsix, isSymlinkEntry, readVsixManifest, vsixEntryPath, VsixError } from '../src/main/extensions/vsix.ts';
import { ExtensionStore, manifestFromText, resolveInExtension } from '../src/main/extensions/extensionStore.ts';
import { ContributionIndex, parseSnippets, readTmTheme } from '../src/main/extensions/contributions.ts';
import { parsePlist } from '../src/main/extensions/plist.ts';
import { GalleryError, normalizeGalleryUrl, OpenVsxClient, splitExtensionId, targetPlatform, type FetchLike } from '../src/main/extensions/openVsx.ts';
import { extensionIdOf, isExtensionId } from '../src/shared/extensions.ts';
import { vsix, zip } from './helpers/zip.ts';

const BASE = { publisher: 'acme', name: 'demo', version: '1.2.3', engines: { vscode: '^1.80.0' } };

let tmp = '';
before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ext-test-'));
});
after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

function writeVsix(name: string, data: Buffer): string {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, data);
    return file;
}

describe('extension ids (#254)', () => {
    it('are publisher.name in lower case', () => {
        assert.equal(extensionIdOf('Acme', 'Demo'), 'acme.demo');
        assert.equal(isExtensionId('acme.demo-x'), true);
        assert.equal(isExtensionId('ms-python.python'), true);
        assert.equal(isExtensionId('acme'), false);
        assert.equal(isExtensionId('../x.y'), false);
        assert.equal(isExtensionId(3), false);
        assert.deepEqual(splitExtensionId('redhat.vscode-yaml'), { namespace: 'redhat', name: 'vscode-yaml' });
    });
});

describe('extension manifest (#254)', () => {
    it('reads the fields the IDE uses', () => {
        const manifest = parseManifest({ ...BASE, displayName: 'Demo', main: './out/extension.js', icon: 'icon.png', repository: { url: 'git+https://github.com/acme/demo.git' }, capabilities: { untrustedWorkspaces: { supported: 'limited' } } });
        assert.equal(manifest.id, 'acme.demo');
        assert.equal(manifest.displayName, 'Demo');
        assert.equal(manifest.main, './out/extension.js');
        assert.equal(manifest.repository, 'https://github.com/acme/demo');
        assert.equal(manifest.supportsUntrusted, true);
    });

    it('refuses what is not a VS Code extension or points outside it', () => {
        assert.throws(() => parseManifest({ ...BASE, engines: {} }), ManifestError);
        assert.throws(() => parseManifest({ ...BASE, publisher: '' }), ManifestError);
        assert.throws(() => parseManifest({ ...BASE, version: 'one' }), ManifestError);
        assert.throws(() => parseManifest({ ...BASE, main: '../../evil.js' }), ManifestError);
        assert.throws(() => parseManifest({ ...BASE, icon: '/etc/passwd' }), ManifestError);
        assert.throws(() => parseManifest({ ...BASE, main: 'C:\\evil.js' }), ManifestError);
    });

    it('localises %placeholders% from package.nls.json', () => {
        const localized = localizeManifest({ displayName: '%name%', contributes: { commands: [{ title: '%cmd%' }] }, other: '%missing%' }, { name: 'Nice', cmd: { message: 'Run it', comment: [] } });
        assert.deepEqual(localized, { displayName: 'Nice', contributes: { commands: [{ title: 'Run it' }] }, other: '%missing%' });
    });

    it('summarises contributions', () => {
        const summary = summarizeContributions(parseManifest({ ...BASE, contributes: {
            themes: [{ label: 'Dark Demo', path: './t.json' }],
            languages: [{ id: 'demo' }],
            grammars: [{ scopeName: 'source.demo', path: 'g.json' }],
            commands: [{ command: 'demo.run', title: 'Run' }],
            views: { explorer: [{ id: 'demo.view', name: 'Demo View' }] },
            configuration: { properties: { 'demo.a': {}, 'demo.b': {} } },
        } }));
        assert.deepEqual(summary.themes, ['Dark Demo']);
        assert.deepEqual(summary.languages, ['demo']);
        assert.equal(summary.grammars, 1);
        assert.deepEqual(summary.commands, ['Run']);
        assert.deepEqual(summary.views, ['Demo View']);
        assert.equal(summary.settings, 2);
    });

    it('compares versions and engines', () => {
        assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
        assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
        assert.equal(engineSupported('^1.80.0', '1.95.0'), true);
        assert.equal(engineSupported('^1.99.0', '1.95.0'), false);
        assert.equal(engineSupported('*', '1.0.0'), true);
        assert.equal(engineSupported('>=1.x', '1.0.0'), true);
    });

    it('accepts only relative paths inside the extension', () => {
        assert.equal(isSafeRelativePath('out/a.js'), true);
        assert.equal(isSafeRelativePath('a/../../b'), false);
        assert.equal(isSafeRelativePath('/a'), false);
        assert.equal(isSafeRelativePath('a\0b'), false);
    });
});

describe('VSIX reading (#254)', () => {
    it('maps entries under extension/ and refuses unsafe ones', () => {
        assert.equal(vsixEntryPath('extension/package.json'), 'package.json');
        assert.equal(vsixEntryPath('extension.vsixmanifest'), null);
        assert.equal(vsixEntryPath('extension/'), '');
        assert.throws(() => vsixEntryPath('extension/../evil'), VsixError);
        assert.throws(() => vsixEntryPath('extension//etc/passwd'), VsixError);
        assert.throws(() => vsixEntryPath('extension/a\\..\\b'), VsixError);
        assert.throws(() => vsixEntryPath('../outside'), VsixError);
        assert.equal(isSymlinkEntry((0o120777 << 16) >>> 0), true);
        assert.equal(isSymlinkEntry((0o100644 << 16) >>> 0), false);
    });

    it('reads the manifest and unpacks the extension folder', async () => {
        const file = writeVsix('ok.vsix', vsix({ ...BASE, displayName: '%n%' }, { 'package.nls.json': '{"n":"Localised"}', 'out/extension.js': 'exports.activate = () => {};' }));
        const preview = await readVsixManifest(file);
        assert.equal(manifestFromText(preview.packageJson, preview.nlsJson).displayName, 'Localised');
        const target = path.join(tmp, 'unpacked');
        await extractVsix(file, target);
        assert.equal(fs.readFileSync(path.join(target, 'out', 'extension.js'), 'utf8'), 'exports.activate = () => {};');
        assert.equal(fs.existsSync(path.join(target, '[Content_Types].xml')), false);
    });

    it('refuses a zip-slip entry, a symbolic link and garbage, and leaves nothing behind', async () => {
        const slip = writeVsix('slip.vsix', zip([{ name: 'extension/package.json', data: JSON.stringify(BASE) }, { name: 'extension/../../evil.txt', data: 'x' }]));
        await assert.rejects(extractVsix(slip, path.join(tmp, 'slip')), /Unsafe path|invalid relative path|absolute path/);
        const link = writeVsix('link.vsix', zip([{ name: 'extension/package.json', data: JSON.stringify(BASE) }, { name: 'extension/link', data: '/etc/passwd', mode: 0o120777 }]));
        await assert.rejects(extractVsix(link, path.join(tmp, 'link')), /symbolic link/);
        assert.equal(fs.readdirSync(tmp).some((name) => name.includes('.partial-')), false);
        const garbage = writeVsix('garbage.vsix', Buffer.from('not a zip'));
        await assert.rejects(readVsixManifest(garbage), VsixError);
        const noManifest = writeVsix('none.vsix', zip([{ name: 'extension/readme.md', data: 'x' }]));
        await assert.rejects(readVsixManifest(noManifest), /no extension\/package.json/);
    });
});

describe('extension store (#254, #263)', () => {
    it('installs, updates, disables and uninstalls', async () => {
        const root = path.join(tmp, 'store');
        const store = new ExtensionStore(root);
        const v1 = writeVsix('v1.vsix', vsix(BASE, { 'README.md': '# Demo' }));
        const first = await store.install(v1, 'vsix');
        assert.equal(first.extension.manifest.id, 'acme.demo');
        assert.equal(first.replaced, null);
        assert.equal(store.list().length, 1);
        assert.equal(store.isNewer('acme.demo', '1.2.4'), true);
        assert.equal(store.isNewer('acme.demo', '1.2.3'), false);

        const v2 = writeVsix('v2.vsix', vsix({ ...BASE, version: '1.3.0' }));
        const second = await store.install(v2, 'open-vsx');
        assert.equal(second.replaced, '1.2.3');
        assert.equal(fs.existsSync(path.join(root, 'acme.demo-1.2.3')), false, 'the old version folder is removed');
        assert.equal(store.get('ACME.demo')?.manifest.version, '1.3.0');

        store.setEnabled('acme.demo', false);
        // A new store reads the same file: the state survives a restart.
        assert.equal(new ExtensionStore(root).get('acme.demo')?.enabled, false);
        store.setEnabled('acme.demo', true);
        assert.equal(store.get('acme.demo')?.enabled, true);
        store.disableAll();
        assert.equal(store.get('acme.demo')?.enabled, false);

        assert.equal(await store.uninstall('acme.demo'), true);
        assert.equal(store.list().length, 0);
        assert.equal(fs.existsSync(path.join(root, 'acme.demo-1.3.0')), false);
        assert.equal(await store.uninstall('acme.demo'), false);
    });

    it('ignores a tampered record that points outside the store', () => {
        const root = path.join(tmp, 'tampered');
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'extensions.json'), JSON.stringify({ version: 1, installed: { 'acme.demo': { version: '1.0.0', folder: '../../etc', source: 'vsix' } }, disabled: [] }));
        assert.equal(new ExtensionStore(root).list().length, 0);
    });

    it('resolves files only inside the extension', () => {
        const location = path.join(tmp, 'resolve');
        fs.mkdirSync(location, { recursive: true });
        assert.equal(resolveInExtension(location, './themes/a.json'), path.join(location, 'themes', 'a.json'));
        assert.equal(resolveInExtension(location, '../a.json'), null);
        assert.equal(resolveInExtension(location, '/etc/passwd'), null);
    });
});

describe('declarative contributions (#257, #258)', () => {
    it('resolves themes with include chains and .tmTheme files, languages, grammars and snippets', async () => {
        const store = new ExtensionStore(path.join(tmp, 'contrib'));
        const file = writeVsix('contrib.vsix', vsix({
            ...BASE,
            name: 'kit',
            contributes: {
                themes: [{ label: 'Kit Dark', uiTheme: 'vs-dark', path: './themes/dark.json' }, { label: 'Kit Classic', uiTheme: 'vs', path: './themes/classic.json' }, { label: 'Missing', path: './nope.json' }],
                languages: [{ id: 'kit', extensions: ['.kit'], aliases: ['Kit'], configuration: './kit.language-configuration.json' }],
                grammars: [{ language: 'kit', scopeName: 'source.kit', path: './syntaxes/kit.tmLanguage.json' }, { scopeName: 'evil', path: '../../escape.json' }],
                snippets: [{ language: 'kit', path: './snippets.json' }],
            },
        }, {
            'themes/base.json': '{ "colors": { "editor.background": "#111111", "foreground": "#eeeeee" }, "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#888888" } }] }',
            // JSON with comments and an include: the including file wins.
            'themes/dark.json': '{ // dark\n "include": "./base.json", "colors": { "editor.background": "#222222", }, "tokenColors": [{ "scope": "keyword, storage", "settings": { "foreground": "#ff0000", "fontStyle": "bold" } }] }',
            'themes/classic.json': '{ "tokenColors": "./classic.tmTheme" }',
            'themes/classic.tmTheme': '<?xml version="1.0"?><plist version="1.0"><dict><key>settings</key><array><dict><key>settings</key><dict><key>background</key><string>#FFFFFF</string><key>foreground</key><string>#000000</string></dict></dict><dict><key>scope</key><string>string</string><key>settings</key><dict><key>foreground</key><string>#00AA00</string></dict></dict></array></dict></plist>',
            'kit.language-configuration.json': '{ "comments": { "lineComment": "#" }, /* c */ "brackets": [["(", ")"]] }',
            'syntaxes/kit.tmLanguage.json': '{ "scopeName": "source.kit", "patterns": [] }',
            'snippets.json': '{ "Hello": { "prefix": ["hi", "hello"], "body": ["print(\\"$1\\")", "$0"], "description": "Say hi" } }',
        }));
        const installed = await store.install(file, 'vsix');
        const warnings: string[] = [];
        const index = new ContributionIndex([installed.extension], (message) => warnings.push(message));
        const { themes, languages, grammars, snippets } = index.contributions;
        assert.deepEqual(themes.map((theme) => theme.id), ['ext:acme.kit/Kit Dark', 'ext:acme.kit/Kit Classic']);
        assert.equal(warnings.length, 2, 'the missing theme and the escaping grammar are reported');

        const dark = index.theme('ext:acme.kit/Kit Dark');
        assert.equal(dark?.colors['editor.background'], '#222222');
        assert.equal(dark?.colors.foreground, '#eeeeee');
        assert.deepEqual(dark?.tokenColors.map((rule) => rule.scope), [['comment'], ['keyword', 'storage']]);

        const classic = index.theme('ext:acme.kit/Kit Classic');
        assert.equal(classic?.uiTheme, 'vs');
        assert.equal(classic?.colors['editor.background'], '#FFFFFF');
        assert.deepEqual(classic?.tokenColors, [{ scope: ['string'], foreground: '#00AA00' }]);
        assert.equal(index.theme('ext:acme.kit/Missing'), null);

        assert.equal(languages[0]?.id, 'kit');
        assert.deepEqual(languages[0]?.configuration, { comments: { lineComment: '#' }, brackets: [['(', ')']] });
        assert.equal(grammars.length, 1);
        assert.equal(index.grammarContent(grammars[0]?.ref ?? '')?.format, 'json');
        assert.equal(index.grammarContent('acme.kit#99'), null);
        assert.deepEqual(snippets.map((s) => [s.language, s.prefixes, s.body]), [['kit', ['hi', 'hello'], 'print("$1")\n$0']]);
    });

    it('reads snippets scoped by language and .tmTheme global colours', () => {
        assert.deepEqual(parseSnippets({ A: { prefix: 'a', body: 'x', scope: 'javascript,typescript' }, Bad: { body: 'no prefix' } }, 'e', null).map((s) => s.language), ['javascript', 'typescript']);
        const tm = readTmTheme('<plist><dict><key>settings</key><array><dict><key>settings</key><dict><key>caret</key><string>#ff0000</string></dict></dict></array></dict></plist>');
        assert.deepEqual(tm.colors, { 'editorCursor.foreground': '#ff0000' });
        assert.deepEqual(parsePlist('<plist><dict><key>a</key><integer>3</integer><key>b</key><true/><key>c</key><string>x &amp; y</string></dict></plist>'), { a: 3, b: true, c: 'x & y' });
    });
});

/** A fake Open VSX that answers from a table of URLs. */
function fakeRegistry(routes: Record<string, unknown>): { fetch: FetchLike; calls: string[] } {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
        calls.push(url);
        const key = Object.keys(routes).find((route) => url === route || url.startsWith(`${route}?`));
        if (!key) {
            return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
        }
        const body = routes[key];
        const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        return {
            ok: true,
            status: 200,
            headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (Buffer.isBuffer(body) ? 'image/png' : 'application/json') : null) },
            json: async () => JSON.parse(bytes.toString('utf8')) as unknown,
            text: async () => bytes.toString('utf8'),
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer,
        };
    };
    return { fetch, calls };
}

describe('Open VSX client (#254)', () => {
    const R = 'https://registry.test';

    it('accepts https registries, or http on this machine', () => {
        assert.equal(normalizeGalleryUrl('https://open-vsx.org/'), 'https://open-vsx.org');
        assert.equal(normalizeGalleryUrl('http://localhost:3000'), 'http://localhost:3000');
        assert.equal(normalizeGalleryUrl('http://evil.example'), null);
        assert.equal(normalizeGalleryUrl('https://user:pw@open-vsx.org'), null);
        assert.equal(normalizeGalleryUrl('file:///etc'), null);
        assert.equal(targetPlatform('linux', 'x64'), 'linux-x64');
        assert.equal(targetPlatform('darwin', 'arm64'), 'darwin-arm64');
        assert.equal(targetPlatform('win32', 'arm'), 'universal');
    });

    it('searches and parses results, skipping malformed entries', async () => {
        const { fetch, calls } = fakeRegistry({
            [`${R}/api/-/search`]: { offset: 0, totalSize: 2, extensions: [{ namespace: 'dracula-theme', name: 'theme-dracula', version: '2.25.1', displayName: 'Dracula', downloadCount: 1000, verified: true, files: { icon: 'https://cdn.test/icon.png' } }, { namespace: '../x', name: 'y' }] },
        });
        const client = new OpenVsxClient(R, fetch, 'linux-x64');
        const result = await client.search({ text: 'dracula', sortBy: 'downloadCount', size: 500 });
        assert.equal(result.extensions.length, 1);
        assert.equal(result.extensions[0]?.id, 'dracula-theme.theme-dracula');
        assert.equal(result.extensions[0]?.verified, true);
        const query = new URL(calls[0] ?? '').searchParams;
        assert.equal(query.get('query'), 'dracula');
        assert.equal(query.get('size'), '50', 'the page size is capped');
        assert.equal(query.get('sortBy'), 'downloadCount');
    });

    it('downloads a platform build when there is one and checks the SHA-256', async () => {
        const archive = vsix(BASE);
        const sha = createHash('sha256').update(archive).digest('hex');
        const { fetch, calls } = fakeRegistry({
            [`${R}/api/acme/demo/linux-x64`]: { namespace: 'acme', name: 'demo', version: '1.2.3', verified: false, files: { download: 'https://cdn.test/demo.vsix', sha256: 'https://cdn.test/demo.sha256' } },
            'https://cdn.test/demo.vsix': archive,
            'https://cdn.test/demo.sha256': `${sha}  demo.vsix\n`,
        });
        const download = await new OpenVsxClient(R, fetch, 'linux-x64').download('acme.demo');
        assert.equal(download.sha256, sha);
        assert.equal(download.version, '1.2.3');
        assert.ok(calls.includes(`${R}/api/acme/demo/linux-x64`));
    });

    it('falls back to the universal build and refuses a wrong or missing checksum', async () => {
        const archive = vsix(BASE);
        const universal = { namespace: 'acme', name: 'demo', version: '1.2.3', files: { download: 'https://cdn.test/demo.vsix', sha256: 'https://cdn.test/bad.sha256' } };
        const bad = fakeRegistry({ [`${R}/api/acme/demo`]: universal, 'https://cdn.test/demo.vsix': archive, 'https://cdn.test/bad.sha256': '0'.repeat(64) });
        await assert.rejects(new OpenVsxClient(R, bad.fetch, 'linux-x64').download('acme.demo'), /does not match/);
        const none = fakeRegistry({ [`${R}/api/acme/demo`]: { ...universal, files: { download: 'https://cdn.test/demo.vsix' } } });
        await assert.rejects(new OpenVsxClient(R, none.fetch, 'universal').download('acme.demo'), /no SHA-256/);
        const insecure = fakeRegistry({ [`${R}/api/acme/demo`]: { ...universal, files: { download: 'http://cdn.test/demo.vsix', sha256: 'https://cdn.test/x' } } });
        await assert.rejects(new OpenVsxClient(R, insecure.fetch, 'universal').download('acme.demo'), GalleryError);
    });

    it('reads details with the README and the versions newest first', async () => {
        const { fetch } = fakeRegistry({
            [`${R}/api/acme/demo`]: { namespace: 'acme', name: 'demo', version: '1.10.0', license: 'MIT', repository: 'https://github.com/acme/demo.git', allVersions: { latest: 'x', '1.2.0': 'x', '1.10.0': 'x', '1.9.0': 'x' }, files: { readme: 'https://cdn.test/README.md' }, engines: { vscode: '^1.80.0' } },
            'https://cdn.test/README.md': '# Demo',
        });
        const details = await new OpenVsxClient(R, fetch, 'universal').details('acme.demo');
        assert.deepEqual(details.versions, ['1.10.0', '1.9.0', '1.2.0']);
        assert.equal(details.readme, '# Demo');
        assert.equal(details.repository, 'https://github.com/acme/demo');
        assert.equal(details.engine, '^1.80.0');
    });

    it('turns icons into data URLs and refuses other content', async () => {
        const { fetch } = fakeRegistry({ 'https://cdn.test/icon.png': Buffer.from([0x89, 0x50]) });
        const client = new OpenVsxClient(R, fetch, 'universal');
        assert.equal(await client.icon('https://cdn.test/icon.png'), 'data:image/png;base64,iVA=');
        assert.equal(await client.icon('http://cdn.test/icon.png'), null);
        assert.equal(await client.icon('https://cdn.test/missing.png'), null);
    });
});
