import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    activationEventsOf, activationMatches, HOST_METHODS, MAIN_METHODS, RpcEndpoint,
    type HostActivationEvent, type HostInitData, type HostLogLine, type RpcMessage, type UiNotification, type UiRequest,
} from '../src/shared/extensionHostProtocol.ts';
import { isWorkbenchActivationEvent } from '../src/shared/extensions.ts';
import { ConfigurationModel, configurationDefaults } from '../src/extensionHost/configuration.ts';
import { matchGlob } from '../src/extensionHost/glob.ts';
import { inert, stubFor, withFallback } from '../src/extensionHost/inert.ts';
import { TextDocumentModel } from '../src/extensionHost/textDocument.ts';
import { DiagnosticSeverity, Position, Range, Selection, SnippetString, Uri, WorkspaceEdit } from '../src/extensionHost/types.ts';
import { fromWire, toWire } from '../src/extensionHost/wire.ts';
import { formatMessage } from '../src/extensionHost/api.ts';
import { ExtensionSettingsStore } from '../src/main/extensions/extensionSettings.ts';
import { builtinCommandFor, statusText } from '../src/renderer/extensions/hostBridgeModel.ts';
import { createCommandRegistry } from '../src/renderer/commands/commandRegistry.ts';

const HOST_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'extensionHost', 'index.ts');

let tmp = '';
before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-host-test-'));
});
after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('extension host protocol (#259)', () => {
    function pair(): [RpcEndpoint, RpcEndpoint] {
        let a: RpcEndpoint | null = null;
        let b: RpcEndpoint | null = null;
        // Asynchronous delivery, as over a real channel.
        a = new RpcEndpoint((message) => queueMicrotask(() => b?.receive(structuredClone(message))));
        b = new RpcEndpoint((message) => queueMicrotask(() => a?.receive(structuredClone(message))));
        return [a, b];
    }

    it('answers requests both ways, reports errors and unknown methods', async () => {
        const [main, host] = pair();
        host.handle('add', (x, y) => Number(x) + Number(y));
        host.handle('fail', () => {
            throw new Error('boom');
        });
        main.handle('echo', async (value) => value);
        assert.equal(await main.request('add', 2, 3), 5);
        await assert.rejects(main.request('fail'), /boom/);
        await assert.rejects(main.request('nope'), /Unknown method "nope"/);
        assert.deepEqual(await host.request('echo', { a: [1] }), { a: [1] });
        assert.equal(await host.request('echo', undefined), null, 'undefined travels as null');
    });

    it('delivers notifications and rejects what is pending on dispose', async () => {
        const [main, host] = pair();
        const seen: unknown[] = [];
        main.handle('log', (line) => seen.push(line));
        host.notify('log', 'hello');
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.deepEqual(seen, ['hello']);
        host.handle('slow', () => new Promise(() => undefined));
        const waiting = main.request('slow');
        main.dispose();
        await assert.rejects(waiting, /stopped/);
        await assert.rejects(main.request('slow'), /not running/);
        main.receive({ kind: 'nonsense' } as unknown as RpcMessage);
    });

    it('adds the implicit activation events and matches fired events', () => {
        const events = activationEventsOf(['onStartupFinished'], {
            commands: [{ command: 'acme.run', title: 'Run' }],
            views: { explorer: [{ id: 'acme.tree', name: 'Tree' }] },
            languages: [{ id: 'kit' }],
        });
        assert.deepEqual(events.sort(), ['onCommand:acme.run', 'onLanguage:kit', 'onStartupFinished', 'onView:acme.tree']);
        assert.equal(activationMatches(['*'], 'onLanguage:python'), true);
        assert.equal(activationMatches(['*'], 'onStartupFinished'), false, '* extensions are already active by then');
        assert.equal(activationMatches(['onLanguage'], 'onLanguage:python'), true);
        assert.equal(activationMatches(['onLanguage:go'], 'onLanguage:python'), false);
    });

    it('only lets the renderer fire workbench activation events', () => {
        assert.equal(isWorkbenchActivationEvent('onLanguage:python'), true);
        assert.equal(isWorkbenchActivationEvent('onView:acme.tree'), true);
        assert.equal(isWorkbenchActivationEvent('onUri'), true);
        assert.equal(isWorkbenchActivationEvent('*'), false);
        assert.equal(isWorkbenchActivationEvent('onCommand:acme.run'), false);
        assert.equal(isWorkbenchActivationEvent('workspaceContains:**/x'), false);
        assert.equal(isWorkbenchActivationEvent('onLanguage:a b'), false);
    });
});

