/**
 * Behavioural characterization of the two single-file runtimes that are
 * still embedded in multi-part asset modules rather than rows of the
 * descriptor table: the DOM-scene collaboration runtime
 * (collaborationComponentAsset.ts) and the virtual-screen manager
 * (virtualScreenComponentAsset.ts). Written before ROADMAP T47 moved their
 * existence checks onto the family's shared assertSourceExists.
 *
 * What it pins: copy and read from the real templates/, and the exact
 * "<label> not found at <path>" refusal of both entry points.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const components = require('../helpers/sceneAssetModules.cjs').loadSceneAssetModules();

const RUNTIMES = [
    {
        label: 'Code-XR DOM scene collaboration runtime',
        folder: ['templates', 'components', 'codexr', 'dom-scene'],
        outputName: 'codexrDomSceneCollaborationRuntime.js',
        copy: 'copyCodeXrDomSceneCollaborationRuntimeToOutput',
        read: 'readCodeXrDomSceneCollaborationRuntimeContent',
    },
    {
        label: 'Virtual screen manager runtime',
        folder: ['templates', 'components', 'codexr', 'virtual-screen'],
        outputName: 'codexrMultiScreenManagerRuntime.js',
        copy: 'copyVirtualScreenManagerRuntimeToOutput',
        read: 'readVirtualScreenManagerRuntimeContent',
    },
];

for (const runtime of RUNTIMES) {
    test(`${runtime.outputName}: copy and read serve the template file byte for byte`, async () => {
        const source = fs.readFileSync(path.join(projectRoot, ...runtime.folder, runtime.outputName));
        const output = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-embedded-runtime-'));
        try {
            const written = await components[runtime.copy](projectRoot, output);
            assert.equal(written, path.join(output, runtime.outputName));
            assert.deepEqual(fs.readdirSync(output), [runtime.outputName]);
            assert.ok(fs.readFileSync(written).equals(source));
        } finally {
            fs.rmSync(output, { recursive: true, force: true });
        }
        assert.equal(await components[runtime.read](projectRoot), source.toString('utf8'));
    });

    test(`${runtime.outputName}: both entry points refuse a missing source with the same message`, async () => {
        const missingRoot = path.join(os.tmpdir(), 'codexr-no-such-extension-root');
        const expected = { message: `${runtime.label} not found at ${path.join(missingRoot, ...runtime.folder, runtime.outputName)}` };
        await assert.rejects(components[runtime.copy](missingRoot, os.tmpdir()), expected);
        await assert.rejects(components[runtime.read](missingRoot), expected);
    });
}
