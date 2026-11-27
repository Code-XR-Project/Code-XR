import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toClientUri, toServerUri } from '../src/main/lsp/lspUri.ts';
import { buildDocumentRequest, buildWorkspaceSymbolRequest } from '../src/main/lsp/lspProtocol.ts';
import { mapCodeActions, mapDocumentResult, mapWorkspaceEdit, mapWorkspaceSymbols } from '../src/main/lsp/lspResults.ts';
import { LSP_EDIT_REFUSED } from '../src/shared/lsp.ts';
import { applyTextEdits, clientUriPath, fileCount, refusalReason, workspaceEditFiles } from '../src/renderer/lsp/lspEdits.ts';
import { toCodeActions, toHighlights, toLspDiagnostic, toLspRange, toRenameRange, toSignatureHelp, toWorkspaceSymbolItems } from '../src/renderer/lsp/lspConvert.ts';
import { paletteView, type PaletteContext } from '../src/renderer/commands/paletteModel.ts';
import { createWorkspaceSymbolSearch } from '../src/renderer/workspaceSymbols.ts';

const root = path.resolve(path.sep, 'work', 'project');
const roots = { root, realRoot: path.resolve(path.sep, 'real', 'project') };
const fileUri = (...segments: string[]): string => pathToFileURL(path.join(...segments)).href;
const toClient = (uri: string): string | null => toClientUri(uri, roots);
const toServer = (uri: unknown): string => toServerUri(uri, roots);
const range = (line: number, start: number, end: number) => ({ start: { line, character: start }, end: { line, character: end } });
const refused = new RegExp(LSP_EDIT_REFUSED);

describe('LSP refactoring requests (#287)', () => {
    const textDocument = { uri: 'codexr-file:/src/a.ts' };

    it('rebuilds references, rename, signature help, highlights and code action parameters', () => {
        assert.deepEqual(buildDocumentRequest('textDocument/references', { textDocument, position: { line: 1, character: 2 }, context: { includeDeclaration: true, extra: 1 } }, toServer).params,
            { textDocument: { uri: fileUri(root, 'src', 'a.ts') }, position: { line: 1, character: 2 }, context: { includeDeclaration: true } });
        assert.deepEqual(buildDocumentRequest('textDocument/rename', { textDocument, position: { line: 0, character: 0 }, newName: 'salute' }, toServer).params['newName'], 'salute');
        assert.deepEqual(buildDocumentRequest('textDocument/signatureHelp', { textDocument, position: { line: 0, character: 0 }, context: { triggerKind: 2, triggerCharacter: '(', isRetrigger: false, activeSignatureHelp: { signatures: [] } } }, toServer).params['context'],
            { triggerKind: 2, triggerCharacter: '(', isRetrigger: false });
        assert.deepEqual(Object.keys(buildDocumentRequest('textDocument/documentHighlight', { textDocument, position: { line: 0, character: 0 }, workDoneToken: 'x' }, toServer).params), ['textDocument', 'position']);
        const action = buildDocumentRequest('textDocument/codeAction', {
            textDocument,
            range: range(0, 17, 22),
            context: { diagnostics: [{ range: range(0, 17, 22), message: "Cannot find name 'greet'.", severity: 1, code: 2304, source: 'typescript', data: { secret: '/abs' } }], only: ['quickfix'], triggerKind: 1 },
        }, toServer);
        assert.deepEqual(action.params['context'], { diagnostics: [{ range: range(0, 17, 22), message: "Cannot find name 'greet'.", severity: 1, code: 2304, source: 'typescript' }], only: ['quickfix'], triggerKind: 1 });
        assert.deepEqual(buildWorkspaceSymbolRequest({ query: 'gre', extra: true }), { query: 'gre' });
    });

    it('refuses malformed parameters', () => {
        const position = { line: 0, character: 0 };
        for (const newName of ['', '   ', 'a\nb', 'a\0', 7, 'x'.repeat(2000)]) {
            assert.throws(() => buildDocumentRequest('textDocument/rename', { textDocument, position, newName }, toServer), `new name ${JSON.stringify(newName)}`);
        }
        assert.throws(() => buildDocumentRequest('textDocument/references', { textDocument, position }, toServer), 'the reference context is required');
        assert.throws(() => buildDocumentRequest('textDocument/codeAction', { textDocument, range: range(0, 0, 1), context: { diagnostics: 'x' } }, toServer));
        assert.throws(() => buildDocumentRequest('textDocument/codeAction', { textDocument, range: range(0, 0, 1), context: { diagnostics: [], only: ['../x'] } }, toServer));
        assert.throws(() => buildDocumentRequest('textDocument/codeAction', { textDocument, range: range(0, 0, 1), context: { diagnostics: Array.from({ length: 201 }, () => ({ range: range(0, 0, 1), message: 'x' })) } }, toServer));
        assert.throws(() => buildDocumentRequest('textDocument/codeAction', { textDocument, range: { start: position }, context: { diagnostics: [] } }, toServer));
        assert.throws(() => buildDocumentRequest('textDocument/signatureHelp', { textDocument, position, context: { triggerKind: 7 } }, toServer));
        assert.throws(() => buildDocumentRequest('textDocument/rename', { textDocument: { uri: 'codexr-file:/../x.ts' }, position, newName: 'b' }, toServer));
        assert.throws(() => buildWorkspaceSymbolRequest({ query: 5 }));
    });
});

