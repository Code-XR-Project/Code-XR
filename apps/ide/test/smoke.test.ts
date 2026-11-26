import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSmoke, type SmokeProbe } from '../src/main/smoke.ts';

const healthy: SmokeProbe = {
    title: 'Code-XR',
    apiType: 'object',
    apiFrozen: true,
    apiKeys: ['app'],
    requireType: 'undefined',
    processType: 'undefined',
    evalBlocked: true,
    windowOpenBlocked: true,
    welcomeRendered: true,
    infoName: 'Code-XR IDE',
    infoError: null,
    explorerItems: ['scripts', 'src', 'test', 'package.json'],
    readFileKind: 'text',
    traversalRefused: true,
};

describe('evaluateSmoke', () => {
    it('passes a healthy probe', () => {
        const result = evaluateSmoke(healthy, true, 'linux');
        assert.deepEqual(result.failures, []);
        assert.equal(result.ok, true);
    });

    const breakages: Array<[string, Partial<SmokeProbe>, RegExp]> = [
        ['Node reachable', { requireType: 'function' }, /require/],
        ['process reachable', { processType: 'object' }, /process/],
        ['no bridge', { apiType: 'undefined' }, /window\.codexr/],
        ['eval allowed', { evalBlocked: false }, /eval/],
        ['window.open allowed', { windowOpenBlocked: false }, /window\.open/],
        ['IPC broken', { infoName: null, infoError: 'Error: Refused.' }, /Refused/],
        ['blank page', { welcomeRendered: false }, /welcome/],
        ['empty explorer', { explorerItems: [] }, /explorer/],
        ['unreadable file', { readFileKind: null }, /readFile failed/],
        ['traversal allowed', { traversalRefused: false }, /out of the folder/],
    ];
    for (const [name, change, message] of breakages) {
        it(`fails when ${name}`, () => {
            const result = evaluateSmoke({ ...healthy, ...change }, true, 'linux');
            assert.equal(result.ok, false);
            assert.ok(result.failures.some((f) => message.test(f)), result.failures.join('; '));
        });
    }

    it('fails when navigation escaped the app', () => {
        assert.equal(evaluateSmoke(healthy, false, 'win32').ok, false);
    });

    it('fails when the renderer never answered', () => {
        assert.equal(evaluateSmoke(null, true, 'darwin').ok, false);
    });
});
