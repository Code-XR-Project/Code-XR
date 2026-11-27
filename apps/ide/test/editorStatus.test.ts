import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { editorStatusTexts, eolChoices, indentationChoices, languageChoices, languageName, type EditorStatusState } from '../src/renderer/editor/editorStatusModel.ts';
import { pickListView } from '../src/renderer/commands/paletteModel.ts';

const state: EditorStatusState = {
    line: 12, column: 5, selectedChars: 0, selections: 1, insertSpaces: true, tabSize: 4,
    eol: 'LF', bom: false, languageId: 'typescript', languageName: 'TypeScript',
};

describe('editor status bar (#166)', () => {
    it('says where the cursor is, with the selection', () => {
        assert.equal(editorStatusTexts(state).position, 'Ln 12, Col 5');
        assert.equal(editorStatusTexts({ ...state, selectedChars: 7 }).position, 'Ln 12, Col 5 (7 selected)');
        assert.equal(editorStatusTexts({ ...state, selections: 3, selectedChars: 9 }).position, 'Ln 12, Col 5 (3 selections)');
    });

    it('names the indentation, encoding, line endings and language as VS Code does', () => {
        const texts = editorStatusTexts(state);
        assert.equal(texts.indentation, 'Spaces: 4');
        assert.equal(editorStatusTexts({ ...state, insertSpaces: false, tabSize: 8 }).indentation, 'Tab Size: 8');
        assert.equal(texts.encoding, 'UTF-8');
        assert.equal(editorStatusTexts({ ...state, bom: true }).encoding, 'UTF-8 with BOM');
        assert.equal(texts.eol, 'LF');
        assert.equal(texts.language, 'TypeScript');
    });

    it('offers LF and CRLF, marking the current one', () => {
        const choices = eolChoices('CRLF');
        assert.deepEqual(choices.map((choice) => choice.value), ['LF', 'CRLF']);
        assert.match(choices[1]?.description ?? '', /current/);
        assert.doesNotMatch(choices[0]?.description ?? '', /current/);
    });

    it('offers spaces and tabs at 2, 4 and 8, marking the current one', () => {
        const choices = indentationChoices({ insertSpaces: true, tabSize: 4 });
        assert.equal(choices.length, 6);
        assert.deepEqual(choices.filter((choice) => choice.description === '(current)').map((choice) => choice.id), ['spaces-4']);
        assert.deepEqual(choices.find((choice) => choice.id === 'tabs-2')?.value, { insertSpaces: false, tabSize: 2 });
    });

    it('lists languages by their display name, with extensions, the current one marked', () => {
        const choices = languageChoices([
            { id: 'typescript', aliases: ['TypeScript', 'ts'], extensions: ['.ts', '.tsx', '.cts', '.mts', '.x'] },
            { id: 'abap', aliases: ['abap', 'ABAP'], extensions: ['.abap'] },
            { id: 'plaintext', extensions: ['.txt'] },
        ], 'typescript');
        assert.deepEqual(choices.map((choice) => choice.label), ['abap', 'plaintext', 'TypeScript']);
        assert.equal(choices[2]?.description, '.ts, .tsx, .cts, .mts (current)');
        assert.equal(languageName(undefined, 'zig'), 'zig');
    });

    it('filters a picker by fuzzy match, and returns the picked id', () => {
        const items = [{ id: 'LF', label: 'LF' }, { id: 'CRLF', label: 'CRLF' }];
        assert.deepEqual(pickListView(items, '').entries.map((entry) => entry.id), ['LF', 'CRLF']);
        const view = pickListView(items, 'cr');
        assert.deepEqual(view.entries.map((entry) => entry.id), ['CRLF']);
        assert.deepEqual(view.action(view.entries[0]!), { kind: 'pick', id: 'CRLF' });
        assert.equal(pickListView(items, 'zz').entries.length, 0);
    });
});
