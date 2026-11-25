'use strict';

/**
 * Behavioural characterization of UnifiedSessionRegistry.createSession,
 * executed from out/ under the fake vscode: the session it builds for a file
 * and for a directory (ids, output paths, hash, tracked-file lists), the
 * three refusals (no workspace storage, a file that cannot be hashed, a
 * directory target that is not a directory), and the duplicate detection
 * (reported as a result; its warnings are the orchestrator's, see
 * analysisOrchestratorDuplicate.test.cjs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require('../helpers/fakeVscode.cjs');

function silenceConsole() {
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const original = methods.map((method) => console[method]);
    methods.forEach((method) => {
        console[method] = () => {};
    });
    return () => methods.forEach((method, index) => {
        console[method] = original[index];
    });
}

async function withRegistry(body, fakeOptions = {}) {
    const fake = createFakeVscode(fakeOptions);
    const context = fakeExtensionContext();
    const workRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-session-registry-')));
    const restoreConsole = silenceConsole();
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            const { UnifiedSessionRegistry } = requireOut('code_analysis/engine/core/sessionRegistry.js');
            const registry = UnifiedSessionRegistry.getInstance(context);
            const fired = [];
            registry.onSessionChanged((session) => fired.push(session));
            await body({ registry, fired, fake, context, workRoot });
        });
    } finally {
        restoreConsole();
        context.cleanup();
        fs.rmSync(workRoot, { recursive: true, force: true });
    }
}

test('a file session gets a nonce id, its output folder under fileAnalysis and the file hash', async () => {
    await withRegistry(async ({ registry, fired, context, workRoot }) => {
        const target = path.join(workRoot, 'sample.module.ts');
        fs.writeFileSync(target, 'export const answer = 42;\n');

        const { kind, session } = await registry.createSession({ targetPath: target, analysisMode: 'XR', targetType: 'file', context });
        assert.equal(kind, 'created');

        assert.match(session.id, /^[0-9a-f]{32}$/);
        assert.equal(session.targetPath, target);
        assert.equal(session.targetType, 'file');
        assert.equal(session.targetName, 'sample.module.ts');
        assert.equal(session.analysisMode, 'XR');
        assert.equal(session.isDeep, false);
        assert.equal(session.status, 'creating');
        assert.ok(session.startTime instanceof Date);
        assert.equal(session.hash256, crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'));
        assert.equal(session.outputDirectory, `sample.module_XR_file_${session.id}`);
        assert.equal(session.outputPath, path.join(context.storageUri.fsPath, 'fileAnalysis', session.outputDirectory));
        assert.ok(session.requiredFiles instanceof Map && session.requiredFiles.size === 0);
        assert.ok(session.templatePaths instanceof Map && session.templatePaths.size === 0);
        assert.deepEqual(session.metadata, {});
        assert.equal('directoriesToAnalyze' in session, false);
        assert.equal('filesToHash' in session, false);
        assert.deepEqual(Object.keys(session), [
            'id', 'targetPath', 'targetType', 'targetName', 'analysisMode', 'isDeep', 'status', 'startTime',
            'hash256', 'outputDirectory', 'outputPath', 'requiredFiles', 'templatePaths', 'metadata',
        ]);

        assert.equal(registry.getSession(session.id), session);
        assert.deepEqual(fired, [session]);
    });
});

test('a directory session has no hash, lives under directoryAnalysis and starts with empty tracked lists', async () => {
    await withRegistry(async ({ registry, fired, context, workRoot }) => {
        const target = path.join(workRoot, 'my.project');
        fs.mkdirSync(target);

        const { kind, session } = await registry.createSession({ targetPath: target, analysisMode: 'LivePanel', targetType: 'directory', isDeep: true, context });
        assert.equal(kind, 'created');

        assert.equal(session.isDeep, true);
        assert.equal(session.hash256, '');
        assert.equal(session.targetName, 'my.project');
        assert.equal(session.outputDirectory, `my_LivePanel_directory_${session.id}`);
        assert.equal(session.outputPath, path.join(context.storageUri.fsPath, 'directoryAnalysis', session.outputDirectory));
        assert.deepEqual(session.directoriesToAnalyze, []);
        assert.deepEqual(session.filesToHash, []);
        assert.deepEqual(Object.keys(session).slice(-2), ['directoriesToAnalyze', 'filesToHash']);
        assert.deepEqual(fired, [session]);
    });
});

test('createSession refuses without workspace storage, an unreadable file, or a directory target that is a file', async () => {
    await withRegistry(async ({ registry, fired, context, workRoot }) => {
        const file = path.join(workRoot, 'plain.txt');
        fs.writeFileSync(file, 'x');

        await assert.rejects(
            registry.createSession({ targetPath: file, analysisMode: 'XR', targetType: 'file', context: { ...context, storageUri: undefined } }),
            { message: 'Workspace storage URI is not available' },
        );
        await assert.rejects(
            registry.createSession({ targetPath: path.join(workRoot, 'missing.ts'), analysisMode: 'XR', targetType: 'file', context }),
            (error) => error.message.startsWith('Failed to calculate file hash: '),
        );
        await assert.rejects(
            registry.createSession({ targetPath: file, analysisMode: 'XR', targetType: 'directory', context }),
            { message: `Target path is not a directory: ${file}` },
        );
        await assert.rejects(
            registry.createSession({ targetPath: path.join(workRoot, 'missing-dir'), analysisMode: 'XR', targetType: 'directory', context }),
            (error) => error.code === 'ENOENT',
        );

        assert.equal(registry.getAllSessions().length, 0);
        assert.deepEqual(fired, []);
    });
});

test('a duplicate session is refused, reported as such and re-announced, with no UI from the registry', async () => {
    await withRegistry(async ({ registry, fired, fake, context, workRoot }) => {
        const target = path.join(workRoot, 'dup.ts');
        fs.writeFileSync(target, 'let a = 1;\n');
        const params = { targetPath: target, analysisMode: 'XR', targetType: 'file', context };

        const { session: original } = await registry.createSession(params);
        fired.length = 0;

        // creating / analyzing / monitoring: the live session is the duplicate.
        assert.deepEqual(await registry.createSession(params), { kind: 'duplicate', existing: original });
        registry.updateSessionStatus(original.id, 'analyzing');
        fired.length = 0;
        assert.deepEqual(await registry.createSession({ ...params, isDeep: false }), { kind: 'duplicate', existing: original });
        registry.updateSessionStatus(original.id, 'monitoring');
        fired.length = 0;
        assert.deepEqual(await registry.createSession(params), { kind: 'duplicate', existing: original });
        await new Promise((resolve) => setImmediate(resolve));

        // The warnings are the caller's (analysisOrchestratorDuplicate.test.cjs).
        assert.deepEqual(fake.messages, []);
        assert.deepEqual(fake.executedCommands, []);
        assert.deepEqual(fired, [original]);
        assert.equal(registry.getAllSessions().length, 1);

        // Another mode, another depth, another type: not duplicates.
        const live = await registry.createSession({ ...params, analysisMode: 'LivePanel' });
        const deep = await registry.createSession({ ...params, isDeep: true });
        assert.equal(live.kind, 'created');
        assert.equal(deep.kind, 'created');

        // A closed or failed session does not block a new one.
        registry.updateSessionStatus(original.id, 'closed');
        const again = await registry.createSession(params);
        assert.ok(again.kind === 'created' && again.session.id !== original.id);
        registry.updateSessionStatus(again.session.id, 'error');
        assert.equal((await registry.createSession(params)).kind, 'created');
    });
});
