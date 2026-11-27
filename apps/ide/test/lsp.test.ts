import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { clientUriToWorkspacePath, mapServerUris, toClientUri, toServerUri, workspacePathToClientUri } from '../src/main/lsp/lspUri.ts';
import { assertLanguage, assertRequestMethod, buildDocumentRequest, CompletionDataStore, lspLanguageId, RestartBudget } from '../src/main/lsp/lspProtocol.ts';
import { findOnPath, findPythonServer, serverEnvironment, typescriptServerCommand } from '../src/main/lsp/lspServers.ts';
import { ALLOWED_IPC_CHANNELS } from '../src/shared/api.ts';
import { LSP_IPC_CHANNELS, LSP_REQUEST_METHODS, serverIdOf } from '../src/shared/lsp.ts';
import { completionKindName, markdownOf, markerSeverity, openTarget, symbolKind, toLocations, toSymbols } from '../src/renderer/lsp/lspConvert.ts';

const root = path.resolve(path.sep, 'work', 'project');
const roots = { root, realRoot: path.resolve(path.sep, 'real', 'project') };
const fileUri = (...segments: string[]): string => pathToFileURL(path.join(...segments)).href;

describe('LSP URI mapping (#21)', () => {
    it('maps a renderer URI to a file URI inside the folder and back', () => {
        const server = toServerUri('codexr-file:///src/a.ts', roots);
        assert.equal(server, fileUri(root, 'src', 'a.ts'));
        assert.equal(toClientUri(server, roots), 'codexr-file:/src/a.ts');
        assert.equal(toServerUri('codexr-file:/src/a.ts', roots), server, 'Monaco writes the URI without "//"');
    });

    it('round-trips names that need encoding', () => {
        const client = workspacePathToClientUri('src/my file#1.ts');
        assert.equal(clientUriToWorkspacePath(client), 'src/my file#1.ts');
        assert.equal(toClientUri(toServerUri(client, roots), roots), client);
    });

    it('maps answers given under the real path of the folder', () => {
        assert.equal(toClientUri(fileUri(roots.realRoot, 'lib', 'b.ts'), roots), 'codexr-file:/lib/b.ts');
    });

    it('drops server URIs outside the folder, the folder itself and other schemes', () => {
        assert.equal(toClientUri(fileUri(path.sep, 'usr', 'lib', 'lib.d.ts'), roots), null);
        assert.equal(toClientUri(fileUri(root, '..', 'other', 'x.ts'), roots), null);
        assert.equal(toClientUri(fileUri(root), roots), null);
        assert.equal(toClientUri('https://example.com/a.ts', roots), null);
        assert.equal(toClientUri(42, roots), null);
    });
});

