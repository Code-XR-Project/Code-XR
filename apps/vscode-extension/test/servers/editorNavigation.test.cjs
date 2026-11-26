const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isLoopbackAddress, parseOpenInEditorPayload, resolveEditorTarget } = require('../../out/core/server/analysis/editorNavigation.js');

test('open-in-editor payloads: a path and an optional 1-based line (#16)', () => {
    assert.deepEqual(parseOpenInEditorPayload({ path: 'src/a.ts', line: 4 }), { path: 'src/a.ts', line: 4 });
    assert.deepEqual(parseOpenInEditorPayload({ path: 'src/a.ts', line: 0 }), { path: 'src/a.ts' });
    assert.deepEqual(parseOpenInEditorPayload({ path: 'src/a.ts', line: '4' }), { path: 'src/a.ts' });
    for (const value of [null, 'src/a.ts', {}, { path: '' }, { path: 3 }, { path: 'a\0b' }, { path: 'x'.repeat(5000) }]) {
        assert.equal(parseOpenInEditorPayload(value), null, JSON.stringify(value));
    }
});

test('open-in-editor resolves only existing files inside the analysis and an open folder', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-nav-')));
    const workspace = path.join(base, 'project');
    const analysed = path.join(workspace, 'pkg');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(analysed, 'src'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(analysed, 'src', 'a.py'), 'x = 1\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'no\n');
    try {
        const file = path.join(analysed, 'src', 'a.py');
        assert.equal(resolveEditorTarget(analysed, [workspace], 'src/a.py'), file);
        assert.equal(resolveEditorTarget(analysed, [workspace], './src\\a.py'), file);
        assert.equal(resolveEditorTarget(analysed, [workspace], file), file);
        assert.equal(resolveEditorTarget(analysed, [workspace], 'src/missing.py'), null);
        assert.equal(resolveEditorTarget(analysed, [workspace], 'src'), null, 'a folder is not opened');
        assert.equal(resolveEditorTarget(analysed, [workspace], '../../outside/secret.txt'), null);
        assert.equal(resolveEditorTarget(analysed, [workspace], path.join(outside, 'secret.txt')), null);
        assert.equal(resolveEditorTarget(analysed, [outside], 'src/a.py'), null, 'not in an open workspace folder');
        try {
            fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(analysed, 'link.txt'));
            assert.equal(resolveEditorTarget(analysed, [workspace], 'link.txt'), null, 'a symlink leading out is refused');
        } catch (error) {
            if (error.code !== 'EPERM') { throw error; }
        }
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('only loopback socket addresses count as this machine', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
        assert.equal(isLoopbackAddress(address), true, address);
    }
    for (const address of [undefined, '', '192.168.1.20', '::ffff:10.0.0.4', '10.0.0.1', 'fe80::1']) {
        assert.equal(isLoopbackAddress(address), false, String(address));
    }
});

async function withHost(body) {
    const { createFakeVscode, withFakeVscode } = require('../helpers/fakeVscode.cjs');
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-nav-host-')));
    fs.mkdirSync(path.join(base, 'src'));
    fs.writeFileSync(path.join(base, 'src', 'a.py'), 'x = 1\n');
    try {
        await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
            const registry = requireOut('core/host/hostRegistry.js');
            const opened = [];
            registry.resetHostForTests();
            registry.initializeHost({
                workspaceFolders: () => [base],
                openInEditor: async (file, line) => { opened.push([file, line]); return true; },
            });
            try {
                const { handleOpenInEditorMessage } = requireOut('core/server/analysis/editorNavigation.js');
                const replies = [];
                const send = (local, payload, root = base) => handleOpenInEditorMessage(
                    { local, send: (reply) => replies.push(reply.type) }, payload, root);
                await body({ send, opened, replies, base });
            } finally {
                registry.resetHostForTests();
            }
        });
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
}

test('open-in-editor from this machine opens the analysed file at its line', async () => {
    await withHost(async ({ send, opened, replies, base }) => {
        assert.equal(await send(true, { path: 'src/a.py', line: 3 }), true);
        assert.deepEqual(opened, [[path.join(base, 'src', 'a.py'), 3]]);
        assert.deepEqual(replies, []);
    });
});

test('open-in-editor is refused for a guest, outside the analysis, a bad payload or no session', async () => {
    await withHost(async ({ send, opened, replies }) => {
        await send(false, { path: 'src/a.py' });
        await send(true, { path: '../../etc/passwd' });
        await send(true, { path: 'src/missing.py' });
        await send(true, { nope: 1 });
        await send(true, { path: 'src/a.py' }, null);
        assert.deepEqual(opened, []);
        assert.equal(replies.length, 5);
        assert.ok(replies.every((type) => type === 'open-in-editor-refused'));
    });
});
