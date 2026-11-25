/**
 * Behavioural characterization of the active-servers command registrations
 * (src/features/active-servers/commands/activeServersCommands.ts), written before
 * ROADMAP T44 turned the eleven identical "server id from a tree item"
 * handlers into a table. It runs the compiled module from out/ under the
 * fake vscode, with every ServerActionHandlers static replaced by a
 * recorder.
 *
 * What it pins: the registration list itself (ids, order, module,
 * description, errorMessage), which handler each tree-item command calls
 * for a tree item, a bare id and an unusable argument, and the three
 * commands with their own argument shapes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

const EXPECTED_REGISTRATIONS = [
    ['codeXR.activeServers.showActions', 'Show server actions', 'Failed to show server actions'],
    ['codeXR.activeServers.openInBrowser', 'Open active server in browser', 'Failed to open active server in browser'],
    ['codeXR.activeServers.openInPanel', 'Open active server in panel', 'Failed to open active server in panel'],
    ['codeXR.activeServers.copyUrl', 'Copy active server URL', 'Failed to copy active server URL'],
    ['codeXR.activeServers.copyLanUrl', 'Copy active server LAN URL', 'Failed to copy active server LAN URL'],
    ['codeXR.activeServers.startRemoteAccess', 'Start remote access', 'Failed to start remote access'],
    ['codeXR.activeServers.copyRemoteInvitation', 'Copy remote invitation', 'Failed to copy remote invitation'],
    ['codeXR.activeServers.stopRemoteAccess', 'Stop remote access', 'Failed to stop remote access'],
    ['codeXR.activeServers.showRemoteStatus', 'Show remote access status', 'Failed to show remote access status'],
    ['codeXR.activeServers.stopServer', 'Stop active server', 'Failed to stop active server'],
    ['codeXR.activeServers.showDetails', 'Show active server details', 'Failed to show active server details'],
    ['codeXR.activeServers.regeneratePairingCode', 'Generate a new pairing code', 'Failed to generate a new pairing code'],
    ['codeXR.activeServers.showParticipantDetails', 'Show connected participant details', 'Failed to show participant details'],
    ['codeXR.activeServers.removeParticipant', 'Remove a participant from the session', 'Failed to remove the participant'],
    ['codeXR.activeServers.stopAllServers', 'Stop all active servers', 'Failed to stop all active servers'],
    ['codeXR.activeServers.refreshServers', 'Refresh active servers', 'Failed to refresh active servers'],
    ['codeXR.activeServers.openView', 'Open active servers view', 'Failed to open active servers view'],
];

// command id -> ServerActionHandlers method, for the commands that take a tree item or a bare id.
const TREE_ITEM_COMMANDS = {
    'codeXR.activeServers.openInBrowser': 'openInBrowser',
    'codeXR.activeServers.openInPanel': 'openInPanel',
    'codeXR.activeServers.copyUrl': 'copyUrl',
    'codeXR.activeServers.copyLanUrl': 'copyLanUrl',
    'codeXR.activeServers.startRemoteAccess': 'startRemoteAccess',
    'codeXR.activeServers.copyRemoteInvitation': 'copyRemoteInvitation',
    'codeXR.activeServers.stopRemoteAccess': 'stopRemoteAccess',
    'codeXR.activeServers.showRemoteStatus': 'showRemoteStatus',
    'codeXR.activeServers.stopServer': 'stopServer',
    'codeXR.activeServers.showDetails': 'showServerDetails',
    'codeXR.activeServers.regeneratePairingCode': 'regeneratePairingCode',
};

async function withCommands(body) {
    const fake = createFakeVscode();
    await withFakeVscode(fake, async ({ requireOut }) => {
        const { ServerActionHandlers } = requireOut('features/active-servers/views/handleServerActions.js');
        const calls = [];
        const methods = [
            ...Object.values(TREE_ITEM_COMMANDS),
            'showServerActions', 'showParticipantDetails', 'removeParticipant', 'stopAllServers',
        ];
        const originals = {};
        for (const method of methods) {
            originals[method] = ServerActionHandlers[method];
            ServerActionHandlers[method] = async (...args) => {
                calls.push([method, ...args]);
            };
        }
        try {
            const { ActiveServersCommands } = requireOut('features/active-servers/commands/activeServersCommands.js');
            await body({ fake, ActiveServersCommands, calls });
        } finally {
            Object.assign(ServerActionHandlers, originals);
        }
    });
}

test('the registration list: ids, order, module, description and error message', async () => {
    await withCommands(async ({ ActiveServersCommands }) => {
        const registrations = ActiveServersCommands.getCommandRegistrations(undefined);
        assert.deepEqual(
            registrations.map((entry) => [entry.id, entry.description, entry.errorMessage]),
            EXPECTED_REGISTRATIONS,
        );
        for (const entry of registrations) {
            assert.equal(entry.module, 'ACTIVE_SERVER', entry.id);
            assert.equal(typeof entry.handler, 'function', entry.id);
            assert.deepEqual(Object.keys(entry).sort(), ['description', 'errorMessage', 'handler', 'id', 'module'], entry.id);
        }
    });
});

test('tree-item commands resolve the server id from a tree item or a bare id, and do nothing otherwise', async () => {
    await withCommands(async ({ ActiveServersCommands, calls }) => {
        const registrations = ActiveServersCommands.getCommandRegistrations(undefined);
        const byId = new Map(registrations.map((entry) => [entry.id, entry]));
        for (const [commandId, method] of Object.entries(TREE_ITEM_COMMANDS)) {
            calls.length = 0;
            const handler = byId.get(commandId).handler;
            assert.equal(await handler({ server: { id: 'srv-1' }, label: 'x' }), undefined);
            await handler('srv-2');
            for (const unusable of [undefined, null, {}, { server: {} }, { server: { id: '' } }, { activeServer: { id: 'srv-3' } }, 42]) {
                await handler(unusable);
            }
            assert.deepEqual(calls, [[method, 'srv-1'], [method, 'srv-2']], commandId);
        }
    });
});

test('the commands with their own argument shapes', async () => {
    await withCommands(async ({ fake, ActiveServersCommands, calls }) => {
        let refreshes = 0;
        const withProvider = ActiveServersCommands.getCommandRegistrations({ refresh() { refreshes += 1; } });
        const byId = new Map(withProvider.map((entry) => [entry.id, entry]));

        await byId.get('codeXR.activeServers.showActions').handler('srv-1');
        await byId.get('codeXR.activeServers.showParticipantDetails').handler('srv-1', 'peer-1');
        await byId.get('codeXR.activeServers.removeParticipant').handler('srv-1', 'peer-1');
        await byId.get('codeXR.activeServers.removeParticipant').handler({ activeServer: { id: 'srv-2' }, participant: { peerId: 'peer-2' } });
        await byId.get('codeXR.activeServers.removeParticipant').handler({ server: { id: 'srv-3' }, participant: { peerId: 'peer-3' } });
        await byId.get('codeXR.activeServers.removeParticipant').handler('srv-1');
        await byId.get('codeXR.activeServers.stopAllServers').handler();
        assert.deepEqual(calls, [
            ['showServerActions', 'srv-1'],
            ['showParticipantDetails', 'srv-1', 'peer-1'],
            ['removeParticipant', 'srv-1', 'peer-1'],
            ['removeParticipant', 'srv-2', 'peer-2'],
            ['removeParticipant', 'srv-3', 'peer-3'],
            ['stopAllServers'],
        ]);
        assert.deepEqual(fake.messages, [{
            kind: 'warning',
            message: 'Could not tell which participant to remove. Refresh the view and try again.',
            items: [],
        }]);

        await byId.get('codeXR.activeServers.refreshServers').handler();
        assert.equal(refreshes, 1);
        await byId.get('codeXR.activeServers.openView').handler();
        const withoutProvider = ActiveServersCommands.getCommandRegistrations(undefined);
        await withoutProvider.find((entry) => entry.id === 'codeXR.activeServers.refreshServers').handler();
        assert.equal(refreshes, 1);
        assert.deepEqual(fake.executedCommands.map((entry) => entry.id), ['codexrTree.focus', 'codexr.tree.refresh']);
    });
});
