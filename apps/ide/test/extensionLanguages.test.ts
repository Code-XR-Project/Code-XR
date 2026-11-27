import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_METHODS, MAIN_METHODS, RpcEndpoint, type HostInitData, type UiRequest } from '../src/shared/extensionHostProtocol.ts';
import {
    documentGlob, rewritePaths, selectorMatches, type CodeActionData, type CodeLensListData, type CompletionItemData, type CompletionListData, type DiagnosticsUpdate,
    type DocumentSymbolData, type HoverData, type LocationData, type ProviderRegistration,
} from '../src/shared/extensionLanguageProtocol.ts';
import { locationData, selectorData, workspaceEditData } from '../src/extensionHost/languageFeatures.ts';
import { Location, Position, Range, RelativePattern, Uri, WorkspaceEdit } from '../src/extensionHost/types.ts';
import { DocumentMirror, FolderPaths } from '../src/main/extensions/documentMirror.ts';
import { changesOf, completionKindName, diagnosticSeverity, foldingKind, fromMonacoRange, markerSeverity, monacoLanguages, toMonacoRange } from '../src/renderer/extensions/languageBridgeModel.ts';

const HOST_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'extensionHost', 'index.ts');

let tmp = '';
before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-lang-test-')));
});
after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('language features: shared helpers (#260)', () => {
    it('matches globs over workspace paths', () => {
        assert.ok(documentGlob('**/*.ts').test('src/a.ts'));
        assert.ok(documentGlob('**/*.ts').test('a.ts'));
        assert.ok(!documentGlob('*.ts').test('src/a.ts'));
        assert.ok(documentGlob('src/**').test('src/deep/a.md'));
        assert.ok(documentGlob('**/*.{js,ts}').test('x/y.js'));
        assert.ok(!documentGlob('**/*.{js,ts}').test('x/y.md'));
    });

    it('matches selectors the way VS Code does', () => {
        const doc = { languageId: 'python', path: 'src/app.py' };
        assert.ok(selectorMatches([{ language: 'python' }], doc));
        assert.ok(!selectorMatches([{ language: 'go' }], doc));
        assert.ok(selectorMatches([{ language: 'python', scheme: 'file' }], doc));
        assert.ok(!selectorMatches([{ language: 'python', scheme: 'untitled' }], doc));
        assert.ok(selectorMatches([{ pattern: '**/*.py' }], doc));
        assert.ok(selectorMatches([{ pattern: '*.py' }], doc), 'a bare pattern matches at any depth');
        assert.ok(!selectorMatches([{ language: 'python', pattern: '**/*.txt' }], doc), 'every field of a filter must match');
        assert.ok(selectorMatches([{ language: '*' }], doc));
        assert.ok(!selectorMatches([], doc));
        assert.ok(!selectorMatches([{}], doc), 'an empty filter matches nothing');
    });

    it('rewrites every path, drops what falls outside, and leaves command arguments alone', () => {
        const value = {
            locations: [{ path: '/w/a.ts', range: [0, 0, 0, 1] }, { path: '/elsewhere/b.ts', range: [0, 0, 0, 1] }],
            command: { id: 'x', title: 'X', args: [{ path: '/elsewhere/keep' }] },
            nested: { path: '/elsewhere/c.ts' },
        };
        const rewritten = rewritePaths(value, (p) => (p.startsWith('/w/') ? p.slice(3) : null)) as Record<string, unknown>;
        assert.deepEqual(rewritten['locations'], [{ path: 'a.ts', range: [0, 0, 0, 1] }]);
        assert.deepEqual(rewritten['command'], value.command);
        assert.equal(rewritten['nested'], null);
        assert.deepEqual(rewritePaths([{ path: '/elsewhere' }], () => null), []);
    });

    it('converts between Monaco and VS Code positions, kinds and severities', () => {
        assert.deepEqual(toMonacoRange([0, 0, 2, 5]), { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 6 });
        assert.deepEqual(fromMonacoRange({ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 6 }), [0, 0, 2, 5]);
        assert.deepEqual(changesOf([{ range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 }, text: 'x' }]), [{ range: [1, 2, 1, 2], text: 'x' }]);
        assert.equal(completionKindName(0), 'Text');
        assert.equal(completionKindName(1), 'Method');
        assert.equal(completionKindName(14), 'Snippet');
        assert.equal(completionKindName(99), 'Text');
        assert.deepEqual([0, 1, 2, 3].map(markerSeverity), [8, 4, 2, 1]);
        assert.deepEqual([8, 4, 2, 1].map(diagnosticSeverity), [0, 1, 2, 3]);
        assert.deepEqual([1, 2, 3, undefined].map(foldingKind), ['comment', 'imports', 'region', undefined]);
        assert.deepEqual(monacoLanguages([{ language: 'python' }, { language: 'python', scheme: 'file' }, { language: 'go' }]), ['python', 'go']);
        assert.equal(monacoLanguages([{ pattern: '**/*.x' }]), null);
        assert.deepEqual(monacoLanguages([{ scheme: 'untitled' }]), []);
    });

    it('turns selectors, locations and edits into plain data', () => {
        const root = path.join(tmp, 'w');
        assert.deepEqual(selectorData(['python', { scheme: 'file', language: 'go' }, { notebookType: 'jupyter' }], root), [{ language: 'python' }, { scheme: 'file', language: 'go' }]);
        assert.deepEqual(selectorData({ pattern: new RelativePattern(Uri.file(path.join(root, 'src')), '**/*.ts') }, root), [{ pattern: 'src/**/*.ts' }]);
        assert.deepEqual(selectorData({ pattern: new RelativePattern(Uri.file(path.join(tmp, 'other')), '*.ts') }, root), []);
        const file = Uri.file(path.join(root, 'a.ts'));
        const loc = locationData([new Location(file, new Position(1, 2)), { targetUri: file, targetRange: new Range(0, 0, 3, 0), targetSelectionRange: new Range(0, 4, 0, 7) }, new Location(Uri.parse('untitled:x'), new Position(0, 0))]);
        assert.deepEqual(loc, [
            { path: file.fsPath, range: [1, 2, 1, 2] },
            { path: file.fsPath, range: [0, 0, 3, 0], targetSelectionRange: [0, 4, 0, 7] },
        ]);
        const edit = new WorkspaceEdit();
        edit.replace(file, new Range(0, 0, 0, 1), 'X');
        edit.insert(file, new Position(2, 0), 'Y');
        assert.deepEqual(workspaceEditData(edit), { edits: [{ path: file.fsPath, edits: [{ range: [0, 0, 0, 1], text: 'X' }, { range: [2, 0, 2, 0], text: 'Y' }] }] });
    });
});

