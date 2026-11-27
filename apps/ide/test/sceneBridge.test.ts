import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { toSceneEditorTarget } from '../src/shared/sceneBridge.ts';
import { sceneTargetToWorkspacePath } from '../src/main/analysis/sceneEditorTarget.ts';

describe('scene bridge: what an analysis page may ask to open (#16)', () => {
    it('accepts a path and an optional 1-based line', () => {
        assert.deepEqual(toSceneEditorTarget({ path: 'src/a.ts', line: 12 }), { path: 'src/a.ts', line: 12 });
        assert.deepEqual(toSceneEditorTarget({ path: 'src/a.ts' }), { path: 'src/a.ts' });
        assert.deepEqual(toSceneEditorTarget({ path: 'src/a.ts', line: 0 }), { path: 'src/a.ts' });
        assert.deepEqual(toSceneEditorTarget({ path: 'src/a.ts', line: 1.5 }), { path: 'src/a.ts' });
        assert.deepEqual(toSceneEditorTarget({ path: 'src/a.ts', line: '3' }), { path: 'src/a.ts' });
    });

    it('refuses anything that is not a plain path', () => {
        for (const value of [null, undefined, 'src/a.ts', 42, {}, { path: '' }, { path: 7 }, { path: 'a\0b' }, { path: 'x'.repeat(5000) }]) {
            assert.equal(toSceneEditorTarget(value), null, JSON.stringify(value));
        }
    });

    const root = path.resolve('/work/project');

    it('resolves a node path against the analysed folder', () => {
        assert.equal(sceneTargetToWorkspacePath(root, root, 'src/a.ts'), 'src/a.ts');
        assert.equal(sceneTargetToWorkspacePath(root, root, './src/a.ts'), 'src/a.ts');
        assert.equal(sceneTargetToWorkspacePath(root, root, 'src\\win\\b.py'), 'src/win/b.py');
        assert.equal(sceneTargetToWorkspacePath(root, path.join(root, 'pkg'), 'mod/c.py'), 'pkg/mod/c.py');
    });

    it('accepts an absolute path inside the open folder (a LivePanel row)', () => {
        assert.equal(sceneTargetToWorkspacePath(root, root, path.join(root, 'lib', 'd.js')), 'lib/d.js');
    });

    it('refuses anything outside the open folder', () => {
        assert.equal(sceneTargetToWorkspacePath(root, root, '../secret.txt'), null);
        assert.equal(sceneTargetToWorkspacePath(root, root, 'src/../../secret.txt'), null);
        assert.equal(sceneTargetToWorkspacePath(root, root, path.resolve('/etc/passwd')), null);
        assert.equal(sceneTargetToWorkspacePath(root, root, path.resolve('/work/project-other/a.ts')), null);
        assert.equal(sceneTargetToWorkspacePath(root, root, '.'), null);
    });
});