describe('LSP workspace edits in the main process (#287)', () => {
    it('maps both edit forms to renderer URIs, merging a file named twice', () => {
        const edit = { range: range(0, 0, 5), newText: 'salute' };
        assert.deepEqual(mapWorkspaceEdit({ changes: { [fileUri(root, 'a.ts')]: [edit], [fileUri(roots.realRoot, 'lib', 'b.ts')]: [edit] } }, toClient),
            { changes: { 'codexr-file:/a.ts': [edit], 'codexr-file:/lib/b.ts': [edit] } });
        const other = { range: range(2, 1, 2), newText: 'x', annotationId: 'a' };
        assert.deepEqual(mapWorkspaceEdit({ documentChanges: [
            { textDocument: { uri: fileUri(root, 'a.ts'), version: 3 }, edits: [edit] },
            { textDocument: { uri: fileUri(root, 'a.ts'), version: 3 }, edits: [other] },
        ] }, toClient), { changes: { 'codexr-file:/a.ts': [edit, { range: other.range, newText: 'x' }] } });
        assert.equal(mapWorkspaceEdit(null, toClient), null);
    });

    it('refuses the whole edit when one file is outside the folder', () => {
        const edit = { range: range(0, 0, 1), newText: 'x' };
        assert.throws(() => mapWorkspaceEdit({ changes: { [fileUri(root, 'a.ts')]: [edit], [fileUri(path.sep, 'usr', 'lib', 'x.d.ts')]: [edit] } }, toClient), /outside the open folder/);
        assert.throws(() => mapWorkspaceEdit({ documentChanges: [{ textDocument: { uri: fileUri(root, '..', 'other', 'a.ts') }, edits: [edit] }] }, toClient), /outside the open folder/);
        assert.throws(() => mapWorkspaceEdit({ changes: { 'https://example.com/a.ts': [edit] } }, toClient), refused);
    });

    it('refuses file operations, malformed edits and out-of-range positions', () => {
        const edit = { range: range(0, 0, 1), newText: 'x' };
        for (const operation of [
            { kind: 'create', uri: fileUri(root, 'new.ts') },
            { kind: 'rename', oldUri: fileUri(root, 'a.ts'), newUri: fileUri(root, 'b.ts') },
            { kind: 'delete', uri: fileUri(root, 'a.ts') },
        ]) {
            assert.throws(() => mapWorkspaceEdit({ documentChanges: [{ textDocument: { uri: fileUri(root, 'a.ts') }, edits: [edit] }, operation] }, toClient), /creates, renames or deletes/);
        }
        assert.throws(() => mapWorkspaceEdit({ changes: { [fileUri(root, 'a.ts')]: [{ range: range(-1, 0, 1), newText: 'x' }] } }, toClient), /invalid range/);
        assert.throws(() => mapWorkspaceEdit({ changes: { [fileUri(root, 'a.ts')]: [{ range: range(0, 0, 1) }] } }, toClient), /malformed/);
        assert.throws(() => mapWorkspaceEdit('x', toClient), refused);
    });

    it('keeps code actions with an edit, drops commands and server data, disables refused edits', () => {
        const inside = { changes: { [fileUri(root, 'c.ts')]: [{ range: range(0, 0, 0), newText: 'import { greet } from "./a";\n' }] } };
        const actions = mapCodeActions([
            { title: 'Add import from "./a"', kind: 'quickfix', isPreferred: true, edit: inside, command: { title: '', command: '_typescript.applyCodeActionCommand', arguments: [{ documentUri: fileUri(root, 'c.ts') }] }, data: { file: '/abs' }, diagnostics: [] },
            { title: 'Organize imports', command: 'organize', arguments: [] },
            { title: 'Extract function', kind: 'refactor.extract', command: { title: 'x', command: '_typescript.applyRefactoring' } },
            { title: 'Touch a library', kind: 'quickfix', edit: { changes: { [fileUri(path.sep, 'usr', 'x.d.ts')]: [{ range: range(0, 0, 0), newText: 'x' }] } } },
        ], toClient);
        assert.deepEqual(actions, [
            { title: 'Add import from "./a"', kind: 'quickfix', isPreferred: true, edit: { changes: { 'codexr-file:/c.ts': inside.changes[fileUri(root, 'c.ts')] } } },
            { title: 'Touch a library', kind: 'quickfix', disabled: `${LSP_EDIT_REFUSED}: it changes a file outside the open folder.` },
        ]);
        assert.deepEqual(mapCodeActions(null, toClient), []);
    });

    it('routes each document answer to its mapper', () => {
        const location = { uri: fileUri(root, 'a.ts'), range: range(0, 0, 1) };
        assert.deepEqual(mapDocumentResult('textDocument/references', [location, { ...location, uri: fileUri(path.sep, 'lib.d.ts') }], toClient), [{ ...location, uri: 'codexr-file:/a.ts' }]);
        assert.deepEqual(mapDocumentResult('textDocument/rename', { changes: { [location.uri]: [{ range: location.range, newText: 'b' }] } }, toClient), { changes: { 'codexr-file:/a.ts': [{ range: location.range, newText: 'b' }] } });
        assert.deepEqual(mapDocumentResult('textDocument/prepareRename', range(0, 0, 3), toClient), range(0, 0, 3));
    });

    it('lists workspace symbols inside the folder only, without server data', () => {
        assert.deepEqual(mapWorkspaceSymbols([
            { name: 'greet', kind: 12, containerName: 'a', location: { uri: fileUri(root, 'a.ts'), range: range(0, 0, 2) }, data: { file: '/abs' } },
            { name: 'Array', kind: 5, location: { uri: fileUri(path.sep, 'usr', 'lib.d.ts'), range: range(0, 0, 2) } },
            { name: 'lazy', kind: 12, location: { uri: fileUri(root, 'b.ts') } },
            { kind: 12 },
        ], toClient), [{ name: 'greet', kind: 12, containerName: 'a', location: { uri: 'codexr-file:/a.ts', range: range(0, 0, 2) } }]);
    });
});

