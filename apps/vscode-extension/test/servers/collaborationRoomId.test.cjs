'use strict';

/**
 * #19: every client of one analysis server joins the same collaboration room,
 * whenever it asks. A scene opened in a panel (the IDE's scene view, VS Code's
 * lateral panel) asks before the launch has written the session mapping; it
 * used to land in `codexr-session:port-<port>` while a browser or headset that
 * came later joined `codexr-session:<server id>`, so the two never met.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeVscode, withFakeVscode } = require('../helpers/fakeVscode.cjs');

test('the room is named after the registered server before the session mapping exists', () => {
    withFakeVscode(createFakeVscode(), ({ requireOut }) => {
        const { ActiveServerRegistry } = requireOut('core/server/registry/activeServerRegistry.js');
        const { fileToServerMap } = requireOut('core/server/fileToServerMap.js');
        const { CollaborationSessionApi } = requireOut('core/server/collaboration/collaborationSessionApi.js');
        const registry = ActiveServerRegistry.getInstance();
        const port = 3917;
        const api = new CollaborationSessionApi({ port, authority: {}, getAnalysisAvailability: async () => ({}) });

        assert.equal(api.getCollaborationRoomId(), `codexr-session:port-${port}`, 'no server yet: the port names the room');

        const server = registry.registerServer({ port, url: `http://localhost:${port}`, launchMode: 'lateralPanel', certMode: 'http', timestamp: 1, htmlFile: '/fixture/index.html' });
        const early = api.getCollaborationRoomId();
        assert.equal(early, `codexr-session:${server.id}`, 'registered, mapping not written yet');

        fileToServerMap.registerMapping('session-19', { port, url: `http://localhost:${port}`, activeServerId: server.id, fileUri: '/fixture' });
        try {
            assert.equal(api.getCollaborationRoomId(), early, 'the mapping, once written, names the same room');
        } finally {
            fileToServerMap.unregisterMapping('session-19');
            registry.unregisterServer(server.id);
        }
    });
});
