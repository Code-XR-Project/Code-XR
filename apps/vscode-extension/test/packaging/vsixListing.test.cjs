const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// scripts/vsix-listing.mjs checks the BUILT package in CI (the package job).
// These tests pin its rules and its zip reader without building a VSIX.
const projectRoot = path.resolve(__dirname, '..', '..');
const loadListing = () => import(pathToFileURL(path.join(projectRoot, 'scripts', 'vsix-listing.mjs')).href);

const GOOD_LISTING = [
    'extension.vsixmanifest',
    '[Content_Types].xml',
    'extension/package.json',
    'extension/readme.md',
    'extension/changelog.md',
    'extension/LICENSE.txt',
    'extension/dist/extension.js',
    'extension/dist/code_analysis/python/main.py',
    'extension/resources/icon.png',
    'extension/templates/xr/live/liveReloadXR.js',
    'extension/examples/sample.json',
];

test('a listing with every required entry and nothing forbidden passes', async () => {
    const { checkListing } = await loadListing();
    assert.deepEqual(checkListing(GOOD_LISTING), []);
});

test('missing entries and forbidden files are each reported', async () => {
    const { checkListing } = await loadListing();
    const problems = checkListing([
        ...GOOD_LISTING.filter((name) => name !== 'extension/dist/extension.js' && !name.startsWith('extension/examples/')),
        'extension/dist/extension.js.map',
        'extension/src/extension.ts',
        'extension/dist/code_analysis/python/__pycache__/main.cpython-312.pyc',
        'extension/tsconfig.json',
        'extension/node_modules/ws/index.js',
        'extension/templates/types.d.ts',
    ]);

    assert.deepEqual(problems, [
        'missing: extension/dist/extension.js',
        'missing: anything under extension/examples/',
        'forbidden (source maps are stripped before packaging): extension/dist/extension.js.map',
        'forbidden (not in the files allowlist): extension/src/extension.ts',
        'forbidden (TypeScript sources): extension/src/extension.ts',
        'forbidden (Python bytecode): extension/dist/code_analysis/python/__pycache__/main.cpython-312.pyc',
        'forbidden (build configuration): extension/tsconfig.json',
        'forbidden (not in the files allowlist): extension/node_modules/ws/index.js',
    ]);
});

/** A zip holding only a central directory and its end record: all the reader needs. */
function centralDirectoryZip(entries) {
    const records = entries.map(({ name, size }) => {
        const nameBytes = Buffer.from(name, 'utf8');
        const record = Buffer.alloc(46 + nameBytes.length);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt32LE(size, 24);
        record.writeUInt16LE(nameBytes.length, 28);
        nameBytes.copy(record, 46);
        return record;
    });
    const directory = Buffer.concat(records);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(0, 16);
    return Buffer.concat([directory, end]);
}

test('the zip reader returns names and sizes from the central directory', async () => {
    const { readZipListing } = await loadListing();
    const entries = [{ name: 'extension/package.json', size: 29130 }, { name: 'extension/dist/extension.js', size: 1215434 }];

    assert.deepEqual(readZipListing(centralDirectoryZip(entries)), entries);
    assert.throws(() => readZipListing(Buffer.from('not a zip at all, just some text bytes')), /not a zip file/);
});