describe('LSP path guard (#21)', () => {
    for (const uri of [
        'codexr-file:///../etc/passwd',
        'codexr-file:///src/%2e%2e/%2e%2e/etc/passwd',
        'codexr-file:///%2Fetc%2Fpasswd',
        'codexr-file:///C:%5Cwindows',
        'codexr-file:///a%00b',
        'codexr-file:///',
        'codexr-file:///src/a.ts?x=1',
        'codexr-file://host/src/a.ts',
        'codexr-file:',
        'codexr-file:/../x',
        'codexr-file:src/a.ts',
        'file:///etc/passwd',
        'codexr-file:///%E0%A4%A',
    ]) {
        it(`refuses ${uri}`, () => {
            assert.throws(() => toServerUri(uri, roots));
        });
    }

    it('refuses what is not a string', () => {
        assert.throws(() => clientUriToWorkspacePath(undefined));
        assert.throws(() => clientUriToWorkspacePath({ uri: 'codexr-file:///a.ts' }));
    });

    it('drops locations outside the folder from an answer, and objects that contain one', () => {
        const inside = { uri: fileUri(root, 'a.ts'), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
        const outside = { uri: fileUri(path.sep, 'usr', 'lib.d.ts'), range: inside.range };
        const map = (uri: string): string | null => toClientUri(uri, roots);
        assert.deepEqual(mapServerUris([inside, outside], map), [{ ...inside, uri: 'codexr-file:/a.ts' }]);
        assert.equal(mapServerUris(outside, map), null);
        assert.deepEqual(mapServerUris([{ targetUri: outside.uri, targetRange: inside.range }], map), []);
        const diagnostic = { message: 'x', relatedInformation: [{ location: outside, message: 'lib' }, { location: inside, message: 'here' }] };
        assert.deepEqual(mapServerUris(diagnostic, map), { message: 'x', relatedInformation: [{ location: { ...inside, uri: 'codexr-file:/a.ts' }, message: 'here' }] });
        assert.equal(mapServerUris(null, map), null);
    });
});

describe('LSP method allowlist (#21)', () => {
    it('accepts the listed methods only', () => {
        for (const method of LSP_REQUEST_METHODS) {
            assert.equal(assertRequestMethod(method), method);
        }
        for (const method of ['workspace/executeCommand', 'workspace/applyEdit', 'codeAction/resolve', 'workspace/willRenameFiles', 'textDocument/formatting', 'shutdown', 'exit', 'initialize', '$/cancelRequest', 'textDocument/hover ', '', null, 7, {}]) {
            assert.throws(() => assertRequestMethod(method), /Refused language server request/);
        }
    });

    it('lists its channels in IPC_CHANNELS', () => {
        for (const channel of Object.values(LSP_IPC_CHANNELS)) {
            assert.ok(ALLOWED_IPC_CHANNELS.has(channel));
        }
    });

    it('accepts the languages that have a server', () => {
        assert.equal(assertLanguage('typescript'), 'typescript');
        assert.equal(serverIdOf('javascript'), 'typescript');
        assert.equal(serverIdOf('python'), 'python');
        assert.throws(() => assertLanguage('java'));
        assert.equal(lspLanguageId('typescript', 'a/b.tsx'), 'typescriptreact');
        assert.equal(lspLanguageId('javascript', 'a.mjs'), 'javascript');
    });

    it('rebuilds the parameters from validated fields only', () => {
        const toServer = (uri: unknown): string => toServerUri(uri, roots);
        const request = buildDocumentRequest('textDocument/completion', {
            textDocument: { uri: 'codexr-file:///a.ts', extra: 1 },
            position: { line: 3, character: 4, evil: true },
            context: { triggerKind: 2, triggerCharacter: '.' },
            workDoneToken: 'x',
        }, toServer);
        assert.deepEqual(request.params, { textDocument: { uri: fileUri(root, 'a.ts') }, position: { line: 3, character: 4 }, context: { triggerKind: 2, triggerCharacter: '.' } });
        assert.equal(request.serverUri, fileUri(root, 'a.ts'));
        assert.deepEqual(buildDocumentRequest('textDocument/documentSymbol', { textDocument: { uri: 'codexr-file:///a.ts' } }, toServer).params, { textDocument: { uri: fileUri(root, 'a.ts') } });
        assert.throws(() => buildDocumentRequest('textDocument/hover', { textDocument: { uri: 'codexr-file:///a.ts' }, position: { line: -1, character: 0 } }, toServer));
        assert.throws(() => buildDocumentRequest('textDocument/hover', { textDocument: { uri: 'codexr-file:///a.ts' }, position: { line: 1.5, character: 0 } }, toServer));
        assert.throws(() => buildDocumentRequest('textDocument/completion', { textDocument: { uri: 'codexr-file:///a.ts' }, position: { line: 0, character: 0 }, context: { triggerKind: 9 } }, toServer));
        assert.throws(() => buildDocumentRequest('textDocument/definition', { textDocument: { uri: 'codexr-file:///../x.ts' }, position: { line: 0, character: 0 } }, toServer));
        assert.throws(() => buildDocumentRequest('textDocument/hover', null, toServer));
    });

    it('hides completion data behind tokens and restores it for its own server only', () => {
        const store = new CompletionDataStore();
        const result = { isIncomplete: false, items: [{ label: 'push', data: { file: '/abs/a.ts', offset: 3 } }, { label: 'pop' }] };
        store.tokenize(result, 'typescript');
        const [first, second] = result.items;
        assert.deepEqual(first?.data, { codexrCompletion: 1 });
        assert.equal(second && 'data' in second, false);
        const restored = store.restore(first);
        assert.equal(restored?.server, 'typescript');
        assert.deepEqual(restored?.item['data'], { file: '/abs/a.ts', offset: 3 });
        assert.equal(store.restore({ label: 'forged', data: { codexrCompletion: 99 } }), null);
        assert.equal(store.restore({ label: 'forged', data: { file: '/etc/passwd' } }), null);
        store.tokenize([], 'typescript');
        assert.equal(store.restore(first), null, 'a new list forgets the previous one');
    });

    it('restarts a crashed server at most three times in the window', () => {
        const budget = new RestartBudget(3, 1000);
        assert.equal(budget.allow(0), true);
        assert.equal(budget.allow(10), true);
        assert.equal(budget.allow(20), true);
        assert.equal(budget.allow(30), false);
        assert.equal(budget.allow(2000), true, 'old crashes leave the window');
    });
});

describe('LSP servers (#21)', () => {
    it('runs typescript-language-server on Electron\'s Node, with the IDE\'s TypeScript and no type acquisition', () => {
        const command = typescriptServerCommand({ execPath: '/app/electron', cliPath: '/ide/cli.mjs', tsserverPath: '/ide/ts/tsserver.js' }, { PATH: '/bin', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '0' });
        assert.equal(command.command, '/app/electron');
        assert.deepEqual(command.args.slice(0, 2), ['/ide/cli.mjs', '--stdio']);
        assert.equal(command.env['ELECTRON_RUN_AS_NODE'], '1');
        assert.equal(command.env['NODE_OPTIONS'], undefined);
        assert.deepEqual((command.initializationOptions?.['tsserver'] as { path: string }).path, '/ide/ts/tsserver.js');
        assert.equal(command.initializationOptions?.['disableAutomaticTypingAcquisition'], true);
        assert.deepEqual(serverEnvironment({ A: '1', CODEXR_IDE_DEV_SERVER_URL: 'x' }), { A: '1' });
    });

    it('finds a Python server on PATH, pyright first, ignoring relative entries', async () => {
        const files = new Set(['/opt/bin/pylsp', '/home/u/.local/bin/pyright-langserver', 'rel/pyright-langserver']);
        const lookup = { platform: 'linux' as const, env: { PATH: 'rel:/opt/bin:/home/u/.local/bin' }, isFile: (file: string) => Promise.resolve(files.has(file)) };
        const found = await findPythonServer(lookup);
        assert.equal(found?.command, '/home/u/.local/bin/pyright-langserver');
        assert.deepEqual(found?.args, ['--stdio']);
        files.delete('/home/u/.local/bin/pyright-langserver');
        assert.equal((await findPythonServer(lookup))?.name, 'pylsp');
        files.clear();
        assert.equal(await findPythonServer(lookup), null);
    });

    it('looks for .exe only on Windows', async () => {
        const files = new Set(['C:\\Py\\Scripts\\pylsp.exe', 'C:\\npm\\pyright-langserver.cmd']);
        const lookup = { platform: 'win32' as const, env: { Path: 'C:\\npm;C:\\Py\\Scripts' }, isFile: (file: string) => Promise.resolve(files.has(file)) };
        assert.equal(await findOnPath('pyright-langserver', lookup), null);
        assert.equal(await findOnPath('pylsp', lookup), 'C:\\Py\\Scripts\\pylsp.exe');
    });
});

describe('LSP to Monaco conversions (#21)', () => {
    it('maps severities, kinds and ranges', () => {
        assert.deepEqual([1, 2, 3, 4, undefined].map(markerSeverity), [8, 4, 2, 1, 8]);
        assert.equal(completionKindName(2), 'Method');
        assert.equal(completionKindName(10), 'Property');
        assert.equal(completionKindName(99), 'Text');
        assert.equal(symbolKind(5), 4);
        const range = { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } };
        assert.deepEqual(toLocations([{ uri: 'codexr-file:///b.ts', range }]), [{ uri: 'codexr-file:///b.ts', range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 6 } }]);
        assert.deepEqual(openTarget({ startLineNumber: 4, startColumn: 3, endLineNumber: 4, endColumn: 9 }), { line: 4, column: 3, length: 6 });
        assert.deepEqual(openTarget({ lineNumber: 2, column: 5 }), { line: 2, column: 5, length: 0 });
    });

    it('renders hover contents as Markdown', () => {
        assert.deepEqual(markdownOf({ kind: 'markdown', value: '**x**' }), ['**x**']);
        assert.deepEqual(markdownOf({ kind: 'plaintext', value: 'a*b' }), ['a\\*b']);
        assert.deepEqual(markdownOf([{ language: 'ts', value: 'let x' }, 'doc']), ['```ts\nlet x\n```', 'doc']);
        assert.deepEqual(markdownOf(null), []);
    });

    it('keeps the document\'s own flat symbols and nests hierarchical ones', () => {
        const range = { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } };
        const flat = toSymbols([
            { name: 'a', kind: 12, location: { uri: 'codexr-file:///a.ts', range } },
            { name: 'b', kind: 12, location: { uri: 'codexr-file:///b.ts', range } },
        ], 'codexr-file:///a.ts');
        assert.deepEqual(flat.map((s) => s.name), ['a']);
        const tree = toSymbols([{ name: 'C', kind: 5, range, selectionRange: range, children: [{ name: 'm', kind: 6, range, selectionRange: range }] }], 'codexr-file:///a.ts');
        assert.equal(tree[0]?.children[0]?.name, 'm');
    });
});
