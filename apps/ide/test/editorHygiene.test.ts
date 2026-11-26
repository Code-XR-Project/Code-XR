import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { editorConfigFolders, globToRegExp, parseEditorConfig, resolveEditorConfig } from '../src/renderer/editor/editorConfig.ts';
import { indentationOf, saveRules, whitespaceEdits, type LineEdit } from '../src/renderer/editor/saveTransforms.ts';

/** Applies line edits the way Monaco would (they never overlap). */
function apply(lines: readonly string[], edits: readonly LineEdit[], eol = '\n'): string {
    const out = [...lines];
    for (const edit of [...edits].sort((a, b) => b.line - a.line || b.startColumn - a.startColumn)) {
        const text = out[edit.line - 1] ?? '';
        out[edit.line - 1] = text.slice(0, edit.startColumn - 1) + edit.text + text.slice(edit.endColumn - 1);
    }
    return out.join(eol);
}

describe('.editorconfig globs (#170)', () => {
    const cases: Array<[string, string, boolean]> = [
        ['*', 'a.ts', true],
        ['*', 'src/deep/a.ts', true],
        ['*.ts', 'src/a.ts', true],
        ['*.ts', 'src/a.tsx', false],
        ['*.{js,ts}', 'lib/x.js', true],
        ['*.{js,ts}', 'lib/x.py', false],
        ['{package.json,.travis.yml}', 'package.json', true],
        ['lib/**.js', 'lib/a/b/c.js', true],
        ['lib/**.js', 'src/lib/a.js', false],
        ['/src/*.py', 'src/a.py', true],
        ['/src/*.py', 'src/sub/a.py', false],
        ['**/test/*.ts', 'test/a.ts', true],
        ['**/test/*.ts', 'x/y/test/a.ts', true],
        ['file?.txt', 'file1.txt', true],
        ['file?.txt', 'file10.txt', false],
        ['[abc].md', 'b.md', true],
        ['[!abc].md', 'b.md', false],
        ['v{1..3}.txt', 'v2.txt', true],
        ['v{1..3}.txt', 'v4.txt', false],
        ['Makefile', 'sub/Makefile', true],
        ['a.b', 'axb', false],
    ];
    for (const [glob, path, expected] of cases) {
        it(`${glob} ${expected ? 'matches' : 'does not match'} ${path}`, () => {
            assert.equal(globToRegExp(glob).test(path), expected);
        });
    }
});

