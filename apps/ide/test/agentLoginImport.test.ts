import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agent, methods, type AgentContext } from '@agentclientprotocol/sdk';
import { applySessionEvent, emptySession, type AgentSessionMessage } from '../src/shared/agentSession.ts';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';
import { AcpConnection } from '../src/main/agentSessions/acpConnection.ts';
import { AgentCatalog, loginProgram } from '../src/main/agentSessions/agentCatalog.ts';
import { AgentSessionService, type WindowPort } from '../src/main/agentSessions/agentSessionService.ts';
import { SessionStore } from '../src/main/agentSessions/sessionStore.ts';
import { importedWhen, setupActions } from '../src/renderer/agentFirst/agentSetupModel.ts';

/**
 * #297 (sign-in) and #298 (import of an agent's own chats), against an
 * in-process ACP agent that answers `auth/status`, `session/list` and
 * `session/load` the way Claude Code's and Codex's adapters do.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-agent-login-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

interface FakeOptions {
    signedIn: boolean | 'unknown';
    /** The agent's own history: sessions of this folder and of another one. */
    history: { readonly sessionId: string; cwd: string; readonly title?: string; readonly updatedAt?: string }[];
    pageSize?: number;
}

interface FakeLog {
    loads: string[];
    lists: number;
    lastLoadCwd?: string;
}

function historyAgent(options: FakeOptions, log: FakeLog) {
    let client: AgentContext | null = null;
    const update = (sessionId: string, value: unknown): Promise<void> => (client as AgentContext).notify(methods.client.session.update, { sessionId, update: value as never });
    return agent({ name: 'history' })
        .onConnect((connection) => {
            client = connection.client;
        })
        .onRequest(methods.agent.initialize, () => ({
            protocolVersion: 1,
            agentCapabilities: {
                loadSession: true,
                sessionCapabilities: { list: {} },
                ...(options.signedIn === 'unknown' ? {} : { auth: { status: {} } }),
            } as never,
            authMethods: [{ id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal', args: ['--cli', 'auth', 'login', '--claudeai'] }] as never,
        }))
        // A custom method for this SDK (an ACP draft): it needs a params parser.
        .onRequest('auth/status', { parse: (params: unknown) => params }, () => (options.signedIn === true
            ? { state: 'authenticated', accounts: [{ label: 'Claude Max', email: 'person@example.invalid', active: true }] }
            : { state: 'unauthenticated' }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'fresh-1' }))
        .onRequest(methods.agent.session.list, ({ params }) => {
            log.lists += 1;
            const size = options.pageSize ?? 100;
            const start = params.cursor ? Number(params.cursor) : 0;
            // An empty cwd stands for the folder asked about.
            const page = options.history.slice(start, start + size).map((session) => ({ ...session, cwd: session.cwd || params.cwd || '' }));
            const next = start + size < options.history.length ? String(start + size) : null;
            return { sessions: page, nextCursor: next };
        })
        .onRequest(methods.agent.session.load, async ({ params }) => {
            log.loads.push(params.sessionId);
            log.lastLoadCwd = params.cwd;
            const sid = params.sessionId;
            // The replay: the person's message in two chunks, the answer, a second exchange.
            await update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Add a ' } });
            await update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'test' } });
            await update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done, I added it.' } });
            await update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Thanks' } });
            await update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'You are welcome.' } });
            await update(sid, { sessionUpdate: 'usage_update', used: 10, size: 100 });
            return {};
        })
        .onRequest(methods.agent.session.prompt, async ({ params }) => {
            await update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Live answer' } });
            return { stopReason: 'end_turn' };
        });
}

