'use strict';

/**
 * Behavioural characterization of the two scene assets that are not a plain
 * single-file runtime: the XR room (a runtime plus a texture directory, both
 * required by every entry point) and the static guide.html page (read and
 * written as UTF-8 text, with no existence check of its own).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const components = require('../helpers/sceneAssetModules.cjs').loadSceneAssetModules();

const ROOM_DIR = path.join(projectRoot, 'templates', 'components', 'codexr', 'xr-room');
const RUNTIME = path.join(ROOM_DIR, 'codexrRoomRuntime.js');
const TEXTURES = path.join(ROOM_DIR, 'textures');
const GUIDE_PAGE = path.join(projectRoot, 'templates', 'guide', 'guide.html');

function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('room: constants, resolvers and the existence assertion', () => {
    assert.equal(components.CODEXR_ROOM_RUNTIME_OUTPUT_NAME, 'codexrRoomRuntime.js');
    assert.equal(components.CODEXR_ROOM_TEXTURE_OUTPUT_DIRECTORY, 'assets/codexr/xr-room/textures');
    assert.equal(components.resolveCodeXrRoomRuntimeSourcePath(projectRoot), RUNTIME);
    assert.equal(components.resolveCodeXrRoomTextureSourcePath(projectRoot), TEXTURES);
    assert.deepEqual(components.assertCodeXrRoomAssetsExist(projectRoot), { runtimePath: RUNTIME, textureDirectory: TEXTURES });
});

test('room: copy writes the runtime and the texture tree, byte-identical, and returns nothing', async () => {
    const output = tempDir('codexr-room-asset-');
    try {
        assert.equal(await components.copyCodeXrRoomAssetsToOutput(projectRoot, output), undefined);
        assert.deepEqual(fs.readdirSync(output).sort(), ['assets', 'codexrRoomRuntime.js']);
        assert.ok(fs.readFileSync(path.join(output, 'codexrRoomRuntime.js')).equals(fs.readFileSync(RUNTIME)));
        const copiedTextures = path.join(output, 'assets', 'codexr', 'xr-room', 'textures');
        const names = fs.readdirSync(TEXTURES).sort();
        assert.deepEqual(fs.readdirSync(copiedTextures).sort(), names);
        for (const name of names) {
            assert.ok(fs.readFileSync(path.join(copiedTextures, name)).equals(fs.readFileSync(path.join(TEXTURES, name))));
        }
    } finally {
        fs.rmSync(output, { recursive: true, force: true });
    }
});

test('room: read returns the runtime text and every texture keyed by its output path, in readdir order', async () => {
    assert.equal(await components.readCodeXrRoomRuntimeContent(projectRoot), fs.readFileSync(RUNTIME, 'utf8'));
    const expected = fs.readdirSync(TEXTURES, { withFileTypes: true }).map((entry) => ({
        relativeOutputPath: `assets/codexr/xr-room/textures/${entry.name}`,
        content: fs.readFileSync(path.join(TEXTURES, entry.name), 'utf8'),
    }));
    assert.ok(expected.length > 0);
    assert.deepEqual(await components.readCodeXrRoomTextureContents(projectRoot), expected);
});

test('room: nested texture folders are walked with posix output paths', async () => {
    const root = tempDir('codexr-room-nested-');
    try {
        const room = path.join(root, 'templates', 'components', 'codexr', 'xr-room');
        fs.mkdirSync(path.join(room, 'textures', 'inner'), { recursive: true });
        fs.writeFileSync(path.join(room, 'codexrRoomRuntime.js'), '// runtime');
        fs.writeFileSync(path.join(room, 'textures', 'inner', 'a.svg'), '<svg/>');
        assert.deepEqual(await components.readCodeXrRoomTextureContents(root), [
            { relativeOutputPath: 'assets/codexr/xr-room/textures/inner/a.svg', content: '<svg/>' },
        ]);
        const output = path.join(root, 'out');
        fs.mkdirSync(output);
        await components.copyCodeXrRoomAssetsToOutput(root, output);
        assert.equal(fs.readFileSync(path.join(output, 'assets', 'codexr', 'xr-room', 'textures', 'inner', 'a.svg'), 'utf8'), '<svg/>');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('room: a missing runtime is refused first, then a missing texture directory, by every entry point', async () => {
    const missingRoot = path.join(os.tmpdir(), 'codexr-no-such-extension-root');
    const noRuntime = { message: `Code-XR room runtime not found at ${path.join(missingRoot, 'templates', 'components', 'codexr', 'xr-room', 'codexrRoomRuntime.js')}` };
    assert.throws(() => components.assertCodeXrRoomAssetsExist(missingRoot), noRuntime);
    await assert.rejects(components.copyCodeXrRoomAssetsToOutput(missingRoot, os.tmpdir()), noRuntime);
    await assert.rejects(components.readCodeXrRoomRuntimeContent(missingRoot), noRuntime);
    await assert.rejects(components.readCodeXrRoomTextureContents(missingRoot), noRuntime);

    const root = tempDir('codexr-room-no-textures-');
    try {
        const room = path.join(root, 'templates', 'components', 'codexr', 'xr-room');
        fs.mkdirSync(room, { recursive: true });
        fs.writeFileSync(path.join(room, 'codexrRoomRuntime.js'), '// runtime');
        const noTextures = { message: `Code-XR room texture directory not found at ${path.join(room, 'textures')}` };
        assert.throws(() => components.assertCodeXrRoomAssetsExist(root), noTextures);
        await assert.rejects(components.copyCodeXrRoomAssetsToOutput(root, os.tmpdir()), noTextures);
        await assert.rejects(components.readCodeXrRoomRuntimeContent(root), noTextures);
        await assert.rejects(components.readCodeXrRoomTextureContents(root), noTextures);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('guide page: read and copy ship templates/guide/guide.html as text; a missing page is a raw ENOENT', async () => {
    assert.equal(components.GUIDE_PAGE_OUTPUT_NAME, 'guide.html');
    const source = fs.readFileSync(GUIDE_PAGE, 'utf8');
    assert.equal(await components.readGuidePageContent(projectRoot), source);

    const output = tempDir('codexr-guide-page-');
    try {
        const written = await components.copyGuidePageToOutput(projectRoot, output);
        assert.equal(written, path.join(output, 'guide.html'));
        assert.deepEqual(fs.readdirSync(output), ['guide.html']);
        assert.equal(fs.readFileSync(written, 'utf8'), source);
    } finally {
        fs.rmSync(output, { recursive: true, force: true });
    }

    const missingRoot = path.join(os.tmpdir(), 'codexr-no-such-extension-root');
    await assert.rejects(components.readGuidePageContent(missingRoot), { code: 'ENOENT' });
    await assert.rejects(components.copyGuidePageToOutput(missingRoot, os.tmpdir()), { code: 'ENOENT' });
});
