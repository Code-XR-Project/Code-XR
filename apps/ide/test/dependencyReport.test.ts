import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canRepair, describeDependencies, formatDependencies, parseParsersCheck, type CloudflaredStatus, type ParsersStatus } from '../src/main/dependencies/dependencyReport.ts';
import type { PythonEnvStatus } from '../src/shared/api.ts';

const packages = [{ name: 'lizard', version: '1.17.10', purpose: 'metrics' }];

function python(state: PythonEnvStatus['state'], extra: Partial<PythonEnvStatus> = {}): PythonEnvStatus {
    return { state, message: `${state} message`, venvPath: '/data/venv', packages, ...extra };
}

const parsersReady: ParsersStatus = { state: 'ready', total: 22, missing: [] };
const cloudReady: CloudflaredStatus = { state: 'ready', version: '2026.5.2', path: '/data/cloudflared', source: 'managed' };

describe('dependency report (#161)', () => {
    it('lists every dependency as ready when all are installed', () => {
        const lines = describeDependencies(python('ready', { pythonVersion: '3.12.3' }), parsersReady, cloudReady);
        assert.deepEqual(lines.map((line) => line.name), ['Python 3', 'Analysis environment', 'lizard 1.17.10', 'Language parsers (tree-sitter)', 'cloudflared']);
        assert.ok(lines.every((line) => line.state === 'ok'));
        const text = formatDependencies(lines);
        assert.match(text, /^\[ok\] Python 3: Python 3\.12\.3$/m);
        assert.match(text, /^\[ok\] Language parsers \(tree-sitter\): 22 of 22$/m);
        assert.match(text, /^\[ok\] cloudflared: 2026\.5\.2, installed by the IDE$/m);
        assert.equal(canRepair(python('ready'), cloudReady), false);
    });

    it('marks what is missing and offers to install it', () => {
        const cloud: CloudflaredStatus = { state: 'failed', version: '2026.5.2', error: 'HTTP 403' };
        const lines = describeDependencies(python('not-installed', { pythonVersion: '3.12.3' }), { state: 'unknown', total: 0, missing: [] }, cloud);
        const text = formatDependencies(lines);
        assert.match(text, /^\[missing\] Analysis environment: not set up$/m);
        assert.match(text, /^\[missing\] lizard 1\.17\.10: metrics$/m);
        assert.match(text, /^\[problem\] cloudflared: install failed: HTTP 403$/m);
        assert.equal(canRepair(python('ready'), cloud), true);
        assert.equal(canRepair(python('broken'), cloudReady), true);
    });

    it('cannot repair what the IDE does not install', () => {
        const unsupported: CloudflaredStatus = { state: 'unsupported', version: '2026.5.2' };
        assert.equal(canRepair(python('missing-python'), unsupported), false);
        assert.match(formatDependencies(describeDependencies(python('missing-python'), parsersReady, unsupported)), /^\[missing\] Python 3: not found on this computer$/m);
    });

    it('shows a parser set that is only partly there, and a system cloudflared', () => {
        const text = formatDependencies(describeDependencies(python('ready'), { state: 'partial', total: 3, missing: ['zig'] }, { ...cloudReady, source: 'system', path: '/usr/bin/cloudflared' }));
        assert.match(text, /^\[problem\] Language parsers \(tree-sitter\): 2 of 3; missing zig/m);
        assert.match(text, /^\[ok\] cloudflared: on PATH \(\/usr\/bin\/cloudflared\)$/m);
    });

    it('reads the parser check of the backend', () => {
        assert.deepEqual(parseParsersCheck('warn\n{"requested": ["c", "go"], "downloaded": ["c"], "missing": ["go"]}\n'), { state: 'partial', total: 2, missing: ['go'] });
        assert.deepEqual(parseParsersCheck('{"requested": ["c"], "downloaded": ["c"], "missing": []}'), { state: 'ready', total: 1, missing: [] });
        assert.deepEqual(parseParsersCheck('{"requested": ["c"], "downloaded": [], "missing": ["c"]}'), { state: 'missing', total: 1, missing: ['c'] });
        assert.deepEqual(parseParsersCheck('nothing'), { state: 'unknown', total: 0, missing: [] });
    });
});
