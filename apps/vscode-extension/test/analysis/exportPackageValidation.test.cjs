const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateExportPackage } = require('../../out/core/export/exportPackageTransaction.js');

// Characterization of validateExportPackage (ROADMAP W4-T28, CX-07) beside
// the happy path in exportPackageTransaction.test.cjs: every required root
// file, which manifest URLs are followed (entities, git sources, and the
// working-copy URL only with a working-copy source), how a URL is cleaned,
// what counts as a file, the unsafe-path refusal, and the on-disk manifest
// check, in the order the checks run.

const temps = [];
test.after(() => {
    for (const folder of temps) {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

function write(root, relative, contents = '') {
    const filePath = path.join(root, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
}

const REQUIRED = ['index.html', 'data.json', 'xrChartMappingUiRuntime.js', 'codexr-export-manifest.json'];

function stagedPackage(manifest, { onDisk = manifest } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-export-validate-')));
    temps.push(root);
    for (const fileName of REQUIRED.slice(0, 3)) {
        write(root, fileName, 'x');
    }
    write(root, 'codexr-export-manifest.json', JSON.stringify(onDisk));
    return root;
}

const baseManifest = (overrides = {}) => ({ schemaVersion: 3, kind: 'codexr-export', entities: [], ...overrides });

test('each required root file must exist and be a file, checked in order', async () => {
    for (const fileName of REQUIRED) {
        const root = stagedPackage(baseManifest());
        fs.rmSync(path.join(root, fileName));
        await assert.rejects(validateExportPackage(root, baseManifest()), { message: `Export validation failed: missing ${fileName}` });
        fs.mkdirSync(path.join(root, fileName));
        await assert.rejects(validateExportPackage(root, baseManifest()), { message: `Export validation failed: missing ${fileName}` });
    }
    // With two missing, the first in the list is named.
    const root = stagedPackage(baseManifest());
    fs.rmSync(path.join(root, 'data.json'));
    fs.rmSync(path.join(root, 'index.html'));
    await assert.rejects(validateExportPackage(root, baseManifest()), { message: 'Export validation failed: missing index.html' });
});

test('entity dataset and result URLs are followed; other fields and non-strings are not', async () => {
    const manifest = baseManifest({
        entities: [
            { datasetUrl: './dependencies/dependency-graph-1.json', resultUrl: 42 },
            { resultUrl: '/comparison/revision-2.json?v=1#top' },
            { manifestUrl: './never/checked.json', url: './never/checked.json' },
        ],
    });
    const root = stagedPackage(manifest);
    await assert.rejects(validateExportPackage(root, manifest), {
        message: 'Export validation failed: missing payload ./dependencies/dependency-graph-1.json',
    });
    write(root, 'dependencies/dependency-graph-1.json', '{}');
    await assert.rejects(validateExportPackage(root, manifest), {
        message: 'Export validation failed: missing payload /comparison/revision-2.json?v=1#top',
    });
    write(root, 'comparison/revision-2.json', '{}');
    await validateExportPackage(root, manifest);
    // A folder where a payload should be is not a payload.
    fs.rmSync(path.join(root, 'comparison', 'revision-2.json'));
    fs.mkdirSync(path.join(root, 'comparison', 'revision-2.json'));
    await assert.rejects(validateExportPackage(root, manifest), /missing payload \/comparison\/revision-2\.json/);
});

test('the working-copy URL is only checked when a working-copy source is listed', async () => {
    const gitData = (sources) => ({
        references: { sources },
        workingCopyPayloadUrl: './git-revisions/working-copy.json',
    });
    const withoutSource = baseManifest({ gitData: gitData([{ id: 'commit-a', payloadUrl: './git-revisions/a.json' }]) });
    const root = stagedPackage(withoutSource);
    write(root, 'git-revisions/a.json', '[]');
    await validateExportPackage(root, withoutSource);

    const withSource = baseManifest({
        gitData: gitData([{ id: 'commit-a', payloadUrl: './git-revisions/a.json' }, { id: 'working-copy', payloadUrl: './git-revisions/a.json' }]),
    });
    await assert.rejects(validateExportPackage(root, withSource), {
        message: 'Export validation failed: missing payload ./git-revisions/working-copy.json',
    });
});

test('a URL escaping the package, or naming its root, is refused as unsafe', async () => {
    for (const url of ['../outside.json', './', '/']) {
        const manifest = baseManifest({ entities: [{ resultUrl: url }] });
        const root = stagedPackage(manifest);
        await assert.rejects(validateExportPackage(root, manifest), /^Error: Unsafe export artifact path: /, url);
    }
});

test('the manifest on disk must be an export of the same schema version, checked last', async () => {
    const manifest = baseManifest();
    for (const onDisk of [{ ...manifest, kind: 'other' }, { ...manifest, schemaVersion: 2 }, {}]) {
        const root = stagedPackage(manifest, { onDisk });
        await assert.rejects(validateExportPackage(root, manifest), { message: 'Export validation failed: invalid manifest' });
    }
    const unreadable = stagedPackage(manifest);
    write(unreadable, 'codexr-export-manifest.json', '{ broken');
    await assert.rejects(validateExportPackage(unreadable, manifest), SyntaxError);
    // A missing payload is reported before the manifest is read.
    const both = stagedPackage(baseManifest({ entities: [{ resultUrl: './gone.json' }] }), { onDisk: {} });
    await assert.rejects(validateExportPackage(both, baseManifest({ entities: [{ resultUrl: './gone.json' }] })), /missing payload \.\/gone\.json/);
});
