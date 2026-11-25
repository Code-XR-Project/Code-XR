const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, fakeExtensionContext, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

// Characterization of DependencyGraphService.analyzeFileScope (ROADMAP
// W4-T17, hotspots-ts/CPLX-20): which file it resolves for each session
// type, the containment refusal, the content-hash cache (a hit re-stamps and
// re-writes, a content change evicts the old entries), the dataset it
// shapes, the file it writes, and the Python call. Runs the real service from
// out/ with the session and the Python runner stubbed.

async function withService(sessionOf, callback) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-depscope-')));
    // A .git marker makes the project root the temp root, wherever tmp lives.
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, 'src', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.py'), 'import b\n');
    fs.writeFileSync(path.join(root, 'src', 'pkg', 'b.py'), 'x = 1\n');
    const staticRoot = path.join(root, 'static');
    const context = fakeExtensionContext();
    const fake = createFakeVscode();
    const pythonCalls = [];
    try {
        return await withFakeVscode(fake, async ({ requireOut }) => {
            const { DependencyGraphService } = requireOut('code_analysis/dependencies/dependencyGraphService.js');
            // The ExecutePython class the service already loaded.
            const { ExecutePython } = require(path.join(projectRoot, 'out', 'code_analysis', 'engine', 'utils', 'executePython.js'));
            let respond = (target) => ({ nodes: [{ id: path.basename(target) }], edges: [], extra: 'kept' });
            ExecutePython.prototype.executeDependencyAnalysis = async function (...args) {
                pythonCalls.push(args.map((arg) => (typeof arg === 'string' ? arg.split(root).join('<root>') : arg)));
                return respond(args[0]);
            };
            const service = new DependencyGraphService(context, 's1', staticRoot);
            service.getSession = () => sessionOf(root);
            const progress = [];
            const run = async (relativePath) => {
                try {
                    const dataset = await service.analyzeFileScope(relativePath, (message) => progress.push(message));
                    const { generatedAt, ...rest } = dataset;
                    assert.match(generatedAt, /^\d{4}-\d\d-\d\dT/);
                    return rest;
                } catch (error) {
                    return { error: error.message };
                }
            };
            const written = () => fs.existsSync(path.join(staticRoot, 'dependencies'))
                ? fs.readdirSync(path.join(staticRoot, 'dependencies')).sort()
                : [];
            return await callback({ run, root, pythonCalls, progress, written, setResponse: (fn) => { respond = fn; } });
        });
    } finally {
        context.cleanup();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const directorySession = (root) => ({ targetType: 'directory', targetPath: path.join(root, 'src') });
const fileSession = (root) => ({ targetType: 'file', targetPath: path.join(root, 'src', 'a.py') });

test('directory session: resolves the relative path, shapes and writes the dataset, then serves the cache', async () => {
    await withService(directorySession, async ({ run, root, pythonCalls, progress, written }) => {
        const first = await run('pkg/b.py');
        assert.deepEqual(first, {
            nodes: [{ id: 'b.py' }],
            edges: [],
            extra: 'kept',
            schemaVersion: 2,
            revision: 1,
            sourceRevision: 0,
            targetType: 'file',
            targetRelativePath: 'pkg/b.py',
        });
        assert.deepEqual(pythonCalls, [[path.join('<root>', 'src', 'pkg', 'b.py'), 'file', false, undefined, undefined, '<root>']]);
        assert.deepEqual(progress, ['Analyzing symbols and calls in the selected file...']);
        assert.deepEqual(written(), ['dependency-scope-1.json']);
        const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'static', 'dependencies', 'dependency-scope-1.json'), 'utf8'));
        assert.equal(onDisk.revision, 1);

        // Same content: no Python, a new revision, written again, no progress message.
        const second = await run('pkg/b.py');
        assert.deepEqual(second, { ...first, revision: 2 });
        assert.equal(pythonCalls.length, 1);
        assert.equal(progress.length, 1);
        assert.deepEqual(written(), ['dependency-scope-1.json', 'dependency-scope-2.json']);

        // Changed content: analysed again, and the old entry is evicted...
        fs.writeFileSync(path.join(root, 'src', 'pkg', 'b.py'), 'x = 2\n');
        assert.equal((await run('pkg/b.py')).revision, 3);
        assert.equal(pythonCalls.length, 2);
        // ...so going back to the first content analyses a third time.
        fs.writeFileSync(path.join(root, 'src', 'pkg', 'b.py'), 'x = 1\n');
        assert.equal((await run('pkg/b.py')).revision, 4);
        assert.equal(pythonCalls.length, 3);
        // Another file keeps its own cache entry.
        await run('a.py');
        await run('a.py');
        assert.equal(pythonCalls.length, 4);
    });
});

test('directory session: a Windows-style relative path is reported with forward slashes', async () => {
    await withService(directorySession, async ({ run }) => {
        const result = await run(['pkg', 'b.py'].join(path.sep));
        assert.equal(result.targetRelativePath, 'pkg/b.py');
    });
});

test('file session: always the session file, whatever path is asked for', async () => {
    await withService(fileSession, async ({ run, pythonCalls }) => {
        const result = await run('pkg/b.py');
        assert.equal(result.targetRelativePath, 'a.py');
        assert.deepEqual(pythonCalls[0].slice(0, 2), [path.join('<root>', 'src', 'a.py'), 'file']);
        assert.equal((await run(undefined)).targetRelativePath, 'a.py');
    });
});

test('anything outside the analysis, missing, or not a file is refused before Python runs', async () => {
    await withService(directorySession, async ({ run, pythonCalls, written }) => {
        const refusal = { error: 'The requested dependency file is outside the active analysis.' };
        for (const requested of ['../outside.py', '..', 'missing.py', 'pkg', '', undefined, path.join(path.sep, 'etc', 'hosts')]) {
            assert.deepEqual(await run(requested), refusal, String(requested));
        }
        assert.deepEqual(pythonCalls, []);
        assert.deepEqual(written(), []);
    });
});

test('an invalid Python dataset is an error carrying its message, and nothing is cached or written', async () => {
    await withService(directorySession, async ({ run, pythonCalls, written, setResponse }) => {
        setResponse(() => ({ error: true, message: 'parser crashed' }));
        assert.deepEqual(await run('a.py'), { error: 'parser crashed' });
        setResponse(() => ({ nodes: [] }));
        assert.deepEqual(await run('a.py'), { error: 'File dependency analysis returned an invalid dataset.' });
        setResponse(() => null);
        assert.deepEqual(await run('a.py'), { error: 'File dependency analysis returned an invalid dataset.' });
        assert.deepEqual(written(), []);
        setResponse((target) => ({ nodes: [], edges: [{ from: path.basename(target) }] }));
        assert.equal((await run('a.py')).revision, 1);
        assert.equal(pythonCalls.length, 4);
    });
});
