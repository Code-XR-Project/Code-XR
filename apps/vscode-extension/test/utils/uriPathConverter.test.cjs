const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const url = require('node:url');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

// Characterization of convertToFileSystemPath and
// getFileSystemPathFromEditorOrInput (ROADMAP W4-T14, hotspots-ts/CPLX-15'):
// which input shape wins, in which order, and what an empty result does.
// Uri behaviour comes from the fake vscode (file: URIs resolve through
// node:url, so expectations are built the same way and stay OS-agnostic).

const MODULE = 'utils/uriPathConverter.js';
const filePath = path.resolve('/repo/src/a.ts');
const fileUri = url.pathToFileURL(filePath).toString();

async function withConverter(callback, editorPath) {
    const fake = createFakeVscode();
    if (editorPath !== undefined) {
        fake.vscode.window.activeTextEditor = { document: { uri: fake.vscode.Uri.file(editorPath) } };
    }
    return withFakeVscode(fake, ({ requireOut }) => callback(requireOut(MODULE), fake));
}

test('convertToFileSystemPath: falsy inputs, plain strings and URI strings', async () => {
    await withConverter(({ convertToFileSystemPath }) => {
        for (const input of [null, undefined, '', 0, false, NaN]) {
            assert.equal(convertToFileSystemPath(input), null, String(input));
        }
        // a plain string is returned unchanged, untrimmed and unnormalized
        assert.equal(convertToFileSystemPath('  rel/../x.py '), '  rel/../x.py ');
        assert.equal(convertToFileSystemPath(fileUri), filePath);
        // a non-falsy primitive that is neither string nor object
        assert.equal(convertToFileSystemPath(42), null);
        assert.equal(convertToFileSystemPath(true), null);
        // an unparseable URI string is swallowed into null
        assert.equal(convertToFileSystemPath('file://%zz'), null);
    });
});

test('convertToFileSystemPath: object inputs, in precedence order', async () => {
    await withConverter(({ convertToFileSystemPath }, fake) => {
        const uri = fake.vscode.Uri.file(filePath);
        assert.equal(convertToFileSystemPath(uri), filePath);
        // a string fsPath wins, even an empty one (it is returned, not skipped)
        assert.equal(convertToFileSystemPath({ fsPath: '' }), '');
        assert.equal(convertToFileSystemPath({ fsPath: '/x', scheme: 'file', path: '/y' }), '/x');
        // a non-string fsPath falls through to scheme + path
        assert.equal(convertToFileSystemPath({ fsPath: 5, scheme: 'file', path: '/y' }), '/y');
        assert.equal(convertToFileSystemPath({ scheme: 'file', path: '/z' }), '/z');
        // scheme without path (or path without scheme) falls through to String(input)
        assert.equal(convertToFileSystemPath({ scheme: 'file' }), null);
        assert.equal(convertToFileSystemPath({ path: '/z', toString: () => fileUri }), filePath);
        assert.equal(convertToFileSystemPath({ toString: () => 'plain' }), null);
        assert.equal(convertToFileSystemPath({}), null);
        assert.equal(convertToFileSystemPath([]), null);
        // a toString that throws is swallowed into null
        assert.equal(convertToFileSystemPath({ toString() { throw new Error('boom'); } }), null);
    });
});

test('getFileSystemPathFromEditorOrInput: input first, then the active editor, then null', async () => {
    const editorPath = path.resolve('/repo/editor.py');
    await withConverter(({ getFileSystemPathFromEditorOrInput }) => {
        assert.equal(getFileSystemPathFromEditorOrInput(fileUri), filePath);
        assert.equal(getFileSystemPathFromEditorOrInput(), editorPath);
        assert.equal(getFileSystemPathFromEditorOrInput({}), editorPath);
        // an empty conversion result is falsy, so the editor wins
        assert.equal(getFileSystemPathFromEditorOrInput({ fsPath: '' }), editorPath);
    }, editorPath);
    await withConverter(({ getFileSystemPathFromEditorOrInput }) => {
        assert.equal(getFileSystemPathFromEditorOrInput(), null);
        assert.equal(getFileSystemPathFromEditorOrInput({ fsPath: '' }), null);
        assert.equal(getFileSystemPathFromEditorOrInput('p.py'), 'p.py');
    });
});
