import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agent, methods } from '@agentclientprotocol/sdk';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';
import { AcpConnection, type AgentLaunch } from '../src/main/agentSessions/acpConnection.ts';
import { mapAuthMethods } from '../src/main/agentSessions/acpMapping.ts';
import { AgentCatalog, agentEnvironment, consoleLoginProgram, type AgentSecrets } from '../src/main/agentSessions/agentCatalog.ts';
import { AgentSessionService, type WindowPort } from '../src/main/agentSessions/agentSessionService.ts';
import { SessionStore } from '../src/main/agentSessions/sessionStore.ts';
import { setupActions } from '../src/renderer/agentFirst/agentSetupModel.ts';

/**
 * #297, every agent: API-key methods (Codex, Gemini CLI), `auth/status`
 * answering `unknown` while the agent still reads its login, `initialize`
 * before `authenticate`, and terminal sign-ins on Windows.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-agent-key-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

function memorySecrets(): AgentSecrets & { readonly keys: Map<string, string> } {
    const keys = new Map<string, string>();
    return {
        keys,
        get: (id) => keys.get(id),
        set: (id, key) => {
            keys.set(id, key);
            return Promise.resolve();
        },
        delete: (id) => {
            keys.delete(id);
            return Promise.resolve();
        },
    };
}

interface KeyAgentLog {
    calls: string[];
    authEnv: (string | undefined)[];
    statusCalls: number;
}

/** Codex-like: an API-key method marked with `_meta["api-key"]`, accepting only `sk-good`, and an `auth/status` that reads in the background. */
function keyAgent(launch: AgentLaunch, log: KeyAgentLog, unknownAnswers: number) {
    let initialized = false;
    let signedIn = launch.env['OPENAI_API_KEY'] === 'sk-good';
    return agent({ name: 'key' })
        .onRequest(methods.agent.initialize, () => {
            initialized = true;
            log.calls.push('initialize');
            return {
                protocolVersion: 1,
                agentCapabilities: { auth: { status: {} } } as never,
                authMethods: [
                    { id: 'api-key', name: 'API Key', description: 'Use an API key', _meta: { 'api-key': { provider: 'openai' } } },
                    { id: 'chat-gpt', name: 'ChatGPT' },
                ] as never,
            };
        })
        .onRequest('auth/status', { parse: (params: unknown) => params }, () => {
            log.statusCalls += 1;
            if (log.statusCalls <= unknownAnswers) {
                return { state: 'unknown' };
            }
            return signedIn ? { state: 'authenticated', accounts: [{ label: 'API key' }] } : { state: 'unauthenticated' };
        })
        .onRequest(methods.agent.authenticate, ({ params }) => {
            log.calls.push(`authenticate:${params.methodId}`);
            log.authEnv.push(launch.env['OPENAI_API_KEY']);
            if (!initialized) {
                throw new Error('authenticate before initialize');
            }
            if (params.methodId === 'api-key' && launch.env['CODEX_API_KEY'] !== 'sk-good') {
                throw new Error('Incorrect API key provided');
            }
            signedIn = true;
            return {};
        })
        .onRequest(methods.agent.session.new, () => {
            if (!signedIn) {
                throw Object.assign(new Error('Authentication required'), { code: -32000 });
            }
            return { sessionId: 's-1' };
        });
}

async function setup(name: string, unknownAnswers = 0) {
    const root = path.join(base, name, 'project');
    fs.mkdirSync(root, { recursive: true });
    const secrets = memorySecrets();
    const catalog = new AgentCatalog({ packagesDir: path.join(base, name, 'packages'), store: new JsonKeyValueStore(path.join(base, name, 'agents.json')), env: { PATH: '', DISPLAY: ':0', SECRET_THING: 'no' }, platform: process.platform, execPath: process.execPath, builtinProfiles: () => Promise.resolve([]), secrets });
    const custom = await catalog.saveCustom({ name: 'Keyed', command: process.execPath, args: [] });
    const log: KeyAgentLog = { calls: [], authEnv: [], statusCalls: 0 };
    const launches: AgentLaunch[] = [];
    const window: WindowPort = { id: 1, send: () => undefined, isDestroyed: () => false };
    const service = new AgentSessionService({
        catalog,
        store: new SessionStore(path.join(base, name, 'sessions'), { debounceMs: 5 }),
        decisions: new JsonKeyValueStore(path.join(base, name, 'decisions.json')),
        rootOf: () => root,
        isTrusted: () => true,
        readText: (file) => fs.promises.readFile(file, 'utf8'),
        writeText: (file, content) => fs.promises.writeFile(file, content),
        openTerminal: () => Promise.reject(new Error('no terminal here')),
        connect: (launch, _cwd, handlers) => {
            launches.push(launch);
            return AcpConnection.inProcess(keyAgent(launch, log, unknownAnswers), handlers);
        },
        beforePrompt: () => Promise.resolve({ checkpointId: 'cp-1' }),
        spawnAllowed: true,
        probeDir: path.join(base, name, 'probe'),
        homeDir: os.homedir(),
        terminalEnv: { PATH: '' },
    });
    return { service, catalog, secrets, log, launches, window, ref: `acp:${custom.id}` };
}

