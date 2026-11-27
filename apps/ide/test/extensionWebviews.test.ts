import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { HOST_METHODS, MAIN_METHODS, RpcEndpoint, type HostInitData } from '../src/shared/extensionHostProtocol.ts';
import {
    commandUriAllowed, isWebviewId, parseCommandHref, parseWebviewHostEvent, parseWebviewWorkbenchEvent, WEBVIEW_BOOTSTRAP, webviewDocument, webviewOrigin, webviewResourcePath,
    webviewResourceUrl, type WebviewHostEvent, type WebviewOptionsData,
} from '../src/shared/extensionWebviewProtocol.ts';
import { webviewServer } from '../src/main/extensions/webviewRegistry.ts';
import { buildContentSecurityPolicy } from '../src/main/security.ts';

const HOST_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'extensionHost', 'index.ts');
const ID = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

let tmp = '';
before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-webviews-test-')));
});
after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

const WINDOWS = process.platform === 'win32';
/** An absolute path as `Uri.path` spells it (`/c:/a/b` on Windows). */
const uriPath = (file: string): string => (WINDOWS ? `/${file.replace(/\\/g, '/')}` : file);
const urlOf = (file: string): string => webviewResourceUrl(ID, uriPath(file));

const options = (roots: string[], extra: Partial<WebviewOptionsData> = {}): WebviewOptionsData => ({ enableScripts: true, enableForms: true, enableCommandUris: false, localResourceRoots: roots, ...extra });

describe('webview protocol (#261)', () => {
    it('gives every webview an origin of its own and maps resource URLs both ways', () => {
        assert.equal(webviewOrigin(ID), `codexr-webview://${ID}`);
        assert.ok(isWebviewId(ID));
        assert.ok(!isWebviewId('../etc') && !isWebviewId(ID.toUpperCase()) && !isWebviewId(`${ID}0`));
        const url = webviewResourceUrl(ID, '/home/me/my ext/media/a#1.js');
        assert.equal(url, `codexr-webview://${ID}/file/home/me/my%20ext/media/a%231.js`);
        assert.equal(webviewResourcePath(new URL(url).pathname, false), '/home/me/my ext/media/a#1.js');
        const windows = webviewResourceUrl(ID, '/c:/Users/me/a.css');
        assert.equal(webviewResourcePath(new URL(windows).pathname, true), 'c:/Users/me/a.css');
        assert.equal(webviewResourcePath('/file/server/share/a.css', true), null, 'no drive-less path on Windows');
        assert.equal(webviewResourcePath('/index.html', false), null);
        assert.equal(webviewResourcePath('/file/a%00b', false), null);
        assert.equal(webviewResourcePath('/file/%E0%A4%A', false), null);
    });

    it('checks what the workbench and the host send, field by field', () => {
        assert.deepEqual(parseWebviewWorkbenchEvent({ kind: 'message', id: ID, message: { a: 1 } }), { kind: 'message', id: ID, message: { a: 1 } });
        assert.equal(parseWebviewWorkbenchEvent({ kind: 'message', id: 'nope', message: 1 }), null);
        assert.equal(parseWebviewWorkbenchEvent({ kind: 'viewState', id: ID, visible: 'yes', active: true }), null);
        assert.equal(parseWebviewWorkbenchEvent({ kind: 'command', id: ID, command: 'x', args: 'no' }), null);
        assert.equal(parseWebviewWorkbenchEvent({ kind: 'evil', id: ID }), null);
        const create = { kind: 'create', id: ID, extensionId: 'a.b', viewType: 'cat', title: 'Cat', options: options(['/x']), panel: { preserveFocus: false, beside: true } };
        assert.deepEqual(parseWebviewHostEvent(create), create);
        assert.equal(parseWebviewHostEvent({ ...create, options: { ...options(['/x']), localResourceRoots: [1] } }), null);
        assert.equal(parseWebviewHostEvent({ ...create, panel: { beside: true } }), null);
        assert.equal(parseWebviewHostEvent({ kind: 'html', id: ID, html: 5 }), null);
        assert.equal(parseWebviewHostEvent({ kind: 'dispose', id: 'x' }), null);
    });

    it('lets a command: link run only what enableCommandUris allows', () => {
        assert.equal(commandUriAllowed({ enableCommandUris: false }, 'a.run'), false);
        assert.equal(commandUriAllowed({ enableCommandUris: true }, 'a.run'), true);
        assert.equal(commandUriAllowed({ enableCommandUris: ['a.run'] }, 'a.run'), true);
        assert.equal(commandUriAllowed({ enableCommandUris: ['a.run'] }, 'a.other'), false);
        assert.deepEqual(parseCommandHref('command:a.run'), { command: 'a.run', args: [] });
        assert.deepEqual(parseCommandHref(`command:a.run?${encodeURIComponent(JSON.stringify(['x', 2]))}`), { command: 'a.run', args: ['x', 2] });
        assert.deepEqual(parseCommandHref(`command:a.run?${encodeURIComponent('{"k":1}')}`), { command: 'a.run', args: [{ k: 1 }] });
        assert.equal(parseCommandHref('command:a.run?not-json'), null);
        assert.equal(parseCommandHref('https://example.com'), null);
    });

    it('puts the bootstrap before the extension markup, so before its own CSP', () => {
        const page = webviewDocument('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body></body></html>', 'N0NCE');
        assert.ok(page.indexOf('acquireVsCodeApi') < page.indexOf('Content-Security-Policy'));
        assert.ok(page.includes('<script nonce="N0NCE">'));
        assert.ok(webviewDocument('<!doctype html><p>hi</p>', 'n').startsWith('<!doctype html><style id="_defaultStyles">'));
        assert.ok(webviewDocument('<p>hi</p>', 'n').startsWith('<style id="_defaultStyles">'));
        assert.ok(webviewDocument('<p>hi</p>', 'n').includes('</style><script nonce="n">'));
        // The bootstrap is plain script text that compiles.
        assert.doesNotThrow(() => new vm.Script(WEBVIEW_BOOTSTRAP));
    });

    it('lets the workbench frame webviews and nothing else', () => {
        const csp = buildContentSecurityPolicy();
        assert.match(csp, /frame-src codexr-webview:(;|$)/);
        assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'(;|$)/);
    });
});