describe('LSP workspace edits in the renderer (#287)', () => {
    it('reads workspace paths from renderer URIs and refuses anything else', () => {
        assert.equal(clientUriPath('codexr-file:/src/my%20file%231.ts'), 'src/my file#1.ts');
        assert.equal(clientUriPath('codexr-file:///src/a.ts'), 'src/a.ts');
        for (const uri of ['file:///etc/passwd', 'codexr-file:/../x', 'codexr-file:/src/%2e%2e/%2e%2e/x', 'codexr-file:/a%5Cb', 'codexr-file:/C:%2Fwin', 'codexr-file://host/a.ts',
            'codexr-file:/a.ts?x', 'codexr-file:/', 'codexr-file:/a//b', 'codexr-file:/a%00', 'codexr-file:/%E0%A4%A', 42]) {
            assert.throws(() => clientUriPath(uri), refused, String(uri));
        }
    });

    it('turns an edit into the edits of each file, refusing file operations', () => {
        const edit = { range: range(0, 0, 5), newText: 'salute' };
        assert.deepEqual(workspaceEditFiles({ changes: { 'codexr-file:/a.ts': [edit], 'codexr-file:/b.ts': [] } }), [{ path: 'a.ts', edits: [edit] }]);
        assert.deepEqual(workspaceEditFiles({ documentChanges: [{ textDocument: { uri: 'codexr-file:/a.ts', version: 1 }, edits: [edit] }] }), [{ path: 'a.ts', edits: [edit] }]);
        assert.throws(() => workspaceEditFiles({ documentChanges: [{ kind: 'create', uri: 'codexr-file:/n.ts' }] }), /creates, renames or deletes/);
        assert.throws(() => workspaceEditFiles({ changes: { 'file:///etc/passwd': [edit] } }), refused);
        assert.throws(() => workspaceEditFiles({ changes: { 'codexr-file:/a.ts': [{ range: range(0, -1, 0), newText: '' }] } }), /invalid range/);
        assert.throws(() => workspaceEditFiles(null), refused);
        assert.deepEqual(workspaceEditFiles({}), []);
    });

    it('applies text edits against the original text, in any order, with every line break', () => {
        const text = 'export function greet() {}\r\nconst x = greet();\nconst y = greet();\r';
        const edits = [
            { range: range(2, 10, 15), newText: 'salute' },
            { range: range(0, 16, 21), newText: 'salute' },
            { range: range(1, 10, 15), newText: 'salute' },
        ];
        assert.equal(applyTextEdits(text, edits), 'export function salute() {}\r\nconst x = salute();\nconst y = salute();\r');
        assert.equal(applyTextEdits('a\nb', [{ range: range(0, 0, 0), newText: 'import x;\n' }, { range: range(0, 0, 0), newText: '// two\n' }]), 'import x;\n// two\na\nb', 'inserts at one place keep their order');
        assert.equal(applyTextEdits('ab\ncd', [{ range: range(0, 99, 99), newText: '!' }, { range: range(9, 0, 9), newText: '?' }]), 'ab!\ncd?', 'past the end of a line or of the text');
        assert.equal(applyTextEdits('one\ntwo\n', [{ range: { start: { line: 0, character: 1 }, end: { line: 1, character: 2 } }, newText: '' }]), 'oo\n', 'across lines');
        assert.throws(() => applyTextEdits('abcdef', [{ range: range(0, 0, 3), newText: '' }, { range: range(0, 2, 4), newText: '' }]), /overlap/);
    });

    it('words the outcome', () => {
        assert.equal(fileCount(1), '1 file');
        assert.equal(fileCount(2), '2 files');
        assert.equal(refusalReason(new Error(`Error invoking remote method 'codexr:lsp:request': Error: ${LSP_EDIT_REFUSED}: it changes a file outside the open folder.`)), `${LSP_EDIT_REFUSED}: it changes a file outside the open folder.`);
    });
});

