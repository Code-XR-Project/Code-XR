import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AgentView, InstallDescription } from '../src/shared/agentSession.ts';
import {
    AgentInstaller, consentDetail, isExactVersion, parsePresetId, platformFit, registryOf, repositoryUrl, resolveAlias, satisfies,
} from '../src/main/agentSessions/agentInstaller.ts';
import {
    describeRows, guideAgent, isUpToDate, onboardingSteps, progressTitle, setupActions, shouldShowOnboarding,
} from '../src/renderer/agentFirst/agentSetupModel.ts';

/**
 * AF2 (#267): the installer against a fake npm registry on localhost and a
 * fake `npm` on PATH, so nothing reaches the network. AF13 (#278): the pure
 * model of the first-run guide.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-agent-installer-'));
const posix = process.platform !== 'win32';

const DOCS: Record<string, unknown> = {
    '/@agentclientprotocol%2Fcodex-acp/latest': {
        name: '@agentclientprotocol/codex-acp',
        version: '2.12.1',
        license: 'Apache-2.0',
        repository: { type: 'git', url: 'git+https://github.com/agentclientprotocol/codex-acp.git' },
        dependencies: { '@openai/codex': '^0.172.0', zod: '4.0.0' },
        dist: { unpackedSize: 2_000_000 },
    },
    '/@agentclientprotocol%2Fcodex-acp': { time: { '2.12.1': '2026-11-20T10:00:00.000Z' } },
    '/@openai%2Fcodex/latest': {
        name: '@openai/codex',
        version: '0.172.3',
        dist: { unpackedSize: 10_000 },
        optionalDependencies: {
            '@openai/codex-linux-x64': 'npm:@openai/codex@0.172.3-linux-x64',
            '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.172.3-darwin-arm64',
            '@openai/codex-win32-x64': 'npm:@openai/codex@0.172.3-win32-x64',
        },
    },
    '/@openai%2Fcodex/0.172.3-linux-x64': { name: '@openai/codex', version: '0.172.3-linux-x64', os: ['linux'], cpu: ['x64'], dist: { unpackedSize: 400_000_000 } },
    '/zod/4.0.0': { name: 'zod', version: '4.0.0', dist: { unpackedSize: 1_000 }, scripts: { postinstall: 'node setup.js' } },
};

let server: http.Server;
let registry = '';
const requests: string[] = [];

const FAKE_NPM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAKE_NPM_FAIL) {
    console.error('npm error code E404');
    console.error('npm error 404 Not Found');
    process.exit(1);
}
const prefix = args[args.indexOf('--prefix') + 1];
const spec = args[args.length - 1];
if (args[0] === 'install') {
    const at = spec.lastIndexOf('@');
    const name = spec.slice(0, at);
    const dir = path.join(prefix, 'node_modules', ...name.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: spec.slice(at + 1), bin: { x: 'index.js' } }));
    console.log('npm http fetch GET 200 ' + name);
    console.log('added 3 packages in 1s');
} else if (args[0] === 'uninstall') {
    fs.rmSync(path.join(prefix, 'node_modules', ...spec.split('/')), { recursive: true, force: true });
    console.log('removed 3 packages in 1s');
}
`;

function makeInstaller(name: string, extraEnv: Record<string, string> = {}, withNpm = true): { installer: AgentInstaller; packagesDir: string; log: string } {
    const dir = path.join(base, name);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const log = path.join(dir, 'npm.log');
    if (withNpm) {
        fs.writeFileSync(path.join(bin, 'npm'), FAKE_NPM, { mode: 0o755 });
    }
    const packagesDir = path.join(dir, 'agent-packages');
    const installer = new AgentInstaller({
        packagesDir,
        fetchJson: async (url) => {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`${response.status}`);
            }
            return response.json() as Promise<unknown>;
        },
        env: { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, npm_config_registry: registry, FAKE_NPM_LOG: log, ELECTRON_RUN_AS_NODE: '1', ...extraEnv },
        platform: 'linux',
        arch: 'x64',
        timeoutMs: 30_000,
    });
    return { installer, packagesDir, log };
}

before(async () => {
    server = http.createServer((request, response) => {
        requests.push(request.url ?? '');
        const doc = DOCS[request.url ?? ''];
        response.writeHead(doc ? 200 : 404, { 'content-type': 'application/json' });
        response.end(JSON.stringify(doc ?? { error: 'Not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

after(() => {
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
});

describe('agent installer: describing (AF2)', () => {
    it('reads nothing until asked, then the version, licence, size, source, native binary and install scripts', async () => {
        const { installer, packagesDir } = makeInstaller('describe');
        assert.equal(requests.length, 0);
        const description = await installer.describe('codex');
        assert.equal(description.packageName, '@agentclientprotocol/codex-acp');
        assert.equal(description.version, '2.12.1');
        assert.equal(description.license, 'Apache-2.0');
        assert.equal(description.unpackedSize, 2_000_000);
        assert.equal(description.repository, 'https://github.com/agentclientprotocol/codex-acp');
        assert.equal(description.published, '2026-11-20T10:00:00.000Z');
        assert.equal(description.registry, registry);
        assert.deepEqual(description.nativeBinaries, [{ name: '@openai/codex: @openai/codex-linux-x64', size: 400_000_000 }]);
        assert.equal(description.dependenciesSize, 10_000 + 1_000 + 400_000_000);
        assert.deepEqual(description.installScripts, ['zod']);
        assert.equal(description.targetDir, packagesDir);
        assert.match(description.command, /^npm install --prefix .+ --omit=dev .*@agentclientprotocol\/codex-acp@2\.12\.1$/);
        assert.equal(description.installedVersion, null);
        assert.ok(requests.includes('/@openai%2Fcodex/0.172.3-linux-x64'));
        const detail = consentDetail(description);
        for (const part of ['@agentclientprotocol/codex-acp@2.12.1', 'Apache-2.0', '1.9 MB', 'https://github.com/agentclientprotocol/codex-acp', 'codex-linux-x64 (381 MB)', 'Install scripts will run for: zod', 'nothing is installed globally']) {
            assert.ok(detail.includes(part), `consent text lacks ${part}:\n${detail}`);
        }
    });

    it('refuses anything but the three presets', async () => {
        const { installer } = makeInstaller('refuse');
        assert.throws(() => parsePresetId('../evil'), /Only Claude Code, Codex and Gemini CLI/);
        await assert.rejects(installer.describe({ id: 'codex' }), /Only Claude Code/);
    });

    it('says plainly when the registry cannot be read', async () => {
        const { installer } = makeInstaller('unreachable');
        await assert.rejects(installer.describe('claude'), /Could not read @agentclientprotocol\/claude-agent-acp from http:\/\/127\.0\.0\.1/);
    });
});

describe('agent installer: installing and removing (AF2)', { skip: !posix && 'the fake npm is a POSIX script' }, () => {
    it('installs nothing when the person declines', async () => {
        const { installer, log } = makeInstaller('decline');
        let shown: InstallDescription | null = null;
        const done = await installer.install('codex', async (description) => {
            shown = description;
            return false;
        }, () => undefined);
        assert.equal(done, false);
        assert.equal((shown as InstallDescription | null)?.version, '2.12.1');
        assert.equal(fs.existsSync(log), false, 'npm must not run');
    });

    it('installs the confirmed version into its private folder, streaming npm output, then removes it', async () => {
        const { installer, packagesDir, log } = makeInstaller('install');
        const lines: string[] = [];
        assert.equal(await installer.install('codex', async () => true, (line) => lines.push(line)), true);
        assert.equal(await installer.installedVersion('codex'), '2.12.1');
        const manifest = JSON.parse(fs.readFileSync(path.join(packagesDir, 'package.json'), 'utf8')) as { private?: boolean };
        assert.equal(manifest.private, true);
        assert.ok(lines.some((line) => line.includes('added 3 packages')), lines.join('\n'));
        const args = JSON.parse(fs.readFileSync(log, 'utf8').trim()) as string[];
        assert.deepEqual(args.slice(0, 3), ['install', '--prefix', packagesDir]);
        assert.ok(args.includes('--ignore-scripts=false') && args.includes('--no-audit') && args.includes('--omit=dev'));
        assert.equal(args.at(-1), '@agentclientprotocol/codex-acp@2.12.1');
        assert.ok(!args.some((arg) => arg === '-g' || arg === '--global'));

        // An update describes the installed version too.
        assert.equal((await installer.describe('codex')).installedVersion, '2.12.1');

        let asked = '';
        assert.equal(await installer.uninstall('codex', async (name, version) => {
            asked = `${name}@${version}`;
            return true;
        }, () => undefined), true);
        assert.equal(asked, '@agentclientprotocol/codex-acp@2.12.1');
        assert.equal(await installer.installedVersion('codex'), null);
        await assert.rejects(installer.uninstall('codex', async () => true, () => undefined), /was not installed by Code-XR IDE/);
    });

    it('reports npm\'s own error lines when it fails', async () => {
        const { installer } = makeInstaller('fail', { FAKE_NPM_FAIL: '1' });
        await assert.rejects(installer.install('codex', async () => true, () => undefined), /npm failed \(exit code 1\)\.\n[\s\S]*404 Not Found/);
        assert.equal(installer.running, null);
    });

    it('points to nodejs.org when npm is missing, before asking anything', async () => {
        const { installer } = makeInstaller('no-npm', { PATH: path.join(base, 'no-npm', 'bin') }, false);
        let asked = false;
        await assert.rejects(installer.install('codex', async () => {
            asked = true;
            return true;
        }, () => undefined), /npm was not found on PATH.*https:\/\/nodejs\.org/);
        assert.equal(asked, false);
    });
});

describe('agent installer: helpers', () => {
    it('matches the version ranges adapters use', () => {
        assert.equal(satisfies('0.172.3', '^0.172.0'), true);
        assert.equal(satisfies('0.173.0', '^0.172.0'), false);
        assert.equal(satisfies('4.6.7', '^4.0.0'), true);
        assert.equal(satisfies('5.0.0', '^4.0.0'), false);
        assert.equal(satisfies('2.9.4', '~2.9.1'), true);
        assert.equal(satisfies('2.10.0', '~2.9.1'), false);
        assert.equal(satisfies('1.2.3', '1.2.3'), true);
        assert.equal(satisfies('1.2.4-beta.1', '^1.2.0'), false);
        assert.equal(satisfies('1.2.3', '>=1 <2'), null);
        assert.equal(isExactVersion('0.3.331'), true);
        assert.equal(isExactVersion('^1.0.0'), false);
    });

    it('reads aliases, repositories, platforms and registries', () => {
        assert.deepEqual(resolveAlias('@openai/codex-linux-x64', 'npm:@openai/codex@0.1.0-linux-x64'), { name: '@openai/codex', spec: '0.1.0-linux-x64' });
        assert.deepEqual(resolveAlias('zod', '^4'), { name: 'zod', spec: '^4' });
        assert.equal(repositoryUrl('github:owner/repo'), 'https://github.com/owner/repo');
        assert.equal(repositoryUrl({ url: 'git@github.com:owner/repo.git' }), 'https://github.com/owner/repo');
        assert.equal(repositoryUrl({ url: 'http://example.com/x' }), null);
        assert.equal(platformFit('@x/sdk-linux-x64', 'linux', 'x64'), 2);
        assert.equal(platformFit('@x/sdk-linux-x64-musl', 'linux', 'x64'), 1);
        assert.equal(platformFit('@x/sdk-win32-x64', 'linux', 'x64'), 0);
        assert.equal(platformFit('@x/sdk-darwin-arm64', 'darwin', 'arm64'), 2);
        assert.equal(registryOf({}), 'https://registry.npmjs.org/');
        assert.equal(registryOf({ npm_config_registry: 'https://mirror.example/npm' }), 'https://mirror.example/npm/');
        assert.equal(registryOf({ npm_config_registry: 'http://mirror.example/' }), 'https://registry.npmjs.org/');
    });
});

// ---- Renderer models (AF2 actions, AF13 first run) ----------------------------

function agent(overrides: Partial<AgentView>): AgentView {
    return { ref: 'acp:claude', name: 'Claude Code', kind: 'acp', description: '', availability: 'ready', preset: 'claude', ...overrides };
}

describe('agent setup model', () => {
    it('offers Install for a missing preset, Update and Remove for one the IDE installed', () => {
        assert.deepEqual(setupActions(agent({ availability: 'missing' })), ['install']);
        const { preset: _preset, ...custom } = agent({ availability: 'missing', ref: 'acp:custom-12345678' });
        assert.deepEqual(setupActions(custom), []);
        assert.deepEqual(setupActions(agent({ availability: 'available' })), ['check']);
        assert.deepEqual(setupActions(agent({ availability: 'needs-login', authMethods: [{ id: 'a', name: 'Log in', type: 'terminal' }], installedVersion: '1.0.0' })), ['login', 'check', 'update', 'remove']);
        assert.deepEqual(setupActions(agent({ kind: 'builtin', ref: 'builtin:x' })), []);
    });

    it('describes an install in rows and knows when it is up to date', () => {
        const description: InstallDescription = {
            presetId: 'claude', agentName: 'Claude Code', packageName: '@agentclientprotocol/claude-agent-acp', version: '1.0.0', license: null,
            unpackedSize: 3_364_087, dependenciesSize: null, repository: null, homepage: null, published: null, registry: 'https://registry.npmjs.org/',
            dependencies: [], nativeBinaries: [], installScripts: [], targetDir: '/data/agent-packages', command: 'npm install x', installedVersion: '1.0.0',
        };
        const rows = Object.fromEntries(describeRows(description));
        assert.equal(rows['Licence'], 'Not stated');
        assert.equal(rows['Size'], '3.2 MB');
        assert.equal(rows['Source'], 'https://registry.npmjs.org/');
        assert.equal(rows['Install scripts'], 'None declared');
        assert.equal(isUpToDate(description), true);
        assert.equal(isUpToDate({ ...description, version: '1.1.0' }), false);
        assert.equal(progressTitle({ action: 'uninstall' }, 'Codex'), 'Removing Codex');
    });

    it('walks the three first-run steps from the real state', () => {
        const missing = [agent({ availability: 'missing' }), agent({ ref: 'acp:codex', name: 'Codex', preset: 'codex', availability: 'missing' })];
        let steps = onboardingSteps({ hasFolder: false, agents: missing, chosen: null, hasChat: false });
        assert.deepEqual(steps.map((step) => step.state), ['current', 'todo', 'todo']);
        assert.match(steps[1]?.text ?? '', /Nothing is downloaded until you confirm/);

        steps = onboardingSteps({ hasFolder: true, agents: missing, chosen: null, hasChat: false });
        assert.deepEqual(steps.map((step) => step.state), ['done', 'current', 'todo']);

        const login = [agent({ availability: 'needs-login' })];
        assert.match(onboardingSteps({ hasFolder: true, agents: login, chosen: null, hasChat: false })[1]?.text ?? '', /Sign in/);

        const usable = [agent({ availability: 'available' }), agent({ ref: 'acp:codex', name: 'Codex', preset: 'codex', availability: 'ready' })];
        assert.equal(guideAgent({ agents: usable, chosen: null })?.ref, 'acp:codex', 'a ready agent before an unchecked one');
        assert.equal(guideAgent({ agents: usable, chosen: 'acp:claude' })?.ref, 'acp:claude');
        steps = onboardingSteps({ hasFolder: true, agents: usable, chosen: 'acp:claude', hasChat: false });
        assert.deepEqual(steps.map((step) => step.state), ['done', 'done', 'current']);
        assert.deepEqual(onboardingSteps({ hasFolder: true, agents: usable, chosen: null, hasChat: true }).map((step) => step.state), ['done', 'done', 'done']);
        // An agent can be set up before a folder is open; the folder is still the next step.
        assert.deepEqual(onboardingSteps({ hasFolder: false, agents: usable, chosen: null, hasChat: false }).map((step) => step.state), ['current', 'done', 'todo']);
    });

    it('opens on its own only on a first run', () => {
        assert.equal(shouldShowOnboarding(null, false), true);
        assert.equal(shouldShowOnboarding('true', false), false);
        assert.equal(shouldShowOnboarding(null, true), false);
    });
});
