import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describePythonEnv, installHelp, setUpConsent, type PythonFacts } from '../src/main/python/pythonStatus.ts';

const facts = (over: Partial<PythonFacts> = {}): PythonFacts => ({
    busy: null,
    venvValid: false,
    venvRecorded: false,
    packagesOk: null,
    venvPythonVersion: null,
    systemPython: { version: '3.12.3', launcher: 'python3' },
    lastError: null,
    venvPath: '/home/a/.config/Code-XR IDE/core/python-env/venv',
    packages: [{ name: 'lizard', version: '1.17.31', purpose: 'code complexity analysis' }],
    platform: 'linux',
    ...over,
});

describe('describePythonEnv', () => {
    it('is not set up when Python is found and nothing exists yet', () => {
        const status = describePythonEnv(facts());
        assert.equal(status.state, 'not-installed');
        assert.match(status.message, /3\.12\.3 found/);
        assert.equal(status.pythonVersion, '3.12.3');
    });

    it('explains how to install Python when none answers', () => {
        const status = describePythonEnv(facts({ systemPython: null }));
        assert.equal(status.state, 'missing-python');
        assert.equal(status.detail, installHelp('linux'));
    });

    it('is ready only when the venv is valid and every package imports', () => {
        assert.equal(describePythonEnv(facts({ venvValid: true, packagesOk: true, venvPythonVersion: '3.11.2' })).state, 'ready');
        assert.match(describePythonEnv(facts({ venvValid: true, packagesOk: true })).message, /^The Python environment is ready/);
        const missing = describePythonEnv(facts({ venvValid: true, packagesOk: false }));
        assert.equal(missing.state, 'broken');
        assert.match(missing.message, /packages are missing/);
    });

    it('needs repair when a recorded venv is damaged or the last set-up failed', () => {
        assert.equal(describePythonEnv(facts({ venvRecorded: true })).state, 'broken');
        const failed = describePythonEnv(facts({ lastError: 'pip exploded' }));
        assert.equal(failed.state, 'broken');
        assert.equal(failed.detail, 'pip exploded');
    });

    it('reports progress while busy, whatever else is true', () => {
        const status = describePythonEnv(facts({ busy: { message: 'Installing lizard...', percent: 80 }, venvValid: true, packagesOk: true }));
        assert.equal(status.state, 'installing');
        assert.equal(status.progress, 80);
        assert.equal(status.message, 'Installing lizard...');
    });

    it('a missing Python wins over a damaged venv, since repair would need it', () => {
        assert.equal(describePythonEnv(facts({ systemPython: null, venvRecorded: true })).state, 'missing-python');
    });
});

describe('installHelp', () => {
    it('names the launchers tried and a way to install on each platform', () => {
        assert.match(installHelp('win32'), /py -3.*python3|python\.org/s);
        assert.match(installHelp('darwin'), /brew install python/);
        assert.match(installHelp('linux'), /python3-venv/);
    });
});

describe('setUpConsent', () => {
    it('lists every package with its version, the source and the location', () => {
        const status = describePythonEnv(facts());
        const consent = setUpConsent(status, 'python3');
        assert.match(consent.message, /^Set up/);
        assert.match(consent.detail, /pypi\.org/);
        assert.match(consent.detail, /lizard 1\.17\.31: code complexity analysis/);
        assert.ok(consent.detail.includes(status.venvPath));
        assert.match(consent.detail, /Nothing is installed system-wide/);
        assert.match(consent.detail, /github\.com/, "the later parser download is disclosed too");
        assert.match(setUpConsent(describePythonEnv(facts({ venvRecorded: true })), 'python3').message, /^Repair/);
    });
});