describe('the main process copy of the editor documents (#260)', () => {
    it('follows open, change and close, with absolute paths for the host', () => {
        const root = path.join(tmp, 'mirror');
        fs.mkdirSync(root, { recursive: true });
        const paths = new FolderPaths(root);
        const mirror = new DocumentMirror();
        const opened = mirror.accept([{ kind: 'open', path: 'src/a.ts', languageId: 'typescript', version: 1, text: 'let a = 1;\n' }], paths);
        assert.deepEqual(opened, [{ kind: 'open', path: path.join(root, 'src', 'a.ts'), languageId: 'typescript', version: 1, text: 'let a = 1;\n' }]);
        mirror.accept([
            { kind: 'change', path: 'src/a.ts', version: 2, changes: [{ range: [0, 4, 0, 5], text: 'b' }] },
            { kind: 'editor', editor: { path: 'src/a.ts', selections: [{ anchor: [0, 0], active: [0, 3] }], visibleRanges: [[0, 0, 1, 0]], tabSize: 2, insertSpaces: true } },
        ], paths);
        const snapshot = mirror.snapshot(paths);
        assert.equal(snapshot.documents[0]?.text, 'let b = 1;\n');
        assert.equal(snapshot.documents[0]?.version, 2);
        assert.equal(snapshot.activeEditor?.path, path.join(root, 'src', 'a.ts'));
        assert.equal(snapshot.activeEditor?.tabSize, 2);
        assert.deepEqual(mirror.accept([{ kind: 'close', path: 'src/a.ts' }], paths), [{ kind: 'close', path: path.join(root, 'src', 'a.ts') }]);
        assert.deepEqual(mirror.snapshot(paths), { documents: [], activeEditor: null });
    });

    it('drops what the renderer should not send', () => {
        const paths = new FolderPaths(path.join(tmp, 'mirror'));
        const mirror = new DocumentMirror();
        const events = mirror.accept([
            { kind: 'open', path: '../outside.txt', languageId: 'plaintext', version: 1, text: 'x' },
            { kind: 'open', path: '/etc/passwd', languageId: 'plaintext', version: 1, text: 'x' },
            { kind: 'change', path: 'never-opened.txt', version: 2, changes: [] },
            { kind: 'open', path: 'ok.txt', languageId: '', version: 1, text: 'x' },
            { kind: 'open', path: 'ok.txt', languageId: 'plaintext', version: -1, text: 'x' },
            { kind: 'editor', editor: { path: 'not-open.txt', selections: [], visibleRanges: [], tabSize: 4, insertSpaces: true } },
            'junk',
        ], paths);
        assert.deepEqual(events, [{ kind: 'editor', editor: null }]);
        assert.equal(paths.toWorkspace(path.join(tmp, 'elsewhere', 'a.txt')), null);
        assert.equal(paths.toWorkspace(path.join(tmp, 'mirror', 'd', 'a.txt')), 'd/a.txt');
    });
});