describe('LSP to Monaco conversions for refactoring (#287)', () => {
    it('converts ranges, highlights and rename locations', () => {
        assert.deepEqual(toLspRange({ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 8 }), range(1, 2, 7));
        assert.deepEqual(toHighlights([{ range: range(0, 0, 1) }, { range: range(0, 0, 1), kind: 2 }, { range: range(0, 0, 1), kind: 3 }]).map((h) => h.kind), [0, 1, 2]);
        assert.deepEqual(toRenameRange(range(1, 17, 22)), { range: { startLineNumber: 2, startColumn: 18, endLineNumber: 2, endColumn: 23 } });
        assert.deepEqual(toRenameRange({ range: range(0, 0, 3), placeholder: 'abc' }), { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, placeholder: 'abc' });
        assert.equal(toRenameRange({ defaultBehavior: true }), 'default');
        assert.equal(toRenameRange(null), null);
    });

    it('converts signature help', () => {
        const help = toSignatureHelp({
            activeSignature: 0,
            activeParameter: 1,
            signatures: [{ label: 'greet(name: string, times: number): string', documentation: { kind: 'markdown', value: 'Says hi.' }, parameters: [{ label: 'name: string' }, { label: [20, 33], documentation: 'How often.' }] }],
        });
        assert.deepEqual(help, {
            activeSignature: 0,
            activeParameter: 1,
            signatures: [{ label: 'greet(name: string, times: number): string', documentation: { value: 'Says hi.' }, parameters: [{ label: 'name: string' }, { label: [20, 33], documentation: { value: 'How often.' } }] }],
        });
        assert.equal(toSignatureHelp({ signatures: [], activeSignature: 0, activeParameter: 0 }), null);
        assert.equal(toSignatureHelp(null), null);
    });

    it('sends markers back as diagnostics, with numeric codes as numbers', () => {
        assert.deepEqual(toLspDiagnostic({ startLineNumber: 1, startColumn: 18, endLineNumber: 1, endColumn: 23, severity: 8, message: "Cannot find name 'greet'.", source: 'typescript', code: '2304' }),
            { range: range(0, 17, 22), message: "Cannot find name 'greet'.", severity: 1, source: 'typescript', code: 2304 });
        assert.deepEqual(toLspDiagnostic({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2, severity: 4, message: 'x', code: { value: 'reportMissingImports' } }),
            { range: range(0, 0, 1), message: 'x', severity: 2, code: 'reportMissingImports' });
    });

    it('reads code actions and workspace symbols', () => {
        assert.deepEqual(toCodeActions([{ title: 'Fix', kind: 'quickfix', isPreferred: true, edit: { changes: {} } }, { kind: 'x' }, null]), [{ title: 'Fix', kind: 'quickfix', isPreferred: true, edit: { changes: {} } }]);
        assert.deepEqual(toWorkspaceSymbolItems([
            { name: 'greet', kind: 12, containerName: 'a', location: { uri: 'codexr-file:/src/a.ts', range: range(4, 2, 9) } },
            { name: 'bad', kind: 12, location: { uri: 'file:///etc/passwd', range: range(0, 0, 1) } },
        ], clientUriPath), [{ name: 'greet', kind: 11, container: 'a', path: 'src/a.ts', line: 5, column: 3 }]);
    });
});

