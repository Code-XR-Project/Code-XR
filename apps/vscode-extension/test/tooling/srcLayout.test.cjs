'use strict';

/**
 * Pins the shape of src/ that story #55 produced (docs/cleanup/src-layout.md
 * §3): five areas plus the entry point, kebab-case folder names, and no
 * re-export-only index.ts. Which area may import which is
 * dependencyDirection.test.cjs; this file only checks names and places.
 *
 * A failure here means a folder or file landed outside the layout. Put it in
 * the area it belongs to (src-layout.md §3.1), name the folder in kebab-case,
 * and import the concrete file instead of adding a barrel (ARCHITECTURE.md
 * "Barrel policy").
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const sourceRoot = path.join(projectRoot, 'src');

const AREAS = ['app', 'core', 'features', 'platform', 'shared'];
const ENTRY_POINT = 'extension.ts';
// core/ and features/ are read two levels deep (folderDependencies.json
// twoLevelAreas): a loose file at their root would belong to no unit.
const FOLDER_ONLY_AREAS = ['core', 'features'];
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Every folder under src/, as a posix path relative to src/. */
function listFolders(directory = sourceRoot) {
    const folders = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const full = path.join(directory, entry.name);
        folders.push(path.relative(sourceRoot, full).split(path.sep).join('/'));
        folders.push(...listFolders(full));
    }
    return folders;
}

function listFiles(directory = sourceRoot) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        return entry.isDirectory() ? listFiles(full) : [full];
    });
}

/**
 * True when a module only re-exports other modules: once comments and every
 * `export ... from '...'` statement are taken out, nothing is left.
 */
function isReExportOnly(source) {
    const rest = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/export\s+(type\s+)?(\*(\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"][^'"]+['"]\s*;?/g, '')
        .replace(/['"]use strict['"]\s*;?/g, '');
    return rest.trim() === '';
}

test('the barrel check recognises re-export-only modules and nothing else', () => {
    assert.equal(isReExportOnly("export * from './a';\nexport { b, c as d } from './b';\n"), true);
    assert.equal(isReExportOnly("/** doc */\nexport type {\n  A,\n  B,\n} from './types';\n"), true);
    assert.equal(isReExportOnly("export * as ns from './a';"), true);
    assert.equal(isReExportOnly("export * from './a';\nexport function run(): void {}\n"), false);
    assert.equal(isReExportOnly("import { a } from './a';\nexport const b = a;\n"), false);
});

test('src/ holds the five areas and the entry point, nothing else', () => {
    const entries = fs.readdirSync(sourceRoot).sort();
    assert.deepEqual(entries, [...AREAS, ENTRY_POINT].sort());
    for (const area of AREAS) {
        assert.ok(fs.statSync(path.join(sourceRoot, area)).isDirectory(), `${area} is a folder`);
    }
});

test('core/ and features/ hold folders only', () => {
    for (const area of FOLDER_ONLY_AREAS) {
        const loose = fs.readdirSync(path.join(sourceRoot, area), { withFileTypes: true })
            .filter((entry) => !entry.isDirectory())
            .map((entry) => `${area}/${entry.name}`);
        assert.deepEqual(loose, [], `loose files at the root of ${area}/`);
    }
});

test('every folder under src/ is named in kebab-case', () => {
    const folders = listFolders();
    assert.ok(folders.length > AREAS.length, 'the walk finds the nested folders');
    const misnamed = folders.filter((folder) => !KEBAB_CASE.test(folder.split('/').at(-1)));
    assert.deepEqual(misnamed, []);
});

test('no index.ts under src/ only re-exports other modules', () => {
    const barrels = listFiles()
        .filter((file) => path.basename(file) === 'index.ts')
        .filter((file) => isReExportOnly(fs.readFileSync(file, 'utf8')))
        .map((file) => path.relative(sourceRoot, file).split(path.sep).join('/'));
    assert.deepEqual(barrels, []);
});