const LANG_JS = String.raw`
const vscode = require('vscode');
exports.activate = function (context) {
    const selector = { language: 'plaintext', scheme: 'file' };
    const diagnostics = vscode.languages.createDiagnosticCollection('todo');
    const seen = { opened: [], changed: 0, active: [] };
    const lint = (doc) => {
        if (doc.languageId !== 'plaintext') return;
        const list = [];
        doc.getText().split('\n').forEach((line, i) => {
            const at = line.indexOf('TODO');
            if (at >= 0) {
                const d = new vscode.Diagnostic(new vscode.Range(i, at, i, at + 4), 'A TODO is left', vscode.DiagnosticSeverity.Warning);
                d.source = 'todo';
                list.push(d);
            }
        });
        diagnostics.set(doc.uri, list);
    };
    vscode.workspace.textDocuments.forEach(lint);
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => { seen.opened.push(vscode.workspace.asRelativePath(doc.uri)); lint(doc); }),
        vscode.workspace.onDidChangeTextDocument((event) => { seen.changed++; lint(event.document); }),
        vscode.window.onDidChangeActiveTextEditor((editor) => seen.active.push(editor ? vscode.workspace.asRelativePath(editor.document.uri) : null)),
        vscode.languages.registerHoverProvider(selector, {
            provideHover(doc, position) {
                const range = doc.getWordRangeAtPosition(position);
                return range ? new vscode.Hover(new vscode.MarkdownString('**' + doc.getText(range) + '**'), range) : undefined;
            },
        }),
        vscode.languages.registerCompletionItemProvider(selector, {
            provideCompletionItems() {
                const item = new vscode.CompletionItem('hello', vscode.CompletionItemKind.Keyword);
                item.insertText = new vscode.SnippetString('hello \${1:name}');
                return [item, new vscode.CompletionItem('world')];
            },
            resolveCompletionItem(item) {
                item.documentation = new vscode.MarkdownString('Says *hello*');
                return item;
            },
        }, '.'),
        vscode.languages.registerDefinitionProvider(selector, {
            provideDefinition(doc) { return new vscode.Location(doc.uri, new vscode.Position(0, 0)); },
        }),
        vscode.languages.registerDocumentSymbolProvider(selector, {
            provideDocumentSymbols() {
                const symbol = new vscode.DocumentSymbol('Top', 'detail', vscode.SymbolKind.Class, new vscode.Range(0, 0, 1, 0), new vscode.Range(0, 0, 0, 3));
                symbol.children.push(new vscode.DocumentSymbol('inner', '', vscode.SymbolKind.Method, new vscode.Range(1, 0, 1, 2), new vscode.Range(1, 0, 1, 2)));
                return [symbol];
            },
        }),
        vscode.languages.registerCodeActionsProvider(selector, {
            provideCodeActions(doc, range, context) {
                return context.diagnostics.filter((d) => d.source === 'todo').map((d) => {
                    const action = new vscode.CodeAction('Mark as DONE', vscode.CodeActionKind.QuickFix);
                    action.edit = new vscode.WorkspaceEdit();
                    action.edit.replace(doc.uri, d.range, 'DONE');
                    action.diagnostics = [d];
                    return action;
                });
            },
        }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
        vscode.languages.registerCodeLensProvider(selector, {
            provideCodeLenses() { return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0))]; },
            resolveCodeLens(lens) { lens.command = { command: 'lang.state', title: 'Show state', arguments: [1] }; return lens; },
        }),
        vscode.commands.registerCommand('lang.state', () => {
            const editor = vscode.window.activeTextEditor;
            return {
                seen,
                active: editor ? vscode.workspace.asRelativePath(editor.document.uri) : null,
                selection: editor ? [editor.selection.active.line, editor.selection.active.character] : null,
                texts: vscode.workspace.textDocuments.map((doc) => vscode.workspace.asRelativePath(doc.uri) + '@' + doc.version + ':' + doc.getText()),
                diagnostics: vscode.languages.getDiagnostics().map(([uri, list]) => vscode.workspace.asRelativePath(uri) + ':' + list.length),
            };
        }),
        vscode.commands.registerTextEditorCommand('lang.shout', (editor, edit) => {
            edit.replace(new vscode.Range(0, 0, 0, 3), editor.document.getText(new vscode.Range(0, 0, 0, 3)).toUpperCase());
        }),
        vscode.commands.registerCommand('lang.apply', () => {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(vscode.window.activeTextEditor.document.uri, new vscode.Position(0, 0), '>> ');
            return vscode.workspace.applyEdit(edit);
        }),
        vscode.commands.registerCommand('lang.save', () => vscode.window.activeTextEditor.document.save()),
    );
};
`;