describe('webview resources (#261)', () => {
    it('serves the page and files inside localResourceRoots only, to the window that owns it', () => {
        const root = path.join(tmp, 'ext');
        fs.mkdirSync(path.join(root, 'media'), { recursive: true });
        fs.writeFileSync(path.join(root, 'media', 'a.js'), 'x');
        fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
        let linked = true;
        try {
            fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'media', 'link.txt'));
        } catch {
            linked = false; // Windows without the right to create links.
        }
        webviewServer.create(7, ID, options([root]));
        assert.equal(webviewServer.setHtml(8, ID, '<p>x</p>'), null, 'another window cannot write it');
        assert.equal(webviewServer.setHtml(7, ID, '<p>hello</p>'), 1);
        assert.deepEqual(webviewServer.resolve(`codexr-webview://${ID}/index.html?v=1`, WINDOWS), { kind: 'page', html: '<p>hello</p>' });
        const file = webviewServer.resolve(urlOf(path.join(root, 'media', 'a.js')), WINDOWS);
        assert.equal(file?.kind, 'file');
        assert.equal(file.kind === 'file' ? fs.realpathSync.native(file.file) : null, fs.realpathSync.native(path.join(root, 'media', 'a.js')));
        assert.equal(webviewServer.resolve(urlOf(path.join(tmp, 'secret.txt')), WINDOWS), null, 'outside the roots');
        assert.equal(webviewServer.resolve(`codexr-webview://${ID}/file${uriPath(root)}/media/%2E%2E/%2E%2E/secret.txt`, WINDOWS), null, 'no escape with encoded dots');
        if (linked) {
            assert.equal(webviewServer.resolve(urlOf(path.join(root, 'media', 'link.txt')), WINDOWS), null, 'a link out of the root is followed and refused');
        }
        assert.equal(webviewServer.resolve(urlOf(path.join(root, 'media')), WINDOWS), null, 'folders are not served');
        assert.equal(webviewServer.resolve(`codexr-webview://${OTHER}/index.html`, WINDOWS), null, 'unknown webview');
        assert.equal(webviewServer.resolve(`codexr://${ID}/index.html`, WINDOWS), null);
        assert.equal(webviewServer.options(8, ID), null);
        assert.ok(webviewServer.setOptions(7, ID, options([])));
        assert.equal(webviewServer.resolve(urlOf(path.join(root, 'media', 'a.js')), WINDOWS), null, 'no roots, no files');
        assert.deepEqual(webviewServer.disposeOwner(7), [ID]);
        assert.equal(webviewServer.resolve(`codexr-webview://${ID}/index.html`, WINDOWS), null);
    });
});

