import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeTable, probeVsix, type ProbeOptions } from '../src/main/extensions/compatProbe.ts';
import { vsix } from './helpers/zip.ts';

const HOST_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'extensionHost', 'index.ts');
const OPTIONS: ProbeOptions = { hostEntry: HOST_ENTRY, execArgv: ['--experimental-strip-types', '--no-warnings'], timeoutMs: 20_000 };
const manifest = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ publisher: 'acme', name, version: '1.0.0', engines: { vscode: '^1.80.0' }, ...extra });

describe('the compatibility probe (#264)', () => {
    let tmp = '';
    const write = (name: string, data: Buffer): string => {
        const file = path.join(tmp, name);
        fs.writeFileSync(file, data);
        return file;
    };

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-compat-test-'));
    });
    after(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('reports an extension that activates, with the commands it registered', async () => {
        const file = write('ok.vsix', vsix(manifest('ok', { main: 'index.js', activationEvents: ['onCommand:ok.hi'], contributes: { commands: [{ command: 'ok.hi', title: 'Hi' }] } }), {
            'index.js': "exports.activate = (c) => c.subscriptions.push(require('vscode').commands.registerCommand('ok.hi', () => 1));",
        }));
        const result = await probeVsix(file, OPTIONS);
        assert.equal(result.outcome, 'activated');
        assert.equal(result.id, 'acme.ok');
        assert.equal(result.registeredCommands, 1);
        assert.deepEqual(result.missingApi, []);
    });

    it('runs an extension shipped as an ES module that imports vscode, as popular ones do', async () => {
        const source = [
            "import * as vscode from 'vscode';",
            "import api from 'vscode';",
            'export function activate(context) {',
            '  const nls = JSON.parse(process.env.VSCODE_NLS_CONFIG);',
            '  const kinds = [vscode.TestRunProfileKind.Run, vscode.QuickInputButtonLocation.Input, api.ViewColumn.One];',
            "  context.subscriptions.push(vscode.commands.registerCommand('esm.hi', () => [nls.locale, ...kinds]));",
            '}',
        ].join('\n');
        const file = write('esm.vsix', vsix(manifest('esm', { type: 'module', main: 'index.js', activationEvents: ['*'] }), { 'index.js': source }));
        const result = await probeVsix(file, OPTIONS);
        assert.equal(result.outcome, 'activated', result.detail ?? '');
        assert.equal(result.registeredCommands, 1);
        assert.deepEqual(result.missingApi, []);
    });

    it('names the vscode API an extension reached for that the host lacks', async () => {
        const file = write('gap.vsix', vsix(manifest('gap', { main: 'index.js', activationEvents: ['onStartupFinished'] }), {
            'index.js': "exports.activate = () => { require('vscode').window.registerCustomEditorProvider('gap.editor', {}); };",
        }));
        const result = await probeVsix(file, OPTIONS);
        assert.equal(result.outcome, 'activated');
        assert.ok(result.missingApi.some((api) => api.includes('registerCustomEditorProvider')), result.missingApi.join(', '));
    });

    it('reports a failed activation, a package without code, and one that does not install', async () => {
        const failing = await probeVsix(write('bad.vsix', vsix(manifest('bad', { main: 'index.js', activationEvents: ['*'] }), { 'index.js': "exports.activate = () => { throw new Error('boom'); };" })), OPTIONS);
        assert.equal(failing.outcome, 'failed');
        assert.match(failing.detail ?? '', /boom/);
        const theme = await probeVsix(write('theme.vsix', vsix(manifest('theme', { contributes: { themes: [{ label: 'T', uiTheme: 'vs-dark', path: 't.json' }] } }), { 't.json': '{}' })), OPTIONS);
        assert.equal(theme.outcome, 'no-code');
        assert.deepEqual(theme.contributions?.themes, ['T']);
        const broken = await probeVsix(write('broken.vsix', Buffer.from('not a zip')), OPTIONS);
        assert.equal(broken.outcome, 'not-installed');
        const table = probeTable([failing, theme, broken]);
        assert.match(table, /\| acme\.bad \| 1\.0\.0 \| failed \|/);
        assert.match(table, /\| broken\.vsix \| {2}\| not-installed \|/);
    });
});
