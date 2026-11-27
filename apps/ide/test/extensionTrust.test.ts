import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_METHODS, MAIN_METHODS, RpcEndpoint, type HostInitData } from '../src/shared/extensionHostProtocol.ts';
import { parseManifest } from '../src/main/extensions/manifest.ts';
import { extensionRunState, mayRunCode } from '../src/main/extensions/runState.ts';

const HOST_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'extensionHost', 'index.ts');

describe('extensions and workspace trust (#263)', () => {
    const base = { enabled: true, disabledByFlag: false, hasCode: true, supportsUntrusted: false, trusted: true };

    it('keeps extensions with code off in Restricted Mode unless they declare support', () => {
        assert.equal(extensionRunState(base), 'enabled');
        assert.equal(extensionRunState({ ...base, trusted: false }), 'restricted');
        assert.equal(extensionRunState({ ...base, trusted: false, supportsUntrusted: true }), 'enabled');
        assert.equal(extensionRunState({ ...base, trusted: false, hasCode: false }), 'enabled', 'a theme or a grammar runs no code');
        assert.equal(extensionRunState({ ...base, trusted: null }), 'enabled', 'no window, nothing restricts');
        assert.equal(mayRunCode({ ...base, trusted: false }), false);
        assert.equal(mayRunCode({ ...base, trusted: false, supportsUntrusted: true }), true);
    });

    it('lets the person and --disable-extensions turn any extension off, trusted or not', () => {
        assert.equal(extensionRunState({ ...base, enabled: false }), 'disabled');
        assert.equal(extensionRunState({ ...base, disabledByFlag: true }), 'disabled');
        assert.equal(extensionRunState({ ...base, disabledByFlag: true, supportsUntrusted: true, trusted: false }), 'disabled');
        assert.equal(mayRunCode({ ...base, disabledByFlag: true }), false);
    });

    it('reads untrustedWorkspaces.supported as VS Code does: true and "limited" support it', () => {
        const manifest = (supported: unknown): boolean => parseManifest({ name: 'x', publisher: 'p', version: '1.0.0', engines: { vscode: '^1.80.0' }, capabilities: { untrustedWorkspaces: { supported } } }).supportsUntrusted;
        assert.equal(manifest(true), true);
        assert.equal(manifest('limited'), true);
        assert.equal(manifest(false), false);
        assert.equal(manifest('yes'), false);
        assert.equal(parseManifest({ name: 'x', publisher: 'p', version: '1.0.0', engines: { vscode: '^1.80.0' } }).supportsUntrusted, false);
    });
});

const TRUST_JS = `
const vscode = require('vscode');
const seen = [];
exports.activate = (context) => {
  seen.push('activated ' + vscode.workspace.isTrusted);
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => seen.push('granted ' + vscode.workspace.isTrusted)));
  context.subscriptions.push(vscode.commands.registerCommand('trust.seen', () => seen.slice()));
};
`;

describe('workspace.isTrusted in the extension host (#263)', () => {
    let tmp = '';
    let child: ChildProcess;
    let main: RpcEndpoint;

    before(async () => {
        tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-trust-test-')));
        const folder = path.join(tmp, 'ext');
        fs.mkdirSync(folder);
        const packageJSON = { publisher: 'acme', name: 'trust', version: '1.0.0', main: 'index.js', engines: { vscode: '^1.80.0' }, capabilities: { untrustedWorkspaces: { supported: true } } };
        fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify(packageJSON));
        fs.writeFileSync(path.join(folder, 'index.js'), TRUST_JS);
        child = fork(HOST_ENTRY, [], { execArgv: ['--experimental-strip-types', '--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
        child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[host stderr] ${chunk.toString()}`));
        main = new RpcEndpoint((message) => child.send(message));
        child.on('message', (message) => main.receive(message));
        for (const method of [MAIN_METHODS.log, MAIN_METHODS.activation, MAIN_METHODS.notImplemented, MAIN_METHODS.uiNotify, MAIN_METHODS.webview]) {
            main.handle(method, () => undefined);
        }
        main.handle(MAIN_METHODS.ui, () => null);
        const init: HostInitData = {
            extensions: [{ id: 'acme.trust', location: folder, main: 'index.js', packageJSON, activationEvents: ['*'], extensionDependencies: [] }],
            passive: [],
            workspaceFolder: tmp,
            trusted: false,
            configuration: {},
            globalStorageRoot: path.join(tmp, 'storage'),
            workspaceStorageRoot: null,
            logRoot: path.join(tmp, 'logs'),
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
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('follows the IDE: false in Restricted Mode, then onDidGrantWorkspaceTrust once the folder is trusted', async () => {
        await main.request(HOST_METHODS.activateByEvent, '*');
        assert.deepEqual(await main.request(HOST_METHODS.executeCommand, 'trust.seen', []), ['activated false']);
        main.notify(HOST_METHODS.trustChanged, true);
        main.notify(HOST_METHODS.trustChanged, true);
        assert.deepEqual(await main.request(HOST_METHODS.executeCommand, 'trust.seen', []), ['activated false', 'granted true'], 'granted once');
    });
});