describe('.editorconfig resolution (#170)', () => {
    const rootConfig = parseEditorConfig([
        '# top',
        'root = true',
        '',
        '[*]',
        'indent_style = space',
        'indent_size = 4',
        'end_of_line = lf',
        'insert_final_newline = true',
        'trim_trailing_whitespace = true',
        '',
        '[*.{json,yml}]',
        'indent_size = 2',
        '',
        '[Makefile]',
        'indent_style = tab',
        '',
        '[*.md]',
        'trim_trailing_whitespace = false',
    ].join('\n'));

    it('parses root, sections and properties', () => {
        assert.equal(rootConfig.root, true);
        assert.deepEqual(rootConfig.sections.map((section) => section.glob), ['*', '*.{json,yml}', 'Makefile', '*.md']);
        assert.deepEqual(parseEditorConfig('junk\n[x]\n=nothing\nkey value').sections, [{ glob: 'x', properties: {} }]);
    });

    it('applies matching sections in order', () => {
        const found = [{ folder: '', file: rootConfig }];
        assert.deepEqual(resolveEditorConfig(found, 'src/a.ts'), {
            insertSpaces: true, indentSize: 4, tabWidth: 4, endOfLine: 'lf', trimTrailingWhitespace: true, insertFinalNewline: true,
        });
        assert.equal(resolveEditorConfig(found, 'package.json').indentSize, 2);
        assert.equal(resolveEditorConfig(found, 'README.md').trimTrailingWhitespace, false);
        const make = resolveEditorConfig(found, 'Makefile');
        assert.deepEqual([make.insertSpaces, make.indentSize], [false, 4]);
    });

    it('lets a closer file win and stops at root = true', () => {
        const sub = parseEditorConfig('[*.ts]\nindent_size = 2\ncharset = utf-8-bom');
        const nestedRoot = parseEditorConfig('root=true\n[*]\nindent_style=tab');
        assert.equal(resolveEditorConfig([{ folder: 'web', file: sub }, { folder: '', file: rootConfig }], 'web/a.ts').indentSize, 2);
        assert.equal(resolveEditorConfig([{ folder: 'web', file: sub }, { folder: '', file: rootConfig }], 'web/a.ts').bom, true);
        assert.equal(resolveEditorConfig([{ folder: 'web', file: sub }, { folder: '', file: rootConfig }], 'api/a.ts').indentSize, 4);
        const hidden = resolveEditorConfig([{ folder: '', file: rootConfig }, { folder: 'vendor', file: nestedRoot }], 'vendor/x.c');
        assert.deepEqual([hidden.insertSpaces, hidden.trimTrailingWhitespace], [false, undefined]);
    });

    it('understands unset, tab sizes and ignores what it cannot honour', () => {
        const config = parseEditorConfig('[*]\nindent_style = tab\ntab_width = 8\nindent_size = tab\nend_of_line = cr\ncharset = latin1\n[*.py]\nindent_style = unset');
        assert.deepEqual(resolveEditorConfig([{ folder: '', file: config }], 'a.c'), { insertSpaces: false, indentSize: 8, tabWidth: 8 });
        assert.deepEqual(resolveEditorConfig([{ folder: '', file: config }], 'a.py'), { indentSize: 8, tabWidth: 8 });
        assert.deepEqual(resolveEditorConfig([{ folder: '', file: parseEditorConfig('[*]\nindent_size = 400') }], 'a'), {});
    });

    it('lists the folders to look in, the root first', () => {
        assert.deepEqual(editorConfigFolders('a.ts'), ['']);
        assert.deepEqual(editorConfigFolders('src/web/a.ts'), ['', 'src', 'src/web']);
    });
});

describe('save transforms (#170)', () => {
    it('lets .editorconfig override the settings', () => {
        const settings = { trimTrailingWhitespace: false, insertFinalNewline: true, formatOnSave: true };
        assert.deepEqual(saveRules(settings, {}), { ...settings });
        assert.deepEqual(saveRules(settings, { trimTrailingWhitespace: true, insertFinalNewline: false, endOfLine: 'crlf', bom: false }), {
            trimTrailingWhitespace: true, insertFinalNewline: false, formatOnSave: true, endOfLine: 'crlf', bom: false,
        });
        assert.equal(indentationOf({ endOfLine: 'lf' }), null);
        assert.deepEqual(indentationOf({ insertSpaces: true, indentSize: 2, tabWidth: 2 }), { insertSpaces: true, tabSize: 2, indentSize: 2 });
    });

    it('trims trailing whitespace and adds the final newline', () => {
        const lines = ['const a = 1;  ', '\t', 'b\t ', 'end'];
        const rules = { trimTrailingWhitespace: true, insertFinalNewline: true };
        assert.equal(apply(lines, whitespaceEdits(lines, rules, '\n')), 'const a = 1;\n\nb\nend\n');
        assert.deepEqual(whitespaceEdits(['clean', ''], rules, '\n'), []);
        // A last line of spaces only becomes empty: the file already ends with a newline.
        assert.equal(apply(['a', '   '], whitespaceEdits(['a', '   '], rules, '\n')), 'a\n');
        assert.equal(apply(['a  '], whitespaceEdits(['a  '], { trimTrailingWhitespace: false, insertFinalNewline: true }, '\r\n'), '\r\n'), 'a  \r\n');
        assert.deepEqual(whitespaceEdits(['a '], { trimTrailingWhitespace: false, insertFinalNewline: false }, '\n'), []);
    });

    it('leaves the lines being typed on alone during an auto save', () => {
        const lines = ['one ', 'two ', 'three'];
        const edits = whitespaceEdits(lines, { trimTrailingWhitespace: true, insertFinalNewline: true }, '\n', new Set([2, 3]));
        assert.equal(apply(lines, edits), 'one\ntwo \nthree');
    });
});