describe('language features in the extension host (#260)', () => {
    let child: ChildProcess;
    let main: RpcEndpoint;
    const ui: UiRequest[] = [];
    const registrations: ProviderRegistration[] = [];
    const diagnostics: DiagnosticsUpdate[] = [];
    let workspace = '';
    let file = '';

    const waitFor = async <T>(probe: () => T | undefined, what: string): Promise<T> => {
        for (let attempt = 0; attempt < 100; attempt++) {
            const value = probe();
            if (value !== undefined) {
                return value;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out waiting for ${what}`);
    };
    const handleOf = (kind: string): number => {
        const found = registrations.find((registration) => registration.kind === kind);
        assert.ok(found, `a ${kind} provider`);
        return found.handle;
    };

    before(async () => {
        workspace = path.join(tmp, 'lang-ws');
        fs.mkdirSync(workspace, { recursive: true });
        file = path.join(workspace, 'notes.txt');
        const extensionFolder = path.join(tmp, 'extensions', 'acme.lang-1.0.0');
        fs.mkdirSync(extensionFolder, { recursive: true });
        const packageJSON = { publisher: 'acme', name: 'lang', version: '1.0.0', main: 'index.js', engines: { vscode: '^1.80.0' }, activationEvents: ['*'] };
        fs.writeFileSync(path.join(extensionFolder, 'package.json'), JSON.stringify(packageJSON));
        fs.writeFileSync(path.join(extensionFolder, 'index.js'), LANG_JS);

        child = fork(HOST_ENTRY, [], { execArgv: ['--experimental-strip-types', '--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
        child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[host stderr] ${chunk.toString()}`));
        main = new RpcEndpoint((message) => child.send(message));
        child.on('message', (message) => main.receive(message));
        main.handle(MAIN_METHODS.log, () => undefined);
        main.handle(MAIN_METHODS.activation, () => undefined);
        main.handle(MAIN_METHODS.notImplemented, () => undefined);
        main.handle(MAIN_METHODS.uiNotify, () => undefined);
        main.handle(MAIN_METHODS.registerProvider, (registration) => registrations.push(registration as ProviderRegistration));
        main.handle(MAIN_METHODS.diagnostics, (update) => diagnostics.push(update as DiagnosticsUpdate));
        main.handle(MAIN_METHODS.ui, (request) => {
            const typed = request as UiRequest;
            ui.push(typed);
            if (typed.kind === 'applyEdit') {
                // What the editor does: apply the edit, then report the change before answering.
                const entry = typed.edit.edits[0];
                main.notify(HOST_METHODS.documents, [{ kind: 'change', path: entry?.path, version: 10 + ui.length, changes: entry?.edits ?? [] }]);
                return true;
            }
            if (typed.kind === 'saveFile') {
                main.notify(HOST_METHODS.documents, [{ kind: 'save', path: typed.path }]);
                return true;
            }
            return null;
        });
        const init: HostInitData = {
            extensions: [{ id: 'acme.lang', location: extensionFolder, main: 'index.js', packageJSON, activationEvents: ['*'], extensionDependencies: [] }],
            passive: [],
            workspaceFolder: workspace,
            trusted: true,
            configuration: {},
            globalStorageRoot: path.join(tmp, 'lang-storage'),
            workspaceStorageRoot: null,
            logRoot: path.join(tmp, 'lang-logs'),
            env: { appName: 'Code-XR IDE', appRoot: tmp, appHost: 'desktop', language: 'en', machineId: 'm', sessionId: 's', uriScheme: 'codexr', shell: '/bin/sh', version: '0.0.0' },
            isDevelopment: false,
            documents: [{ path: file, languageId: 'plaintext', version: 1, text: 'one TODO here\nsecond line\n' }],
            activeEditor: { path: file, selections: [{ anchor: [0, 0], active: [0, 0] }], visibleRanges: [], tabSize: 4, insertSpaces: true },
        };
        await main.request(HOST_METHODS.init, init);
        await main.request(HOST_METHODS.activateByEvent, '*');
    });

    after(() => {
        if (child.exitCode === null) {
            child.kill();
        }
    });

    it('announces each provider with its selector and trigger characters', () => {
        assert.deepEqual(registrations.map((registration) => registration.kind), ['hover', 'completion', 'definition', 'documentSymbol', 'codeAction', 'codeLens']);
        const completion = registrations.find((registration) => registration.kind === 'completion');
        assert.deepEqual(completion?.selector, [{ language: 'plaintext', scheme: 'file' }]);
        assert.deepEqual(completion?.triggerCharacters, ['.']);
        assert.equal(completion?.resolves, true);
        assert.deepEqual(registrations.find((registration) => registration.kind === 'codeAction')?.providedCodeActionKinds, ['quickfix']);
    });

    it('sees the documents the editor had open when it started, and their diagnostics', async () => {
        const update = await waitFor(() => diagnostics[0], 'diagnostics');
        assert.equal(update.owner, 'acme.lang:todo');
        assert.deepEqual(update.entries, [{ path: file, diagnostics: [{ range: [0, 4, 0, 8], message: 'A TODO is left', severity: 1, source: 'todo' }] }]);
        const state = await main.request<Record<string, unknown>>(HOST_METHODS.executeCommand, 'lang.state', []);
        assert.equal(state['active'], 'notes.txt');
        assert.deepEqual(state['texts'], ['notes.txt@1:one TODO here\nsecond line\n']);
        assert.deepEqual(state['diagnostics'], ['notes.txt:1']);
    });

    it('answers hover, completion (and its resolve), definition, symbols, code actions and lenses', async () => {
        const provide = <T>(kind: string, args: Record<string, unknown>, requestKind = kind): Promise<T> => main.request<T>(HOST_METHODS.provide, { handle: handleOf(kind), kind: requestKind, path: file, args });
        assert.deepEqual(await provide<HoverData>('hover', { position: [0, 5] }), { contents: ['**TODO**'], range: [0, 4, 0, 8] });
        const list = await provide<CompletionListData>('completion', { position: [1, 0], triggerKind: 0 });
        assert.deepEqual(list.items.map((item) => [item.label, item.kind, item.insertText, item.isSnippet]), [['hello', 13, 'hello ${1:name}', true], ['world', undefined, undefined, undefined]]);
        assert.equal(typeof list.cacheId, 'number');
        const resolved = await main.request<CompletionItemData>(HOST_METHODS.provide, { handle: handleOf('completion'), kind: 'resolveCompletion', path: file, args: { cacheId: list.cacheId, index: 0 } });
        assert.equal(resolved.documentation, 'Says *hello*');
        assert.deepEqual(await provide<LocationData[]>('definition', { position: [1, 1] }), [{ path: file, range: [0, 0, 0, 0] }]);
        const symbols = await provide<DocumentSymbolData[]>('documentSymbol', {});
        assert.equal(symbols[0]?.name, 'Top');
        assert.equal(symbols[0]?.children[0]?.name, 'inner');
        const actions = await provide<CodeActionData[]>('codeAction', { range: [0, 4, 0, 8], diagnostics: [{ range: [0, 4, 0, 8], message: 'A TODO is left', severity: 1, source: 'todo' }], triggerKind: 1 });
        assert.equal(actions[0]?.title, 'Mark as DONE');
        assert.equal(actions[0]?.kind, 'quickfix');
        assert.deepEqual(actions[0]?.edit, { edits: [{ path: file, edits: [{ range: [0, 4, 0, 8], text: 'DONE' }] }] });
        const lenses = await provide<CodeLensListData>('codeLens', {});
        assert.equal(lenses.lenses[0]?.command, undefined);
        const lens = await main.request<{ command?: { id: string; args?: unknown[] } }>(HOST_METHODS.provide, { handle: handleOf('codeLens'), kind: 'resolveCodeLens', path: file, args: { cacheId: lenses.cacheId, index: 0 } });
        assert.deepEqual(lens.command, { id: 'lang.state', title: 'Show state', args: [1] });
        assert.equal(await main.request(HOST_METHODS.provide, { handle: 999, kind: 'hover', path: file, args: {} }), null, 'an unknown provider answers nothing');
    });

    it('applies the editor changes in order and fires the events, diagnostics included', async () => {
        const before = diagnostics.length;
        main.notify(HOST_METHODS.documents, [
            { kind: 'change', path: file, version: 2, changes: [{ range: [0, 4, 0, 8], text: 'DONE' }, { range: [1, 0, 1, 0], text: 'TODO ' }] },
            { kind: 'editor', editor: { path: file, selections: [{ anchor: [1, 2], active: [1, 3] }], visibleRanges: [], tabSize: 4, insertSpaces: true } },
        ]);
        const update = await waitFor(() => diagnostics[before], 'new diagnostics');
        assert.deepEqual(update.entries[0]?.diagnostics.map((diagnostic) => diagnostic.range), [[1, 0, 1, 4]]);
        const state = await main.request<{ texts: string[]; selection: number[]; seen: { changed: number } }>(HOST_METHODS.executeCommand, 'lang.state', []);
        assert.deepEqual(state.texts, ['notes.txt@2:one DONE here\nTODO second line\n']);
        assert.deepEqual(state.selection, [1, 3]);
        assert.equal(state.seen.changed, 1);
    });

    it('edits through the workbench: TextEditor.edit, workspace.applyEdit, save', async () => {
        assert.equal(await main.request(HOST_METHODS.executeCommand, 'lang.shout', []), true);
        const shout = ui.find((request) => request.kind === 'applyEdit');
        assert.ok(shout && shout.kind === 'applyEdit');
        assert.deepEqual(shout.edit, { edits: [{ path: file, edits: [{ range: [0, 0, 0, 3], text: 'ONE' }] }] });
        assert.equal(await main.request(HOST_METHODS.executeCommand, 'lang.apply', []), true);
        const state = await main.request<{ texts: string[] }>(HOST_METHODS.executeCommand, 'lang.state', []);
        assert.match(state.texts[0] ?? '', /^notes\.txt@\d+:>> ONE DONE here/);
        assert.equal(await main.request(HOST_METHODS.executeCommand, 'lang.save', []), true);
        assert.ok(ui.some((request) => request.kind === 'saveFile' && request.path === file));
    });

    it('closes documents, clears the active editor, and opens new ones', async () => {
        const other = path.join(workspace, 'b.txt');
        main.notify(HOST_METHODS.documents, [
            { kind: 'close', path: file },
            { kind: 'open', path: other, languageId: 'plaintext', version: 1, text: 'TODO' },
            { kind: 'editor', editor: { path: other, selections: [], visibleRanges: [], tabSize: 4, insertSpaces: true } },
        ]);
        const state = await main.request<{ active: string | null; texts: string[]; seen: { opened: string[]; active: (string | null)[] } }>(HOST_METHODS.executeCommand, 'lang.state', []);
        assert.equal(state.active, 'b.txt');
        assert.deepEqual(state.texts, ['b.txt@1:TODO']);
        assert.deepEqual(state.seen.opened, ['b.txt']);
        assert.deepEqual(state.seen.active, [null, 'b.txt']);
    });
});
