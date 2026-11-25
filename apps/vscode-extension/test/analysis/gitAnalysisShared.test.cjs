/**
 * The pure helpers shared by historical comparison, project evolution and
 * the export-time Git pre-analysis (src/code_analysis/historical/gitAnalysisShared.ts).
 * Loaded from out/ with no vscode stub: the module must stay vscode-free.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { toPortableRelativePath, buildAnalyzerCacheKey, decorateDirectoryEntries } = require(path.join(projectRoot, 'out', 'code_analysis', 'historical', 'gitAnalysisShared.js'));

test('toPortableRelativePath: relative candidates are cleaned to POSIX, with an unknown fallback', () => {
    const root = path.join(os.tmpdir(), 'codexr-root');
    assert.equal(toPortableRelativePath(root, ''), 'unknown');
    assert.equal(toPortableRelativePath(root, './a//b/'), 'a/b');
    assert.equal(toPortableRelativePath(root, 'a\\b'), 'a/b');
    assert.equal(toPortableRelativePath(root, 'a\\\\b\\c.js'), 'a/b/c.js');
    assert.equal(toPortableRelativePath(root, './//'), 'unknown');
    assert.equal(toPortableRelativePath(root, 'plain.js'), 'plain.js');
});

test('toPortableRelativePath: absolute candidates are relative inside the root, a basename outside it', () => {
    const root = path.join(os.tmpdir(), 'codexr-root');
    assert.equal(toPortableRelativePath(root, path.join(root, 'src', 'deep', 'file.js')), 'src/deep/file.js');
    assert.equal(toPortableRelativePath(root, path.join(root, '..', 'sibling', 'outside.js')), 'outside.js');
    assert.equal(toPortableRelativePath(root, path.join(root, 'src', '..', '..', 'escape.js')), 'escape.js');
    // A real quirk, pinned on purpose: the root itself maps to the empty string.
    assert.equal(toPortableRelativePath(root, root), '');
    assert.equal(toPortableRelativePath(root, `${root}${path.sep}`), '');
});

test('buildAnalyzerCacheKey: sha256 over version, commit and the three session fields', () => {
    const session = { targetPath: '/repo/app', targetType: 'directory', isDeep: true };
    const expected = crypto.createHash('sha256')
        .update(['historical-v1', 'abc123', '/repo/app', 'directory', 'deep'].join('\0'))
        .digest('hex');
    assert.equal(buildAnalyzerCacheKey('historical-v1', 'abc123', session), expected);

    const keys = new Set([
        buildAnalyzerCacheKey('historical-v1', 'abc123', session),
        buildAnalyzerCacheKey('project-evolution-v1', 'abc123', session),
        buildAnalyzerCacheKey('historical-v1', 'abc124', session),
        buildAnalyzerCacheKey('historical-v1', 'abc123', { ...session, isDeep: false }),
        buildAnalyzerCacheKey('historical-v1', 'abc123', { ...session, targetType: 'file' }),
        buildAnalyzerCacheKey('historical-v1', 'abc123', { ...session, targetPath: '/repo/other' }),
    ]);
    assert.equal(keys.size, 6, 'every field separates the namespace');
    assert.equal(
        buildAnalyzerCacheKey('v', 'c', { targetPath: 'p', targetType: 't' }),
        buildAnalyzerCacheKey('v', 'c', { targetPath: 'p', targetType: 't', isDeep: false }),
        'a missing isDeep is shallow',
    );
});

test('decorateDirectoryEntries: filePath against the original target, relative keys, field order kept', () => {
    const analyzed = path.join(os.tmpdir(), 'codexr-snapshot', 'app');
    const rows = decorateDirectoryEntries([
        { filePath: path.join(analyzed, 'Src', 'Main.js'), totalLines: 3 },
        { comparisonKey: 'stale', relativePath: './lib//util.js' },
        { fileName: 'only.js' },
        {},
    ], '/repo/app/', analyzed, ['comparisonKey', 'evolutionKey']);
    assert.deepEqual(rows, [
        { filePath: '/repo/app/Src/Main.js', totalLines: 3, relativePath: 'Src/Main.js', comparisonKey: 'file:src/main.js', evolutionKey: 'file:src/main.js' },
        { comparisonKey: 'file:lib/util.js', relativePath: 'lib/util.js', filePath: '/repo/app/lib/util.js', evolutionKey: 'file:lib/util.js' },
        { fileName: 'only.js', filePath: '/repo/app/only.js', relativePath: 'only.js', comparisonKey: 'file:only.js', evolutionKey: 'file:only.js' },
        { filePath: '/repo/app/unknown', relativePath: 'unknown', comparisonKey: 'file:unknown', evolutionKey: 'file:unknown' },
    ]);
    // Key order is part of the JSON the modes write: an existing key keeps its slot.
    assert.deepEqual(Object.keys(rows[1]), ['comparisonKey', 'relativePath', 'filePath', 'evolutionKey']);
    assert.deepEqual(Object.keys(rows[0]), ['filePath', 'totalLines', 'relativePath', 'comparisonKey', 'evolutionKey']);
});