describe('vscode API values (#259)', () => {
    it('keeps VS Code\'s enum numbers and reverse names', () => {
        assert.equal(DiagnosticSeverity.Error, 0);
        assert.equal(DiagnosticSeverity.Hint, 3);
        assert.equal(DiagnosticSeverity[1], 'Warning');
    });

    it('orders ranges, builds selections and snippets', () => {
        const range = new Range(3, 4, 1, 2);
        assert.deepEqual([range.start.line, range.end.line], [1, 3], 'start and end are swapped into order');
        assert.equal(range.contains(new Position(2, 0)), true);
        assert.equal(new Range(0, 0, 0, 5).intersection(new Range(0, 6, 0, 8)), undefined);
        const selection = new Selection(2, 0, 1, 0);
        assert.equal(selection.isReversed, true);
        assert.equal(new SnippetString().appendText('$x').appendPlaceholder('name').appendTabstop(0).value, '\\$x${1:name}$0');
        assert.equal(Uri.joinPath(Uri.file('/a/b'), 'c', 'd.txt').fsPath.replace(/\\/g, '/'), '/a/b/c/d.txt');
    });

    it('collects workspace edits by file', () => {
        const edit = new WorkspaceEdit();
        const uri = Uri.file('/w/a.txt');
        edit.insert(uri, new Position(0, 0), 'x');
        edit.delete(uri, new Range(1, 0, 1, 2));
        assert.equal(edit.size, 1);
        assert.equal(edit.entries()[0]?.[1].length, 2);
        assert.equal(edit.has(Uri.file('/w/b.txt')), false);
    });

    it('carries Uri, Position and Range across the process boundary and drops functions and cycles', () => {
        const cyclic: Record<string, unknown> = { name: 'x', run: () => 1 };
        cyclic['self'] = cyclic;
        const shared = { n: 1 };
        const wire = toWire({ uri: Uri.file('/w/a.ts'), at: new Position(1, 2), range: new Range(0, 0, 1, 1), cyclic, list: [shared, shared] });
        const back = fromWire(structuredClone(wire)) as Record<string, unknown>;
        assert.ok(back['uri'] instanceof Uri);
        assert.equal((back['uri'] as Uri).path, '/w/a.ts');
        assert.ok(back['at'] instanceof Position);
        assert.ok(back['range'] instanceof Range);
        assert.deepEqual(back['cyclic'], { name: 'x', self: null });
        assert.deepEqual(back['list'], [{ n: 1 }, { n: 1 }], 'the same object twice is not a cycle');
    });

    it('stands in for missing API without throwing', async () => {
        const reported: string[] = [];
        const ns = withFallback('window', { known: 1 }, (api) => reported.push(api)) as Record<string, unknown>;
        assert.equal(ns['known'], 1);
        const created = (ns['createWebviewPanel'] as () => Record<string, unknown>)();
        (created['webview'] as Record<string, unknown>)['html'] = '<b>x</b>';
        (created['onDidDispose'] as (listener: () => void) => { dispose(): void })(() => undefined).dispose();
        assert.equal(await (ns['showSomething'] as () => Promise<unknown>)(), undefined);
        assert.equal(typeof (ns['onDidChangeThing'] as () => { dispose(): void })().dispose, 'function');
        assert.deepEqual(reported, ['window.createWebviewPanel', 'window.showSomething', 'window.onDidChangeThing']);
        assert.equal(stubFor('mystery'), undefined);
        const value = inert();
        assert.equal(await Promise.resolve(value), value, 'an inert value is not a thenable: awaiting it does not hang');
    });

    it('formats l10n messages', () => {
        assert.equal(formatMessage('Hello {0}, {1}!', ['a', 2]), 'Hello a, 2!');
        assert.equal(formatMessage('Hi {name}', { name: 'Ada' }), 'Hi Ada');
        assert.equal(formatMessage('{0} {missing}', ['x']), 'x {missing}');
    });
});

