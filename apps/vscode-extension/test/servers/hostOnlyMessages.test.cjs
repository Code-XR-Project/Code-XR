'use strict';

/**
 * Destructive shared actions are the host's (COLLAB-SYNC-6): a guest cannot
 * delete the project evolution movie or cancel a running comparison/movie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { AnalysisMessageRouter, HOST_ONLY_MESSAGES } = require(path.join(projectRoot, 'out', 'core', 'server', 'analysis', 'analysisMessageRouter.js'));

function createRouter(calls) {
    const host = {
        historicalComparisonService: {},
        projectEvolutionService: {},
        drillDown: { service: null },
    };
    const record = (name) => async () => {
        calls.push(name);
        return true;
    };
    const historical = { handleHistoricalComparisonCancelMessage: record('historical-cancel') };
    const evolution = {
        handleProjectEvolutionClearMessage: record('evolution-clear'),
        handleProjectEvolutionCancelMessage: record('evolution-cancel'),
    };
    return new AnalysisMessageRouter(host, {}, historical, evolution, {});
}

function context(role, local = false) {
    const sent = [];
    return { sent, value: { peerId: 'p', roomId: 'r', local, role, send: (payload) => sent.push(payload), broadcast() {}, upsertSharedEntity() {}, removeSharedEntity() {} } };
}

test('a guest asking for a destructive action is refused; the host and the local person are served', async () => {
    assert.deepEqual([...HOST_ONLY_MESSAGES].sort(), ['historical-comparison-cancel', 'project-evolution-cancel', 'project-evolution-clear']);
    const calls = [];
    const router = createRouter(calls);

    for (const type of HOST_ONLY_MESSAGES) {
        const guest = context('guest');
        assert.equal(await router.handleCollaborationMessage(guest.value, { type, payload: {} }), true);
        assert.equal(guest.sent[0].type, 'error');
        assert.equal(guest.sent[0].payload.code, 'forbidden');
    }
    assert.deepEqual(calls, []);

    await router.handleCollaborationMessage(context('host').value, { type: 'project-evolution-clear', payload: {} });
    await router.handleCollaborationMessage(context('guest', true).value, { type: 'historical-comparison-cancel', payload: {} });
    assert.deepEqual(calls, ['evolution-clear', 'historical-cancel']);
});