describe('sign-in for every agent (#297)', () => {
    it('reads Codex\'s and Gemini CLI\'s key methods as api-key methods with their provider', () => {
        const specs = mapAuthMethods([
            { id: 'api-key', name: 'API Key', _meta: { 'api-key': { provider: 'openai' } } },
            { id: 'gemini-api-key', name: 'Gemini API key', _meta: { 'api-key': { provider: 'google' } } },
            { id: 'odd-key', name: 'Odd', _meta: { 'api-key': { provider: 'somewhere' } } },
            { id: 'oauth-personal', name: 'Log in with Google' },
        ]);
        assert.deepEqual(specs.map((spec) => [spec.view.id, spec.view.type, spec.view.provider ?? null]), [
            ['api-key', 'api-key', 'openai'],
            ['gemini-api-key', 'api-key', 'google'],
            // A provider the IDE has no variable for stays the agent's own method.
            ['odd-key', 'agent', null],
            ['oauth-personal', 'agent', null],
        ]);
    });

    it('lets agents open the browser on a Linux desktop, and passes nothing else', () => {
        const env = agentEnvironment({ PATH: '/bin', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XAUTHORITY: '/x', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/b', BROWSER: 'firefox', GITHUB_TOKEN: 'secret' }, null, {});
        assert.deepEqual(Object.keys(env).sort(), ['BROWSER', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'PATH', 'WAYLAND_DISPLAY', 'XAUTHORITY']);
    });

    it('keeps a pasted key in the secret store, gives it to that agent only, and signs it in', async () => {
        const { service, catalog, secrets, log, launches, window, ref } = await setup('key-ok');
        const before = await service.probeAgent(window, ref);
        assert.equal(before.availability, 'needs-login');
        assert.ok(before.authMethods?.some((method) => method.type === 'api-key' && method.provider === 'openai'));
        const view = await service.signInWithKey(window, ref, 'api-key', '  sk-good  ');
        assert.equal(view.availability, 'ready');
        assert.equal(view.keySaved, true);
        assert.equal(secrets.keys.get(ref), 'sk-good');
        // Initialize always comes first; the agent started with the key in both of Codex's variables.
        assert.deepEqual(log.calls.slice(log.calls.indexOf('authenticate:api-key') - 1, log.calls.indexOf('authenticate:api-key') + 1), ['initialize', 'authenticate:api-key']);
        const last = launches.at(-1) as AgentLaunch;
        assert.equal(last.env['OPENAI_API_KEY'], 'sk-good');
        assert.equal(last.env['CODEX_API_KEY'], 'sk-good');
        assert.equal(last.env['SECRET_THING'], undefined);
        // The view the page gets never carries the key.
        assert.ok(!JSON.stringify(await catalog.list()).includes('sk-good'));
        assert.ok(setupActions(view).includes('login'));
        // Every later start carries it, until it is forgotten.
        const resolved = await catalog.resolve(catalog.definition(ref) as never);
        assert.ok(resolved.found && resolved.launch.env['OPENAI_API_KEY'] === 'sk-good');
        const forgotten = await service.forgetKey(window, ref);
        assert.equal(forgotten.keySaved, undefined);
        assert.equal(forgotten.availability, 'needs-login');
        assert.equal(secrets.keys.has(ref), false);
        const again = await catalog.resolve(catalog.definition(ref) as never);
        assert.ok(again.found && again.launch.env['OPENAI_API_KEY'] === undefined);
    });

    it('does not keep a key the agent refused, and refuses an empty or multi-word key', async () => {
        const { service, secrets, window, ref } = await setup('key-bad');
        await service.probeAgent(window, ref);
        await assert.rejects(service.signInWithKey(window, ref, 'api-key', 'sk-wrong'), /did not accept the key/);
        assert.equal(secrets.keys.has(ref), false);
        await assert.rejects(service.signInWithKey(window, ref, 'api-key', '   '), /Paste the key/);
        await assert.rejects(service.signInWithKey(window, ref, 'api-key', 'two words'), /Paste the key/);
        await assert.rejects(service.signInWithKey(window, ref, 'chat-gpt', 'sk-good'), /does not take a key/);
    });

    it('initializes before an agent-side sign-in (Gemini CLI loads its configuration there)', async () => {
        const { service, log, window, ref } = await setup('agent-login');
        await service.probeAgent(window, ref);
        log.calls.length = 0;
        assert.equal(await service.login(window, ref, 'chat-gpt'), null);
        assert.deepEqual(log.calls.slice(0, 2), ['initialize', 'authenticate:chat-gpt']);
    });

    it('asks auth/status again while the agent answers unknown, so a signed-out agent is not Ready', async () => {
        // Codex answers `unknown` at first and reads in the background; Claude Code can time out on a cold start.
        const { service, log, window, ref } = await setup('status-retry', 2);
        const view = await service.probeAgent(window, ref);
        assert.equal(view.availability, 'needs-login');
        assert.equal(log.statusCalls, 3);
    });

    it('runs a JavaScript sign-in with the system Node.js on Windows, never through the IDE executable', async () => {
        const launch: AgentLaunch = { command: 'C:\\ide\\Code-XR IDE.exe', args: ['C:\\pk\\agent\\index.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };
        const program = { command: launch.command, args: ['C:\\pk\\agent\\index.js', '--login'] };
        assert.deepEqual(await consoleLoginProgram(program, launch, { platform: 'win32', findNode: () => Promise.resolve('C:\\node\\node.exe') }), { command: 'C:\\node\\node.exe', args: program.args });
        await assert.rejects(consoleLoginProgram(program, launch, { platform: 'win32', findNode: () => Promise.resolve(null) }), /without Node\.js.*node C:\\pk\\agent\\index\.js --login/);
        // A native program, and every other platform, stay as they are.
        const native = { command: 'C:\\pk\\claude.exe', args: ['auth', 'login'] };
        assert.deepEqual(await consoleLoginProgram(native, launch, { platform: 'win32', findNode: () => Promise.resolve(null) }), native);
        assert.deepEqual(await consoleLoginProgram(program, launch, { platform: 'linux', findNode: () => Promise.resolve(null) }), program);
    });
});