describe('glob patterns (#259)', () => {
    it('matches VS Code globs', () => {
        assert.equal(matchGlob('**/*.ts', 'src/a/b.ts'), true);
        assert.equal(matchGlob('**/*.ts', 'b.ts'), true);
        assert.equal(matchGlob('*.ts', 'src/b.ts'), false);
        assert.equal(matchGlob('**/{package.json,tsconfig.json}', 'a/tsconfig.json'), true);
        assert.equal(matchGlob('src/[ab].js', 'src/b.js'), true);
        assert.equal(matchGlob('src/[!ab].js', 'src/b.js'), false);
        assert.equal(matchGlob('**/node_modules/**', 'x/node_modules/y/z.js'), true);
        assert.equal(matchGlob('a?.txt', 'ab.txt'), true);
        assert.equal(matchGlob('requirements.txt', 'requirements.txt'), true);
    });
});

describe('extension configuration (#259)', () => {
    const contributes = {
        configuration: [{
            properties: {
                'acme.enabled': { type: 'boolean', default: true },
                'acme.paths': { type: 'array' },
                'acme.format.indent': { type: 'number', default: 2 },
                'acme.format.style': { type: 'string', default: 'k&r' },
            },
        }],
        configurationDefaults: { 'acme.format.indent': 4 },
    };

    it('reads the defaults and the type-derived ones', () => {
        const defaults = configurationDefaults(contributes);
        assert.equal(defaults.get('acme.enabled'), true);
        assert.deepEqual(defaults.get('acme.paths'), []);
        assert.equal(defaults.get('acme.format.indent'), 4, 'configurationDefaults wins');
    });

    it('serves sections, user values, inspect and update', async () => {
        const updates: unknown[][] = [];
        const model = new ConfigurationModel(async (key, value, target) => {
            updates.push([key, value, target]);
        });
        model.setDefaults([contributes]);
        model.setUserValues({ 'acme.format.style': 'allman' });
        const acme = model.get('acme');
        assert.equal(acme.get('enabled'), true);
        assert.equal(acme.get('format.style'), 'allman');
        assert.deepEqual(acme.get('format'), { indent: 4, style: 'allman' });
        assert.equal(acme['enabled'], true, 'values are readable as properties too');
        assert.equal(acme.get('missing', 'fallback'), 'fallback');
        assert.equal(acme.has('format.indent'), true);
        assert.deepEqual(acme.inspect('format.style'), { key: 'acme.format.style', defaultValue: 'k&r', globalValue: 'allman' });
        assert.equal(model.get().get('acme.format.indent'), 4);
        await acme.update('enabled', false, true);
        assert.deepEqual(updates, [['acme.enabled', false, 'user']]);
        assert.equal(model.get('acme').get('enabled'), false);
        assert.deepEqual(model.setUserValues({ 'acme.enabled': false }), ['acme.format.style']);
        assert.equal(ConfigurationModel.affects('acme.format.style', 'acme'), true);
        assert.equal(ConfigurationModel.affects('acme.format.style', 'acme.format.style'), true);
        assert.equal(ConfigurationModel.affects('acme.format', 'acme.format.style'), true);
        assert.equal(ConfigurationModel.affects('other.x', 'acme'), false);
    });

    it('stores the extensions\' settings apart, comments allowed', () => {
        const file = path.join(tmp, 'ext-settings', 'settings.json');
        const store = new ExtensionSettingsStore(file);
        assert.deepEqual(store.values(), {});
        store.update('acme.list', [1, 2]);
        store.update('acme.flag', true);
        store.update('acme.flag', undefined);
        assert.deepEqual(store.values(), { 'acme.list': [1, 2] });
        fs.writeFileSync(file, '{\n  // edited by hand\n  "acme.list": [3],\n}\n');
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
        assert.deepEqual(new ExtensionSettingsStore(file).values(), { 'acme.list': [3] });
    });
});

