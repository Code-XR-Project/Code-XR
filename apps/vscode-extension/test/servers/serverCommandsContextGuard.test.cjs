/**
 * Behavioural characterization of the "no extension context yet" guard in
 * src/servers/commands/serverCommands.ts, written before ROADMAP T51 moved
 * its three copies into one helper. Each entry point reaches the guard by
 * its own path (startLocalServer after a file was picked, resetToDefault
 * after the confirmation, configureRemoteAccess at once); each must answer
 * with the same toast and stop there.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

const GUARD_TOAST = { kind: 'error', message: 'SERVER: Extension context not available', items: [] };

test('every entry point that needs the extension context refuses with the same toast before it is set', async () => {
    const fake = createFakeVscode();
    await withFakeVscode(fake, async ({ requireOut }) => {
        const commands = requireOut('servers/commands/serverCommands.js');

        await commands.configureRemoteAccess();
        assert.deepEqual(fake.messages, [GUARD_TOAST]);

        fake.messages.length = 0;
        fake.queueAnswer('Reset to Default');
        await commands.resetToDefault();
        assert.deepEqual(fake.messages.map((entry) => entry.kind), ['warning', 'error']);
        assert.deepEqual(fake.messages[1], GUARD_TOAST);

        fake.messages.length = 0;
        // A readable file: this test file itself.
        fake.queueAnswer([fake.vscode.Uri.file(__filename)]);
        await commands.startLocalServer();
        assert.deepEqual(fake.messages, [GUARD_TOAST]);
        assert.deepEqual(fake.executedCommands, []);
    });
});