const WEBVIEW_JS = `
const vscode = require('vscode');
exports.activate = (context) => {
  let panel = null;
  context.subscriptions.push(vscode.commands.registerCommand('cat.open', () => {
    panel = vscode.window.createWebviewPanel('catCoding', 'Cat Coding', vscode.ViewColumn.Beside, { enableScripts: true, enableCommandUris: ['cat.open'] });
    const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'cat.js');
    panel.webview.html = '<html><head></head><body><script src="' + panel.webview.asWebviewUri(media) + '"></script></body></html>';
    panel.webview.onDidReceiveMessage((message) => { panel.webview.postMessage({ echo: message, uri: vscode.Uri.file('/tmp/x') }); });
    panel.onDidChangeViewState((e) => { states.push([e.webviewPanel.visible, e.webviewPanel.active]); });
    panel.onDidDispose(() => { disposed += 1; });
    return { id: panel.webview.cspSource };
  }));
  context.subscriptions.push(vscode.commands.registerCommand('cat.title', () => { panel.title = 'Renamed'; }));
  context.subscriptions.push(vscode.commands.registerCommand('cat.state', () => ({ states, disposed })));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('cat.view', {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: false };
      view.webview.html = '<p>side</p>';
      view.title = 'Side cat';
    },
  }));
};
const states = [];
let disposed = 0;
`;