describe('text documents (#259)', () => {
    it('maps offsets, lines and words, CRLF included', () => {
        const doc = new TextDocumentModel(Uri.file('/w/a.ts'), 'typescript', 1, 'const a = 1;\r\nlet bb = a + 2;\n\n');
        assert.equal(doc.lineCount, 4);
        assert.equal(doc.eol, 2);
        assert.equal(doc.lineAt(1).text, 'let bb = a + 2;');
        assert.equal(doc.lineAt(1).firstNonWhitespaceCharacterIndex, 0);
        assert.equal(doc.lineAt(2).isEmptyOrWhitespace, true);
        assert.deepEqual(doc.positionAt(16).toJSON(), { line: 1, character: 2 });
        assert.equal(doc.offsetAt(new Position(1, 4)), 18);
        assert.equal(doc.getText(new Range(1, 4, 1, 6)), 'bb');
        assert.equal(doc.getText(doc.getWordRangeAtPosition(new Position(1, 5))), 'bb');
        assert.deepEqual(doc.validatePosition(new Position(9, 9)).toJSON(), { line: 3, character: 0 });
        assert.throws(() => doc.lineAt(7), /Illegal value/);
        doc.applyChange(new Range(0, 6, 0, 7), 'alpha');
        assert.equal(doc.lineAt(0).text, 'const alpha = 1;');
    });
});

describe('workbench side of the host (#259)', () => {
    it('maps VS Code\'s commands onto the IDE\'s', () => {
        assert.deepEqual(builtinCommandFor('workbench.action.files.save', []), { kind: 'workbench', id: 'file.save' });
        assert.deepEqual(builtinCommandFor('workbench.extensions.search', ['@installed']), { kind: 'search-extensions', query: '@installed' });
        assert.deepEqual(builtinCommandFor('workbench.action.reloadWindow', []), { kind: 'reload' });
        assert.deepEqual(builtinCommandFor('terminal.new', []), { kind: 'workbench', id: 'terminal.new' });
    });

    it('drops codicon references from status texts', () => {
        assert.equal(statusText('$(sync~spin) Indexing  $(check)'), 'Indexing');
        assert.equal(statusText('Plain'), 'Plain');
    });

    it('accepts any extension command id, still unique', () => {
        const registry = createCommandRegistry();
        registry.register({ id: '_acme.internal_Thing', title: 'Thing', source: 'extension', run: () => undefined });
        assert.throws(() => registry.register({ id: '_acme.internal_Thing', title: 'Again', source: 'extension', run: () => undefined }), /Duplicate/);
        assert.throws(() => registry.register({ id: 'has space', title: 'Bad', source: 'extension', run: () => undefined }), /Invalid command ID/);
        assert.throws(() => registry.register({ id: '_acme.x', title: 'Not an extension', run: () => undefined }), /Invalid command ID/);
    });
});

/* ------------------------------ the host process ------------------------------ */

