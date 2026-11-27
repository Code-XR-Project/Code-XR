/**
 * #178: "Reveal in XR scene", server side. The scene side is
 * test/analysis/sceneReveal.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scenePathOf, revealInScene, REVEAL_IN_SCENE_MESSAGE } = require('../../out/core/server/analysis/sceneReveal.js');
const { getActiveServerRegistry } = require('../../out/core/server/registry/activeServerRegistry.js');

test('#178 the scene path of a file is relative to the analysed folder, with forward slashes', () => {
    const root = path.resolve('/work', 'project');
    assert.equal(REVEAL_IN_SCENE_MESSAGE, 'reveal-in-scene');
    assert.equal(scenePathOf(root, path.join(root, 'src', 'a.py')), 'src/a.py');
    assert.equal(scenePathOf(root, path.join(root, 'a.py')), 'a.py');
    assert.equal(scenePathOf(path.join(root, 'src') + path.sep, path.join(root, 'src', 'deep', 'b.ts')), 'deep/b.ts');
    assert.equal(scenePathOf(root, root), null, 'the folder itself is not a file of it');
    assert.equal(scenePathOf(root, path.resolve('/work', 'project-two', 'a.py')), null, 'a sibling with the same prefix');
    assert.equal(scenePathOf(root, path.resolve('/work', 'other.py')), null);
});

test('#178 every running scene that holds the file is asked, the others are not', () => {
    const registry = getActiveServerRegistry();
    const original = registry.getServersByStatus;
    const asked = [];
    const server = (name, answer) => ({ id: name, serverInstance: { revealInScene: (file) => { asked.push([name, file]); return answer; } } });
    registry.getServersByStatus = (status) => (status === 'running'
        ? [server('holds', true), server('elsewhere', false), { serverInstance: {} }, {}]
        : []);
    try {
        assert.equal(revealInScene('/work/project/src/a.py'), 1);
        assert.deepEqual(asked, [['holds', '/work/project/src/a.py'], ['elsewhere', '/work/project/src/a.py']]);
        asked.length = 0;
        assert.equal(revealInScene('/work/project/src/a.py', ['elsewhere']), 0, 'the IDE asks its own window\'s scene only');
        assert.deepEqual(asked, [['elsewhere', '/work/project/src/a.py']]);
    } finally {
        registry.getServersByStatus = original;
    }
    assert.equal(revealInScene('/work/project/src/a.py'), 0, 'no running server');
});