describe('webviews in the extension host (#261)', () => {
    let child: ChildProcess;
    let main: RpcEndpoint;
    let extensionFolder = '';
    const events: WebviewHostEvent[] = [];

    const waitFor = async <T>(probe: () => T | undefined, what: string): Promise<T> => {
        for (let attempt = 0; attempt < 300; attempt++) {
            const value = probe();
            if (value !== undefined) {
                return value;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out waiting for ${what}`);
    };

    before(async () => {
        extensionFolder = path.join(tmp, 'extensions', 'acme.cat-1.0.0');
        fs.mkdirSync(path.join(extensionFolder, 'media'), { recursive: true });
        const packageJSON = {
            publisher: 'acme', name: 'cat', version: '1.0.0', main: 'index.js', engines: { vscode: '^1.80.0' },
            contributes: { commands: [{ command: 'cat.open', title: 'Open' }], views: { explorer: [{ id: 'cat.view', name: 'Cat', type: 'webview' }] } },
        };
        fs.writeFileSync(path.join(extensionFolder, 'package.json'), JSON.stringify(packageJSON));
        fs.writeFileSync(path.join(extensionFolder, 'index.js'), WEBVIEW_JS);
        child = fork(HOST_ENTRY, [], { execArgv: ['--experimental-strip-types', '--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
        child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[host stderr] ${chunk.toString()}`));
        main = new RpcEndpoint((message) => child.send(message));
        child.on('message', (message) => main.receive(message));
        main.handle(MAIN_METHODS.log, () => undefined);
        main.handle(MAIN_METHODS.activation, () => undefined);
        main.handle(MAIN_METHODS.notImplemented, () => undefined);
        main.handle(MAIN_METHODS.uiNotify, () => undefined);
        main.handle(MAIN_METHODS.ui, () => null);
        main.handle(MAIN_METHODS.webview, (event) => {
            events.push(event as WebviewHostEvent);
        });
        const workspace = path.join(tmp, 'cat-ws');
        fs.mkdirSync(workspace, { recursive: true });
        const init: HostInitData = {
            extensions: [{ id: 'acme.cat', location: extensionFolder, main: 'index.js', packageJSON, activationEvents: ['onCommand:cat.open', 'onView:cat.view'], extensionDependencies: [] }],
            passive: [],
            workspaceFolder: workspace,
            trusted: true,
            configuration: {},
            globalStorageRoot: path.join(tmp, 'cat-storage'),
            workspaceStorageRoot: null,
            logRoot: path.join(tmp, 'cat-logs'),
            env: { appName: 'Code-XR IDE', appRoot: tmp, appHost: 'desktop', language: 'en', machineId: 'm', sessionId: 's', uriScheme: 'codexr', shell: '/bin/sh', version: '0.0.0' },
            isDevelopment: false,
            documents: [],
            activeEditor: null,
        };
        await main.request(HOST_METHODS.init, init);
    });

    after(() => {
        if (child.exitCode === null) {
            child.kill();
        }
    });

    it('creates a panel: its options, its HTML with asWebviewUri, and the events pass the main process checks', async () => {
        const result = await main.request(HOST_METHODS.executeCommand, 'cat.open', []) as { id: string };
        const create = await waitFor(() => events.find((event) => event.kind === 'create'), 'create');
        assert.ok(create.kind === 'create');
        assert.equal(result.id, webviewOrigin(create.id), 'cspSource is the webview origin');
        assert.ok(isWebviewId(create.id));
        assert.equal(create.viewType, 'catCoding');
        assert.deepEqual(create.panel, { preserveFocus: false, beside: true });
        assert.deepEqual(create.options, { enableScripts: true, enableForms: true, enableCommandUris: ['cat.open'], localResourceRoots: [extensionFolder, path.join(tmp, 'cat-ws')] });
        const html = await waitFor(() => events.find((event) => event.kind === 'html'), 'html');
        assert.ok(html.kind === 'html');
        assert.match(html.html, new RegExp(`src="codexr-webview://${create.id}/file/[^"]*/media/cat\\.js"`));
        for (const event of events) {
            assert.deepEqual(parseWebviewHostEvent(event), event, `${event.kind} passes the main process check`);
        }
    });

    it('carries messages both ways, as structured clones with Uris tagged', async () => {
        const create = events.find((event) => event.kind === 'create');
        assert.ok(create);
        await main.request(HOST_METHODS.webview, { kind: 'message', id: create.id, message: { hello: 'cat' } });
        const post = await waitFor(() => events.find((event) => event.kind === 'post'), 'post');
        assert.ok(post.kind === 'post');
        assert.deepEqual(post.message, { echo: { hello: 'cat' }, uri: { $uri: 'file:///tmp/x' } });
    });

    it('reports visibility, titles and the person closing the tab', async () => {
        const create = events.find((event) => event.kind === 'create');
        assert.ok(create);
        await main.request(HOST_METHODS.webview, { kind: 'viewState', id: create.id, visible: false, active: false });
        await main.request(HOST_METHODS.executeCommand, 'cat.title', []);
        const title = await waitFor(() => events.find((event) => event.kind === 'title'), 'title');
        assert.deepEqual(title, { kind: 'title', id: create.id, title: 'Renamed' });
        await main.request(HOST_METHODS.webview, { kind: 'closed', id: create.id });
        const state = await main.request(HOST_METHODS.executeCommand, 'cat.state', []);
        assert.deepEqual(state, { states: [[false, false]], disposed: 1 });
        const before = events.length;
        await main.request(HOST_METHODS.executeCommand, 'cat.title', []);
        assert.equal(events.length, before, 'a disposed panel sends nothing');
    });

    it('fills a webview view when the workbench first shows it, once', async () => {
        const id = await main.request(HOST_METHODS.webview, { kind: 'resolveView', viewId: 'cat.view' }) as string;
        assert.ok(isWebviewId(id));
        const create = events.find((event) => event.kind === 'create' && event.id === id);
        assert.ok(create?.kind === 'create');
        assert.equal(create.viewId, 'cat.view');
        assert.equal(create.panel, null);
        const options = events.find((event) => event.kind === 'options' && event.id === id);
        assert.ok(options?.kind === 'options');
        assert.equal(options.options.enableScripts, false);
        assert.ok(events.some((event) => event.kind === 'html' && event.id === id && event.html === '<p>side</p>'));
        assert.equal(await main.request(HOST_METHODS.webview, { kind: 'resolveView', viewId: 'cat.view' }), id, 'the same webview the second time');
        assert.equal(await main.request(HOST_METHODS.webview, { kind: 'resolveView', viewId: 'nobody.view' }), null);
    });
});