const EXTENSION_JS = String.raw`
const vscode = require('vscode');
const helper = require('./lib/helper.js');
exports.activate = async function activate(context) {
    const out = vscode.window.createOutputChannel('Demo');
    out.appendLine('activated in ' + vscode.env.appName);
    context.subscriptions.push(vscode.commands.registerCommand('demo.greet', async (name) => {
        const config = vscode.workspace.getConfiguration('demo');
        const answer = await vscode.window.showInformationMessage(helper.greeting(name, config.get('punctuation')), 'Yes', 'No');
        await context.globalState.update('lastAnswer', answer);
        return { answer, uri: vscode.Uri.file('/x/y.txt'), sameApi: require('vscode') === vscode };
    }));
    context.subscriptions.push(vscode.commands.registerCommand('demo.workbench', () => vscode.commands.executeCommand('workbench.action.files.save', 1)));
    context.subscriptions.push(vscode.commands.registerCommand('demo.missing', () => {
        const registration = vscode.window.registerCustomEditorProvider('demo.editor', {});
        return typeof registration.dispose;
    }));
    context.subscriptions.push(vscode.commands.registerCommand('demo.state', () => ({ last: context.globalState.get('lastAnswer'), storage: context.globalStorageUri.fsPath })));
    context.subscriptions.push(vscode.commands.registerCommand('demo.update', async () => {
        await vscode.workspace.getConfiguration('demo').update('punctuation', '?', vscode.ConfigurationTarget.Global);
        return vscode.workspace.getConfiguration('demo').get('punctuation');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('demo.files', async () => {
        const found = await vscode.workspace.findFiles('**/*.md');
        const doc = await vscode.workspace.openTextDocument(found[0]);
        return { count: found.length, language: doc.languageId, firstLine: doc.lineAt(0).text, rel: vscode.workspace.asRelativePath(found[0]) };
    }));
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
    item.text = '$(check) Demo';
    item.command = 'demo.greet';
    item.show();
    return { api: 42 };
};
exports.deactivate = function deactivate() {
    require('fs').writeFileSync(process.env.DEMO_DEACTIVATED, 'yes');
};
`;

const DEPENDENT_JS = String.raw`
const vscode = require('vscode');
exports.activate = function () {
    const demo = vscode.extensions.getExtension('acme.demo');
    vscode.commands.registerCommand('dep.check', () => ({ active: demo.isActive, exports: demo.exports }));
};
`;

const BROKEN_JS = 'exports.activate = () => { throw new Error("broken on purpose"); };';

function writeExtension(id: string, packageJSON: Record<string, unknown>, files: Record<string, string>): string {
    const folder = path.join(tmp, 'extensions', id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify(packageJSON));
    for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
        fs.writeFileSync(path.join(folder, name), content);
    }
    return folder;
}

