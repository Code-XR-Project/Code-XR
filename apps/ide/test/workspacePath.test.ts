import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { childPath, folderArgument, isInside, parentPath, parseWorkspacePath, resolveInWorkspace, validateEntryName } from '../src/main/workspace/workspacePath.ts';

describe('parseWorkspacePath', () => {
    it('accepts the root and plain relative paths', () => {
        assert.deepEqual(parseWorkspacePath(''), []);
        assert.deepEqual(parseWorkspacePath('src'), ['src']);
        assert.deepEqual(parseWorkspacePath('src/main/index.ts'), ['src', 'main', 'index.ts']);
        assert.deepEqual(parseWorkspacePath('.gitignore'), ['.gitignore']);
        assert.deepEqual(parseWorkspacePath('a..b/c'), ['a..b', 'c']);
    });

    const refused: Array<[string, unknown]> = [
        ['a parent segment', '../outside'],
        ['an inner parent segment', 'src/../../outside'],
        ['a dot segment', './src'],
        ['an absolute POSIX path', '/etc/passwd'],
        ['a drive letter', 'C:/Windows'],
        ['a drive-relative path', 'C:Windows'],
        ['a backslash', 'src\\..\\..'],
        ['a NUL byte', 'src\0.ts'],
        ['an empty segment', 'src//index.ts'],
        ['a trailing slash', 'src/'],
        ['a non-string', 42],
        ['an over-long path', 'a/'.repeat(3000) + 'b'],
    ];
    for (const [name, input] of refused) {
        it(`refuses ${name}`, () => {
            assert.throws(() => parseWorkspacePath(input));
        });
    }
});

describe('resolveInWorkspace', () => {
    const root = path.resolve('/tmp/project');
    it('joins inside the root', () => {
        assert.equal(resolveInWorkspace(root, 'src/a.ts'), path.join(root, 'src', 'a.ts'));
        assert.equal(resolveInWorkspace(root, ''), root);
    });
    it('refuses traversal', () => {
        assert.throws(() => resolveInWorkspace(root, '../project-other/a.ts'));
    });
});

describe('isInside', () => {
    const root = path.resolve('/tmp/project');
    it('tells inside from outside, including a sibling sharing a prefix', () => {
        assert.equal(isInside(root, root), true);
        assert.equal(isInside(root, path.join(root, 'a', 'b')), true);
        assert.equal(isInside(root, path.resolve('/tmp/project-other')), false);
        assert.equal(isInside(root, path.resolve('/tmp')), false);
    });
});

describe('childPath and folderArgument', () => {
    it('joins with / from the root', () => {
        assert.equal(childPath('', 'src'), 'src');
        assert.equal(childPath('src', 'main'), 'src/main');
    });
    it('reads the last --folder= flag', () => {
        assert.equal(folderArgument(['electron', '.', '--folder=/a', '--folder=/b']), '/b');
        assert.equal(folderArgument(['electron', '.']), undefined);
        assert.equal(folderArgument(['--folder=']), undefined);
    });
});

describe('validateEntryName', () => {
    for (const name of ['main.ts', 'README', '.env', 'a b', 'ñandú.txt', 'x'.repeat(255)]) {
        it(`accepts ${JSON.stringify(name.length > 20 ? `${name.slice(0, 8)}...` : name)}`, () => {
            assert.equal(validateEntryName(name), name);
        });
    }
    for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a:b', 'what?', 'star*', 'pipe|', '<x>', 'quote"', 'tab\t', 'dot.', 'space ', 'CON', 'nul.txt', 'com1', 'LPT9.log', 'x'.repeat(256), 3]) {
        it(`refuses ${JSON.stringify(typeof name === 'string' && name.length > 20 ? `${name.slice(0, 8)}...` : name)}`, () => {
            assert.throws(() => validateEntryName(name));
        });
    }
});

describe('parentPath', () => {
    it('drops the last segment', () => {
        assert.equal(parentPath('src/main/ipc.ts'), 'src/main');
        assert.equal(parentPath('README.md'), '');
        assert.equal(parentPath(''), '');
        assert.throws(() => parentPath('../x'));
    });
});