async function setup(name: string, options: FakeOptions) {
    const root = path.join(base, name, 'project');
    fs.mkdirSync(root, { recursive: true });
    const catalog = new AgentCatalog({ packagesDir: path.join(base, name, 'packages'), store: new JsonKeyValueStore(path.join(base, name, 'agents.json')), env: { PATH: '' }, platform: process.platform, execPath: process.execPath, builtinProfiles: () => Promise.resolve([]) });
    const custom = await catalog.saveCustom({ name: 'History', command: process.execPath, args: [] });
    const log: FakeLog = { loads: [], lists: 0 };
    const messages: AgentSessionMessage[] = [];
    const window: WindowPort = { id: 1, send: (message) => messages.push(message), isDestroyed: () => false };
    const terminals: { command: string; args: readonly string[]; cols: number; rows: number; title: string; env: Readonly<Record<string, string>> }[] = [];
    const store = new SessionStore(path.join(base, name, 'sessions'), { debounceMs: 5 });
    const service = new AgentSessionService({
        catalog,
        store,
        decisions: new JsonKeyValueStore(path.join(base, name, 'decisions.json')),
        rootOf: () => root,
        isTrusted: () => true,
        readText: (file) => fs.promises.readFile(file, 'utf8'),
        writeText: (file, content) => fs.promises.writeFile(file, content),
        openTerminal: (_window, request) => {
            terminals.push(request);
            return Promise.resolve({
                terminal: { terminal: { id: 7, profile: { id: 'program', name: request.title, path: request.command, args: [...request.args], source: 'custom' }, cwd: request.cwd }, title: request.title, command: [request.command, ...request.args].join(' ') },
                exited: new Promise<number>(() => undefined),
            });
        },
        connect: (_launch, _cwd, handlers) => AcpConnection.inProcess(historyAgent(options, log), handlers),
        beforePrompt: () => Promise.resolve({ checkpointId: 'cp-1' }),
        spawnAllowed: true,
        probeDir: path.join(base, name, 'probe'),
        homeDir: os.homedir(),
        terminalEnv: { PATH: process.env['PATH'] ?? '' },
    });
    return { root, service, window, messages, log, terminals, store, catalog, ref: `acp:${custom.id}` };
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 300; i++) {
        if (await check()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}.`);
}

describe('agent sign-in (#297)', () => {
    it('runs the login program itself: the terminal-auth command, or the agent with the method\'s arguments', () => {
        const launch = { command: '/ide/electron', args: ['/pkgs/adapter/dist/index.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };
        assert.deepEqual(loginProgram(launch, { command: '/ide/electron', args: ['/pkgs/adapter/dist/index.js', '--cli', 'auth', 'login'] }), { command: '/ide/electron', args: ['/pkgs/adapter/dist/index.js', '--cli', 'auth', 'login'] });
        assert.deepEqual(loginProgram(launch, { args: ['--login'] }), { command: '/ide/electron', args: ['/pkgs/adapter/dist/index.js', '--login'] });
        assert.deepEqual(loginProgram(launch, {}), { command: '/ide/electron', args: ['/pkgs/adapter/dist/index.js'] });
        // A cmd.exe launch cannot be handed to a terminal unchanged.
        assert.throws(() => loginProgram({ command: 'cmd.exe', args: ['/d', '/s', '/c', '"agent.cmd"'], env: {}, verbatimArguments: true }, { args: ['--login'] }), /yourself in a terminal/);
    });

    it('starts the terminal sign-in as a program, sized as the panel asked, with the agent\'s environment', async () => {
        const { service, window, terminals, ref, root } = await setup('login-terminal', { signedIn: false, history: [] });
        await service.probeAgent(window, ref);
        const opened = await service.login(window, ref, 'claude-ai-login', 120, 40);
        assert.ok(opened);
        assert.equal(opened.terminal.id, 7);
        assert.equal(terminals.length, 1);
        const [request] = terminals;
        assert.equal(request?.command, process.execPath);
        assert.deepEqual(request?.args, ['--cli', 'auth', 'login', '--claudeai']);
        assert.equal(request?.cols, 120);
        assert.equal(request?.rows, 40);
        assert.equal((request as { cwd?: string } | undefined)?.cwd, root);
        assert.equal(request?.title, 'History: Claude Subscription');
        // Silly sizes fall back to a sane terminal.
        await service.login(window, ref, 'claude-ai-login', -3, 'x');
        assert.deepEqual([terminals[1]?.cols, terminals[1]?.rows], [100, 30]);
    });

    it('reports a signed-out agent as needing a login even though it opens sessions, and names the account once signed in', async () => {
        const signedOut = await setup('status-out', { signedIn: false, history: [] });
        const out = await signedOut.service.probeAgent(signedOut.window, signedOut.ref);
        assert.equal(out.availability, 'needs-login');
        assert.ok(out.authMethods?.some((method) => method.id === 'claude-ai-login'));

        const signedIn = await setup('status-in', { signedIn: true, history: [] });
        const ready = await signedIn.service.probeAgent(signedIn.window, signedIn.ref);
        assert.equal(ready.availability, 'ready');
        assert.equal(ready.detail, 'Signed in as person@example.invalid.');

        // An agent that cannot say is judged by session/new, as before.
        const silent = await setup('status-unknown', { signedIn: 'unknown', history: [] });
        assert.equal((await silent.service.probeAgent(silent.window, silent.ref)).availability, 'ready');
    });
});

describe('importing an agent\'s own chats (#298)', () => {
    it('lists the folder\'s chats from the agent, across pages, newest first, without other folders\' ones', async () => {
        const { service, window, ref, root, log } = await setup('import-list', {
            signedIn: true,
            pageSize: 2,
            history: [
                { sessionId: 'old', cwd: '', title: 'Old  chat\nwith lines', updatedAt: '2026-11-01T10:00:00Z' },
                { sessionId: 'new', cwd: '', title: 'Newest', updatedAt: '2026-11-26T10:00:00Z' },
                { sessionId: 'other', cwd: path.join(base, 'elsewhere'), title: 'Another project' },
                { sessionId: 'untitled', cwd: '' },
            ],
        });
        const found = await service.listImportable(window, ref);
        assert.ok(log.lists >= 2, 'it followed the cursor');
        assert.deepEqual(found.map((session) => session.agentSessionId), ['new', 'old', 'untitled']);
        assert.equal(found[1]?.title, 'Old chat with lines');
        assert.equal(found[2]?.title, 'Imported chat');
        assert.equal(found[2]?.updatedAt, null);
        assert.ok(root);
    });

    it('imports chosen chats once, then reads each one\'s messages from the agent when it is opened', async () => {
        const history = [{ sessionId: 'claude-1', cwd: '', title: 'Add a test', updatedAt: '2026-11-20T09:30:00Z' }];
        const { service, window, ref, log, store, root } = await setup('import-run', { signedIn: true, history });
        const found = await service.listImportable(window, ref);
        assert.equal(found.length, 1);
        assert.equal(await service.importSessions(window, ref, found), 1);
        // Twice is a no-op, and the list no longer offers it.
        assert.equal(await service.importSessions(window, ref, found), 0);
        assert.deepEqual(await service.listImportable(window, ref), []);

        const projects = await service.listProjects(window);
        const summary = projects.find((project) => project.current)?.sessions[0];
        assert.ok(summary);
        assert.equal(summary.title, 'Add a test');
        assert.equal(summary.updatedAt, '2026-11-20T09:30:00.000Z');

        // Opening it loads the agent's session and keeps the replay as the transcript.
        const first = await service.get(window, summary.id);
        assert.equal(first.historyPending, true);
        await waitFor(async () => (await service.get(window, summary.id)).historyPending !== true, 'the history to load');
        const state = await service.get(window, summary.id);
        assert.deepEqual(log.loads, ['claude-1']);
        assert.equal(log.lastLoadCwd, root);
        assert.deepEqual(state.items.filter((item) => item.kind === 'user' || item.kind === 'assistant').map((item) => [item.kind, 'text' in item ? item.text : '']), [
            ['user', 'Add a test'],
            ['assistant', 'Done, I added it.'],
            ['user', 'Thanks'],
            ['assistant', 'You are welcome.'],
        ]);
        assert.equal(state.agentSessionId, 'claude-1');

        // The chat continues the same agent session, and the history is not read again.
        await service.prompt(window, summary.id, 'go on', []);
        await waitFor(async () => (await service.get(window, summary.id)).items.some((item) => item.kind === 'assistant' && 'text' in item && item.text === 'Live answer'), 'the live answer');
        assert.deepEqual(log.loads, ['claude-1']);

        // The flag is stored, and cleared once read.
        await waitFor(async () => (await store.load(root, summary.id))?.historyPending === undefined, 'the store to settle');
    });

    it('refuses bad input and folders the agent cannot list', async () => {
        const { service, window, ref } = await setup('import-bad', { signedIn: true, history: [] });
        await assert.rejects(service.importSessions(window, ref, 'nope'), /at most/);
        assert.equal(await service.importSessions(window, ref, [{ agentSessionId: '' }, { title: 'no id' }, 42]), 0);
        await assert.rejects(service.listImportable(window, 'acp:nobody'), /Only an ACP agent/);
    });
});

describe('import and sign-in helpers (#297, #298)', () => {
    it('offers Import once an agent is ready, and dates chats briefly', () => {
        const view = { ref: 'acp:claude', name: 'Claude Code', kind: 'acp' as const, description: '', availability: 'ready' as const };
        assert.ok(setupActions(view).includes('import'));
        assert.ok(!setupActions({ ...view, availability: 'needs-login' }).includes('import'));
        const now = new Date(2026, 10, 27, 18, 0);
        assert.equal(importedWhen(null, now), '');
        assert.equal(importedWhen('not a date', now), '');
        assert.equal(importedWhen(new Date(2026, 10, 27, 9, 5).toISOString(), now), 'Today 09:05');
        assert.equal(importedWhen(new Date(2026, 10, 12, 9, 5).toISOString(), now), '12 Nov');
        assert.equal(importedWhen(new Date(2025, 0, 3).toISOString(), now), '3 Jan 2025');
    });

    it('sets and clears the pending-history flag in the shared reducer', () => {
        const state = emptySession({ id: 's', title: 't', agentRef: 'acp:x', agentName: 'X', workspaceRoot: '/p', createdAt: 'a', updatedAt: 'a' });
        const pending = applySessionEvent(state, { type: 'history', pending: true });
        assert.equal(pending.historyPending, true);
        assert.equal('historyPending' in applySessionEvent(pending, { type: 'history', pending: false }), false);
    });
});