describe('Quick open workspace symbols (#287)', () => {
    const base: PaletteContext = { commands: [], isEnabled: () => true, recent: [], formatKey: (key) => key, lineCount: null, hasFolder: true };

    it('lists the servers\' symbols for "#", best match first, and opens one at its name', () => {
        const symbols = [
            { name: 'greeting', container: '', path: 'src/b.ts', line: 3, column: 1 },
            { name: 'greet', container: 'module', path: 'src/a.ts', line: 1, column: 17 },
            { name: 'agreement', container: '', path: 'src/c.ts', line: 1, column: 1 },
        ];
        const view = paletteView('#greet', { ...base, workspaceSymbols: { query: 'greet', items: symbols } });
        assert.deepEqual(view.entries.map((entry) => entry.label), ['greet', 'greeting', 'agreement']);
        assert.equal(view.entries[0]?.description, 'module · src/a.ts');
        const first = view.entries[0];
        assert.ok(first);
        assert.deepEqual(view.action(first), { kind: 'symbol', path: 'src/a.ts', line: 1, column: 17, length: 5 });
    });

    it('says what it is waiting for', () => {
        assert.match(paletteView('#', base).empty, /Type the name/);
        assert.match(paletteView('#gr', { ...base, workspaceSymbols: { query: 'gr', items: null } }).empty, /Searching/);
        assert.match(paletteView('#gr', { ...base, workspaceSymbols: { query: 'g', items: [] } }).empty, /Searching/, 'an answer to an older query is not shown');
        assert.match(paletteView('#gr', { ...base, workspaceSymbols: { query: 'gr', items: [] } }).empty, /No matching symbols/);
        assert.match(paletteView('#gr', { ...base, hasFolder: false }).empty, /Open a folder/);
        assert.ok(paletteView('', base).entries.some((entry) => entry.fill === '#'), 'a hint row for "#"');
    });

    it('asks the servers after a pause and keeps only the latest answer', async () => {
        const asked: string[] = [];
        const answers = new Map<string, (items: { name: string; container: string; path: string; line: number; column: number }[]) => void>();
        let loaded = 0;
        const search = createWorkspaceSymbolSearch((query) => {
            asked.push(query);
            return new Promise((resolve) => answers.set(query, resolve));
        }, () => { loaded++; }, 5);
        assert.deepEqual(search.state(''), { query: '', items: [] });
        assert.equal(search.state('g').items, null);
        assert.equal(search.state('gr').items, null);
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(asked, ['gr'], 'typing quickly asks once');
        answers.get('gr')?.([{ name: 'greet', container: '', path: 'a.ts', line: 1, column: 1 }]);
        await Promise.resolve();
        assert.equal(loaded, 1);
        assert.equal(search.state('gr').items?.length, 1);
        search.state('gre');
        search.reset();
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(asked, ['gr'], 'a reset cancels the pending question');
    });
});
