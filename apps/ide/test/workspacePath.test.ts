import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { childPath, folderArgument, isInside, parseWorkspacePath, resolveInWorkspace } from '../src/main/workspace/workspacePath.ts';

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