describe('the extension host process (#259)', () => {
    let child: ChildProcess;
    let main: RpcEndpoint;
    const logs: HostLogLine[] = [];
    const activations: HostActivationEvent[] = [];
    const missing: string[] = [];
    const ui: UiRequest[] = [];
    const notifications: UiNotification[] = [];
    const workbenchCommands: unknown[][] = [];
    const configUpdates: unknown[][] = [];
    let deactivatedMarker = '';

    before(async () => {
        const workspace = path.join(tmp, 'workspace');
        fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'docs', 'readme.md'), '# Title\nbody\n');
        fs.mkdirSync(path.join(workspace, 'node_modules', 'x'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'node_modules', 'x', 'skip.md'), '# no');
        deactivatedMarker = path.join(tmp, 'deactivated.txt');
        const demoJson = {
            publisher: 'acme', name: 'demo', version: '1.0.0', main: './out/extension.js', engines: { vscode: '^1.80.0' },
            activationEvents: ['onStartupFinished'],
            contributes: {
                commands: [{ command: 'demo.greet', title: 'Greet' }],
                configuration: { properties: { 'demo.punctuation': { type: 'string', default: '!' } } },
            },
        };
        const demo = writeExtension('acme.demo-1.0.0', demoJson, { 'out/extension.js': EXTENSION_JS, 'out/lib/helper.js': 'exports.greeting = (name, p) => "Hello " + name + p;' });
        const depJson = { publisher: 'acme', name: 'dep', version: '1.0.0', main: 'index.js', engines: { vscode: '^1.80.0' }, activationEvents: ['onCommand:dep.check'], extensionDependencies: ['acme.demo'] };
        const dep = writeExtension('acme.dep-1.0.0', depJson, { 'index.js': DEPENDENT_JS });
        const brokenJson = { publisher: 'acme', name: 'broken', version: '1.0.0', main: 'index.js', engines: { vscode: '^1.80.0' }, activationEvents: ['onLanguage:markdown'] };
        const broken = writeExtension('acme.broken-1.0.0', brokenJson, { 'index.js': BROKEN_JS });

        child = fork(HOST_ENTRY, [], {
            execArgv: ['--experimental-strip-types', '--no-warnings'],
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            serialization: 'advanced',
            env: { ...process.env, DEMO_DEACTIVATED: deactivatedMarker },
        });
        child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[host stderr] ${chunk.toString()}`));
        main = new RpcEndpoint((message) => child.send(message));
        child.on('message', (message) => main.receive(message));
        main.handle(MAIN_METHODS.log, (line) => logs.push(line as HostLogLine));
        main.handle(MAIN_METHODS.activation, (event) => activations.push(event as HostActivationEvent));
        main.handle(MAIN_METHODS.notImplemented, (_id, api) => missing.push(String(api)));
        main.handle(MAIN_METHODS.ui, (request) => {
            ui.push(request as UiRequest);
            return (request as UiRequest).kind === 'message' ? 0 : null;
        });
        main.handle(MAIN_METHODS.uiNotify, (notification) => notifications.push(notification as UiNotification));
        main.handle(MAIN_METHODS.executeWorkbenchCommand, (id, args) => {
            workbenchCommands.push([id, args]);
            return 'saved';
        });
        main.handle(MAIN_METHODS.updateConfiguration, (key, value, target) => {
            configUpdates.push([key, value, target]);
        });
        const init: HostInitData = {
            extensions: [
                { id: 'acme.demo', location: demo, main: demoJson.main, packageJSON: demoJson, activationEvents: activationEventsOf(demoJson.activationEvents, demoJson.contributes), extensionDependencies: [] },
                { id: 'acme.dep', location: dep, main: depJson.main, packageJSON: depJson, activationEvents: depJson.activationEvents, extensionDependencies: ['acme.demo'] },
                { id: 'acme.broken', location: broken, main: brokenJson.main, packageJSON: brokenJson, activationEvents: brokenJson.activationEvents, extensionDependencies: [] },
            ],
            passive: [],
            workspaceFolder: workspace,
            trusted: true,
            configuration: {},
            globalStorageRoot: path.join(tmp, 'storage', 'global'),
            workspaceStorageRoot: path.join(tmp, 'storage', 'ws'),
            logRoot: path.join(tmp, 'logs'),
            env: { appName: 'Code-XR IDE', appRoot: tmp, appHost: 'desktop', language: 'en', machineId: 'm', sessionId: 's', uriScheme: 'codexr', shell: '/bin/sh', version: '0.0.0' },
            isDevelopment: false,
            documents: [],
            activeEditor: null,
        };
        await main.request(HOST_METHODS.init, init);
    });

    after(async () => {
        if (child.exitCode === null) {
            child.kill();
        }
    });

    it('activates on onStartupFinished, with its output channel and status bar item', async () => {
        await main.request(HOST_METHODS.activateByEvent, '*');
        assert.equal(activations.length, 0, 'nothing listens for *');
        await main.request(HOST_METHODS.activateByEvent, 'onStartupFinished');
        assert.deepEqual(activations.map((event) => `${event.id}:${event.state}`), ['acme.demo:activating', 'acme.demo:active']);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(logs.some((line) => line.channel === 'Demo' && line.message === 'activated in Code-XR IDE'));
        const item = notifications.find((notification) => notification.kind === 'statusBarItem');
        assert.ok(item && item.kind === 'statusBarItem');
        assert.equal(item.item.text, '$(check) Demo');
        assert.equal(item.item.alignment, 'right');
        assert.equal(item.item.command, 'demo.greet');
        assert.deepEqual(await main.request(HOST_METHODS.registeredCommands), ['demo.greet', 'demo.workbench', 'demo.missing', 'demo.state', 'demo.update', 'demo.files']);
    });

    it('runs a command for the workbench: a message with buttons, configuration, state, its own require', async () => {
        const result = await main.request<Record<string, unknown>>(HOST_METHODS.executeCommand, 'demo.greet', ['Ada']);
        assert.equal(result['answer'], 'Yes');
        assert.deepEqual(result['uri'], { $uri: 'file:///x/y.txt' });
        assert.equal(result['sameApi'], true, 'require("vscode") gives an extension the same object every time');
        const message = ui.find((request) => request.kind === 'message');
        assert.ok(message && message.kind === 'message');
        assert.equal(message.message, 'Hello Ada!');
        assert.deepEqual(message.items, ['Yes', 'No']);
        assert.equal(message.extensionId, 'acme.demo');
        const state = await main.request<Record<string, unknown>>(HOST_METHODS.executeCommand, 'demo.state', []);
        assert.equal(state['last'], 'Yes');
        // `Uri.fsPath` lower-cases a Windows drive letter, as VS Code's does.
        const expectedStorage = path.join(tmp, 'storage', 'global', 'acme.demo');
        assert.equal(process.platform === 'win32' ? String(state['storage']).toLowerCase() : state['storage'], process.platform === 'win32' ? expectedStorage.toLowerCase() : expectedStorage);
    });

    it('writes configuration through the main process and sees the change', async () => {
        assert.equal(await main.request(HOST_METHODS.executeCommand, 'demo.update', []), '?');
        assert.deepEqual(configUpdates, [['demo.punctuation', '?', 'user']]);
        main.notify(HOST_METHODS.configurationChanged, { 'demo.punctuation': '.' });
        await main.request(HOST_METHODS.executeCommand, 'demo.greet', ['Bo']);
        const last = ui.filter((request) => request.kind === 'message').at(-1);
        assert.equal(last?.kind === 'message' ? last.message : null, 'Hello Bo.');
    });

    it('sends unknown commands to the workbench, args on the wire', async () => {
        assert.equal(await main.request(HOST_METHODS.executeCommand, 'demo.workbench', []), 'saved');
        assert.deepEqual(workbenchCommands, [['workbench.action.files.save', [1]]]);
    });

    it('reports unimplemented API and keeps the extension running', async () => {
        assert.equal(await main.request(HOST_METHODS.executeCommand, 'demo.missing', []), 'function');
        assert.deepEqual(missing, ['window.registerCustomEditorProvider']);
    });

    it('finds and opens workspace files, skipping node_modules', async () => {
        const result = await main.request<Record<string, unknown>>(HOST_METHODS.executeCommand, 'demo.files', []);
        assert.deepEqual(result, { count: 1, language: 'markdown', firstLine: '# Title', rel: 'docs/readme.md' });
    });

    it('activates dependencies first, by command, and reports a failed activation', async () => {
        const check = await main.request<Record<string, unknown>>(HOST_METHODS.executeCommand, 'dep.check', []);
        assert.deepEqual(check, { active: true, exports: { api: 42 } });
        await main.request(HOST_METHODS.activateByEvent, 'onLanguage:markdown');
        const failed = activations.find((event) => event.id === 'acme.broken' && event.state === 'failed');
        assert.ok(failed);
        assert.match(failed.error ?? '', /broken on purpose/);
        await assert.rejects(main.request(HOST_METHODS.executeCommand, 'nobody.has.this', []), /not found/);
    });

    it('deactivates the extensions on shutdown and exits', async () => {
        const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
        await main.request(HOST_METHODS.shutdown);
        assert.equal(await exited, 0);
        assert.equal(fs.readFileSync(deactivatedMarker, 'utf8'), 'yes');
        const stateFile = path.join(tmp, 'storage', 'global', 'acme.demo', 'state.json');
        assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { lastAnswer: 'Yes' });
    });
});
