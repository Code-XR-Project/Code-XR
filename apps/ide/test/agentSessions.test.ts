import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agent, methods, RequestError, type AgentContext } from '@agentclientprotocol/sdk';
import { applySessionEvent, emptySession, type AgentSessionMessage, type AgentSessionState, type SessionEvent, type TranscriptItem } from '../src/shared/agentSession.ts';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';
import { AcpConnection } from '../src/main/agentSessions/acpConnection.ts';
import { buildPromptBlocks, isAuthRequiredError, mapAuthMethods, mapConfigOptions, mapSessionUpdate, sliceLines, stopReasonOf } from '../src/main/agentSessions/acpMapping.ts';
import { AgentCatalog, agentEnvironment, findOnPath, diskProbe } from '../src/main/agentSessions/agentCatalog.ts';
import { AgentSessionService, type WindowPort } from '../src/main/agentSessions/agentSessionService.ts';
import { keepTail, loginCommandLine } from '../src/main/agentSessions/agentTerminals.ts';
import { SessionStore, projectKey } from '../src/main/agentSessions/sessionStore.ts';
import { SessionChanges } from '../src/main/checkpoints/sessionChanges.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-agent-sessions-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const AT = '2026-11-27T10:00:00.000Z';

function fresh(): AgentSessionState {
    return emptySession({ id: 's1', title: 'New chat', agentRef: 'acp:claude', agentName: 'Claude Code', workspaceRoot: '/p', createdAt: AT, updatedAt: AT });
}

function reduce(events: readonly SessionEvent[], state: AgentSessionState = fresh()): AgentSessionState {
    return events.reduce((current, event) => applySessionEvent(current, event), state);
}

describe('applySessionEvent', () => {
    it('merges consecutive chunks and starts a new item after anything else', () => {
        const state = reduce([
            { type: 'assistant-chunk', text: 'Hel' },
            { type: 'assistant-chunk', text: 'lo' },
            { type: 'thought-chunk', text: 'hmm' },
            { type: 'thought-chunk', text: '...' },
            { type: 'assistant-chunk', text: 'Again' },
        ]);
        assert.deepEqual(state.items.map((item) => [item.kind, 'text' in item ? item.text : '']), [['assistant', 'Hello'], ['thought', 'hmm...'], ['assistant', 'Again']]);
    });

    it('creates a tool card and updates only the fields an update carries', () => {
        const state = reduce([
            { type: 'tool', id: 't1', title: 'Edit a.ts', toolKind: 'edit', status: 'pending', locations: [{ path: '/p/a.ts' }] },
            { type: 'tool', id: 't1', status: 'completed', content: [{ type: 'diff', path: '/p/a.ts', oldText: 'a', newText: 'b' }] },
        ]);
        const tool = state.items[0] as Extract<TranscriptItem, { kind: 'tool' }>;
        assert.equal(tool.title, 'Edit a.ts');
        assert.equal(tool.toolKind, 'edit');
        assert.equal(tool.status, 'completed');
        assert.deepEqual(tool.locations, [{ path: '/p/a.ts' }]);
        assert.equal(tool.content[0]?.type, 'diff');
    });

    it('appends terminal output to the card that shows it and caps it', () => {
        let state = reduce([{ type: 'tool', id: 't1', title: 'Run', content: [{ type: 'terminal', terminalId: 'term-1', output: '', exitCode: null }] }]);
        state = reduce([{ type: 'terminal-output', terminalId: 'term-1', output: 'one\n' }, { type: 'terminal-output', terminalId: 'term-1', output: 'two\n', exitCode: 0 }], state);
        let block = (state.items[0] as Extract<TranscriptItem, { kind: 'tool' }>).content[0];
        assert.deepEqual(block, { type: 'terminal', terminalId: 'term-1', output: 'one\ntwo\n', exitCode: 0 });
        state = reduce([{ type: 'terminal-output', terminalId: 'term-1', output: 'x'.repeat(70_000) }], state);
        block = (state.items[0] as Extract<TranscriptItem, { kind: 'tool' }>).content[0];
        assert.ok(block?.type === 'terminal' && block.output.length === 64_000 && block.truncated === true);
        // Output for a terminal no card shows changes nothing.
        assert.equal(reduce([{ type: 'terminal-output', terminalId: 'other', output: 'x' }], state), state);
    });

    it('waits on permissions and closes open ones when the turn ends', () => {
        const options = [{ id: 'ok', name: 'Allow', kind: 'allow_once' as const }];
        let state = reduce([
            { type: 'user', id: 'u1', text: 'go', at: AT },
            { type: 'permission', id: 'p1', title: 'Run ls', options },
            { type: 'permission', id: 'p2', title: 'Run rm', options },
        ]);
        assert.equal(state.status, 'awaiting');
        state = reduce([{ type: 'permission-resolved', id: 'p1', outcome: 'ok' }], state);
        assert.equal(state.status, 'awaiting');
        state = reduce([{ type: 'turn-end', id: 'e1', stopReason: 'end_turn', at: AT }], state);
        const permissions = state.items.filter((item) => item.kind === 'permission');
        assert.deepEqual(permissions.map((item) => item.outcome), ['ok', 'cancelled']);
        assert.equal(state.status, 'idle');
        assert.equal(state.unread, true);
        state = reduce([{ type: 'read' }], state);
        assert.equal(state.unread, false);
        assert.equal(reduce([{ type: 'read' }], state), state);
    });
});

describe('applySessionEvent: metric deltas (AF9)', () => {
    it('attaches a delta to the turn it names and ignores an unknown turn', () => {
        const delta = { summary: 'x', totals: [{ metric: 'maxComplexity', before: 9, after: 1 }], files: [], moreFiles: 0 };
        const ended = reduce([{ type: 'user', id: 'u1', text: 'go', at: AT }, { type: 'turn-end', id: 'e1', stopReason: 'end_turn', at: AT }]);
        const state = reduce([{ type: 'metric-delta', turnId: 'e1', delta }], ended);
        const turn = state.items.at(-1);
        assert.ok(turn?.kind === 'turn-end');
        assert.deepEqual(turn.metricDelta, delta);
        assert.notEqual(turn, ended.items.at(-1), 'a new item, so the chat redraws it');
        assert.equal(state.updatedAt, ended.updatedAt, 'a late delta does not move the chat up the list');
        assert.equal(reduce([{ type: 'metric-delta', turnId: 'nope', delta }], ended), ended);
    });
});

describe('ACP mapping', () => {
    const ctx = { newId: () => 'n1', terminal: (id: string) => (id === 'term-1' ? { output: 'so far', exitCode: null, truncated: false } : undefined) };

    it('maps every session/update kind it shows and ignores the rest', () => {
        assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }, ctx), [{ type: 'assistant-chunk', text: 'hi' }]);
        assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'th' } }, ctx), [{ type: 'thought-chunk', text: 'th' }]);
        assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'me' } }, ctx), []);
        const [created] = mapSessionUpdate({
            sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run tests', kind: 'execute', status: 'in_progress',
            locations: [{ path: '/p/a.ts', line: 3 }], rawInput: { command: 'npm test' },
            content: [{ type: 'terminal', terminalId: 'term-1' }, { type: 'content', content: { type: 'text', text: 'note' } }, { type: 'diff', path: '/p/b.ts', newText: 'new' }],
        }, ctx);
        assert.deepEqual(created, {
            type: 'tool', id: 't1', title: 'Run tests', toolKind: 'execute', status: 'in_progress',
            locations: [{ path: '/p/a.ts', line: 3 }],
            content: [{ type: 'terminal', terminalId: 'term-1', output: 'so far', exitCode: null }, { type: 'text', text: 'note' }, { type: 'diff', path: '/p/b.ts', oldText: null, newText: 'new' }],
            rawInput: '{"command":"npm test"}',
        });
        assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' }, ctx), [{ type: 'tool', id: 't1', status: 'failed' }]);
        assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'plan', entries: [{ content: 'Test', priority: 'high', status: 'pending' }] }, ctx), [{ type: 'plan', entries: [{ content: 'Test', priority: 'high', status: 'pending' }] }]);
        assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review', input: { hint: 'what' } }] }, ctx), [{ type: 'commands', commands: [{ name: 'review', description: 'Review', hint: 'what' }] }]);
        assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }, ctx), [{ type: 'modes', current: 'plan' }]);
        assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'usage_update', used: 10, size: 100 }, ctx), [{ type: 'usage', used: 10, size: 100 }]);
        assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'session_info_update', title: ' Fix bug ' }, ctx), [{ type: 'title', title: 'Fix bug' }]);
        assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'notice', severity: 'warning', title: 'Slow', description: 'Rate limited' }, ctx), [{ type: 'notice', id: 'n1', level: 'warning', text: 'Slow: Rate limited' }]);
        assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'some_future_kind' } as never, ctx), []);
    });

    it('flattens config options, grouped selects and booleans', () => {
        const options = mapConfigOptions([
            { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'b', options: [{ group: 'g', name: 'G', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B', description: 'best' }] }] },
            { type: 'boolean', id: 'fast', name: 'Fast', currentValue: false },
        ]);
        assert.deepEqual(options, [
            { id: 'model', name: 'Model', category: 'model', current: 'b', values: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', description: 'best' }] },
            { id: 'fast', name: 'Fast', current: 'false', values: [{ id: 'true', name: 'On' }, { id: 'false', name: 'Off' }] },
        ]);
    });

    it('classifies login methods and auth errors', () => {
        const specs = mapAuthMethods([
            { id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal', args: ['--cli', 'auth', 'login'] },
            { id: 'chat-gpt', name: 'ChatGPT' },
            { id: 'key', name: 'API key', type: 'env_var' },
            { id: 'hinted', name: 'Hint', _meta: { 'terminal-auth': { command: 'agy', args: ['acp', '--login'] } } },
        ] as never);
        assert.deepEqual(specs.map((spec) => spec.view.type), ['terminal', 'agent', 'env', 'terminal']);
        assert.deepEqual(specs[0]?.args, ['--cli', 'auth', 'login']);
        assert.equal(specs[3]?.command, 'agy');
        assert.equal(isAuthRequiredError(RequestError.authRequired()), true);
        assert.equal(isAuthRequiredError(new Error('Authentication required')), true);
        assert.equal(isAuthRequiredError(new Error('Disk full')), false);
        assert.equal(stopReasonOf('max_tokens'), 'max_tokens');
        assert.equal(stopReasonOf('weird'), 'end_turn');
    });

    it('builds prompts with embedded files, links and selections, and slices reads', () => {
        const blocks = buildPromptBlocks('Fix it', [
            { kind: 'file', absolutePath: '/p/a.ts', relativePath: 'a.ts', text: 'code' },
            { kind: 'file', absolutePath: '/p/big.bin', relativePath: 'big.bin', text: null },
            { kind: 'selection', absolutePath: '/p/a.ts', relativePath: 'a.ts', startLine: 2, endLine: 3, text: 'x' },
        ], true);
        assert.deepEqual(blocks.map((block) => block.type), ['text', 'resource', 'resource_link', 'text']);
        assert.deepEqual(buildPromptBlocks('t', [{ kind: 'file', absolutePath: '/p/a.ts', relativePath: 'a.ts', text: 'code' }], false).map((block) => block.type), ['text', 'resource_link']);
        assert.equal(sliceLines('1\n2\n3\n4', 2, 2), '2\n3');
        assert.equal(sliceLines('1\n2\n3', null, null), '1\n2\n3');
        assert.equal(sliceLines('1\n2\n3', 3), '3');
    });

    it('keeps the tail of terminal output at a character boundary and builds login lines', () => {
        assert.deepEqual(keepTail('abc', 10), { text: 'abc', truncated: false });
        const kept = keepTail('aé€', 3);
        assert.equal(kept.truncated, true);
        assert.equal(kept.text, '€');
        assert.equal(loginCommandLine('posix', "'/bin/agent' --login", { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' }, { PATH: '/bin' }), "env ELECTRON_RUN_AS_NODE='1' '/bin/agent' --login");
        assert.equal(loginCommandLine('powershell', 'agent', { A: '1' }, {}), "$env:A='1'; agent");
        assert.equal(loginCommandLine('cmd', 'agent', {}, {}), 'agent');
    });
});

describe('SessionStore', () => {
    it('writes chats, lists projects with the current one first, and reloads running chats as idle', async () => {
        const dir = path.join(base, 'store');
        const store = new SessionStore(dir, { debounceMs: 5 });
        const running: AgentSessionState = {
            ...emptySession({ id: 'chat-a', title: 'A', agentRef: 'acp:claude', agentName: 'Claude Code', workspaceRoot: '/projects/one', createdAt: AT, updatedAt: '2026-11-27T10:00:01.000Z' }),
            status: 'awaiting',
            items: [{ kind: 'permission', id: 'p1', title: 'Run', options: [] }],
        };
        await store.saveNow(running);
        store.save({ ...emptySession({ id: 'chat-b', title: 'B', agentRef: 'acp:codex', agentName: 'Codex', workspaceRoot: '/projects/two', createdAt: AT, updatedAt: '2026-11-27T10:00:02.000Z' }) });
        await store.flush();
        await store.saveNow(emptySession({ id: 'chat-c', title: 'C', agentRef: 'acp:codex', agentName: 'Codex', workspaceRoot: '/projects/one', createdAt: AT, updatedAt: '2026-11-27T10:00:03.000Z' }));
        assert.ok(fs.existsSync(path.join(dir, projectKey('/projects/one'), 'chat-a.json')));

        const reopened = new SessionStore(dir);
        const projects = await reopened.listProjects('/projects/two');
        assert.deepEqual(projects.map((project) => [project.root, project.current, project.sessions.map((session) => session.id)]), [
            ['/projects/two', true, ['chat-b']],
            ['/projects/one', false, ['chat-c', 'chat-a']],
        ]);
        const loaded = await reopened.find('chat-a', null);
        assert.equal(loaded?.status, 'idle');
        assert.deepEqual(loaded?.items.map((item) => item.kind === 'permission' && item.outcome), ['cancelled']);
        const empty = await reopened.listProjects('/projects/new');
        assert.equal(empty[0]?.root, '/projects/new');
        assert.deepEqual(empty[0]?.sessions, []);
        await reopened.remove('/projects/one', 'chat-c');
        assert.equal(await reopened.load('/projects/one', 'chat-c'), null);
        assert.equal(await reopened.load('/projects/one', '../escape'), null);
    });
});

describe('AgentCatalog', () => {
    it('finds a preset on PATH, reports a missing one with how to install it, and lists built-in profiles', async () => {
        const bin = path.join(base, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        const agentFile = path.join(bin, 'codex-acp');
        fs.writeFileSync(agentFile, '#!/bin/sh\n');
        fs.chmodSync(agentFile, 0o755);
        const catalog = new AgentCatalog({
            packagesDir: path.join(base, 'packages'),
            store: new JsonKeyValueStore(path.join(base, 'catalog.json')),
            env: { PATH: bin, HOME: '/home/u', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'secret', UNRELATED: 'x' },
            platform: 'linux',
            execPath: process.execPath,
            builtinProfiles: () => Promise.resolve([{ id: 'p1', name: 'Assistant' }]),
        });
        const views = await catalog.list();
        const byRef = new Map(views.map((view) => [view.ref, view]));
        assert.equal(byRef.get('acp:codex')?.availability, 'available');
        assert.equal(byRef.get('acp:claude')?.availability, 'missing');
        assert.match(byRef.get('acp:claude')?.detail ?? '', /Press Install, or install it yourself with: npm install -g @agentclientprotocol\/claude-agent-acp/);
        assert.deepEqual(byRef.get('builtin:p1'), { ref: 'builtin:p1', name: 'Assistant', kind: 'builtin', description: byRef.get('builtin:p1')?.description, availability: 'available' });
        const codex = catalog.definition('acp:codex');
        assert.ok(codex);
        const resolution = await catalog.resolve(codex);
        assert.ok(resolution.found);
        assert.equal(resolution.launch.command, agentFile);
        // Only the vendor's own key reaches the agent.
        assert.equal(resolution.launch.env['OPENAI_API_KEY'], 'k');
        assert.equal(resolution.launch.env['ANTHROPIC_API_KEY'], undefined);
        assert.equal(resolution.launch.env['UNRELATED'], undefined);
        assert.equal(resolution.launch.env['HOME'], '/home/u');
    });

    it('prefers a package the IDE installed, run by its own Node', async () => {
        const packages = path.join(base, 'pkgs');
        const pkg = path.join(packages, 'node_modules', '@google', 'gemini-cli');
        fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', bin: { gemini: 'dist/index.js' } }));
        fs.writeFileSync(path.join(pkg, 'dist', 'index.js'), '');
        const catalog = new AgentCatalog({ packagesDir: packages, store: new JsonKeyValueStore(path.join(base, 'catalog2.json')), env: { PATH: '' }, platform: 'linux', execPath: '/electron', builtinProfiles: () => Promise.resolve([]) });
        const gemini = catalog.definition('acp:gemini');
        assert.ok(gemini);
        const resolution = await catalog.resolve(gemini);
        assert.ok(resolution.found);
        assert.deepEqual([resolution.launch.command, ...resolution.launch.args], ['/electron', path.join(pkg, 'dist', 'index.js'), '--acp']);
        assert.equal(resolution.launch.env['ELECTRON_RUN_AS_NODE'], '1');
    });

    it('validates and stores custom agents', async () => {
        const catalog = new AgentCatalog({ packagesDir: base, store: new JsonKeyValueStore(path.join(base, 'catalog3.json')), env: { PATH: '' }, platform: 'linux', execPath: process.execPath, builtinProfiles: () => Promise.resolve([]) });
        await assert.rejects(catalog.saveCustom({ name: '', command: 'x' }), /name/);
        await assert.rejects(catalog.saveCustom({ name: 'A', command: 'x', env: { 'bad name': 'v' } }), /Environment/);
        const saved = await catalog.saveCustom({ name: 'Mine', command: 'not-on-path-xyz', args: ['acp'], env: { MODE: 'x' } });
        assert.match(saved.id, /^custom-[a-f0-9]{8}$/);
        const view = await catalog.view(saved);
        assert.equal(view.availability, 'missing');
        assert.equal(await findOnPath('not-on-path-xyz', { PATH: base }, 'linux', diskProbe), null);
        await catalog.removeCustom(saved.id);
        assert.deepEqual(catalog.customAgents(), []);
        await assert.rejects(catalog.removeCustom('claude'), /custom/);
        assert.deepEqual(agentEnvironment({ PATH: '/bin', SECRET: 's' }, null, { X: '1' }), { PATH: '/bin', X: '1' });
    });
});

// ---- A full chat against an in-process fake agent -----------------------------

interface FakeAgentLog {
    permissionOutcome?: unknown;
    cancelled: number;
    prompts: unknown[];
}

/** A tiny ACP agent: its behaviour is chosen by the prompt's first word. */
function fakeAgent(log: FakeAgentLog) {
    let client: AgentContext | null = null;
    const update = (sessionId: string, value: unknown): Promise<void> => (client as AgentContext).notify(methods.client.session.update, { sessionId, update: value as never });
    return agent({ name: 'fake' })
        .onConnect((connection) => {
            client = connection.client;
        })
        .onRequest(methods.agent.initialize, () => ({
            protocolVersion: 1,
            agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true } },
            authMethods: [{ id: 'login', name: 'Log in', type: 'terminal', args: ['--login'] }],
        }))
        .onRequest(methods.agent.session.new, () => ({
            sessionId: 'agent-1',
            modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] },
            configOptions: [{ type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }],
        }))
        .onRequest(methods.agent.session.setMode, () => ({}))
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => ({
            configOptions: [{ type: 'select', id: 'model', name: 'Model', currentValue: String(params.value), options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }],
        }))
        .onNotification(methods.agent.session.cancel, () => {
            log.cancelled++;
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client: ctx }) => {
            log.prompts.push(params.prompt);
            const first = params.prompt[0];
            const text = first?.type === 'text' ? first.text : '';
            const [command, arg] = text.split(' ');
            const sid = params.sessionId;
            if (command === 'hello') {
                await update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } });
                await update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' there' } });
                await update(sid, { sessionUpdate: 'plan', entries: [{ content: 'Say hi', priority: 'low', status: 'completed' }] });
                await update(sid, { sessionUpdate: 'usage_update', used: 5, size: 100 });
                return { stopReason: 'end_turn' };
            }
            if (command === 'perm') {
                await update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Run ls', kind: 'execute', status: 'pending' });
                const response = await ctx.request(methods.client.session.requestPermission, {
                    sessionId: sid,
                    toolCall: { toolCallId: 'tc1' },
                    options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
                });
                log.permissionOutcome = response.outcome;
                return { stopReason: response.outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' };
            }
            if (command === 'read' || command === 'write') {
                try {
                    if (command === 'read') {
                        const result = await ctx.request(methods.client.fs.readTextFile, { sessionId: sid, path: arg ?? '', line: 2, limit: 1 });
                        await update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `READ:${result.content}` } });
                    } else {
                        await ctx.request(methods.client.fs.writeTextFile, { sessionId: sid, path: arg ?? '', content: 'written' });
                        await update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WROTE' } });
                    }
                } catch (error) {
                    await update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ERR:${(error as Error).message}` } });
                }
                return { stopReason: 'end_turn' };
            }
            if (command === 'term') {
                const created = await ctx.request(methods.client.terminal.create, { sessionId: sid, command: 'echo', args: ['from terminal'] });
                await update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc2', title: 'echo', kind: 'execute', status: 'in_progress', content: [{ type: 'terminal', terminalId: created.terminalId }] });
                const exit = await ctx.request(methods.client.terminal.waitForExit, { sessionId: sid, terminalId: created.terminalId });
                const output = await ctx.request(methods.client.terminal.output, { sessionId: sid, terminalId: created.terminalId });
                await ctx.request(methods.client.terminal.release, { sessionId: sid, terminalId: created.terminalId });
                await update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc2', status: 'completed' });
                await update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `EXIT:${exit.exitCode} OUT:${output.output.trim()}` } });
                return { stopReason: 'end_turn' };
            }
            if (command === 'auth') {
                throw RequestError.authRequired();
            }
            return { stopReason: 'end_turn' };
        });
}

async function setup(name: string, options: { trusted?: boolean; afterTurn?: () => Promise<number | null>; changes?: SessionChanges } = {}) {
    const root = path.join(base, name, 'project');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(base, name, 'secret.txt'), 'secret');
    const catalog = new AgentCatalog({ packagesDir: path.join(base, name, 'packages'), store: new JsonKeyValueStore(path.join(base, name, 'agents.json')), env: { PATH: '' }, platform: process.platform, execPath: process.execPath, builtinProfiles: () => Promise.resolve([]) });
    const custom = await catalog.saveCustom({ name: 'Fake', command: process.execPath, args: [] });
    const log: FakeAgentLog = { cancelled: 0, prompts: [] };
    const messages: AgentSessionMessage[] = [];
    const window: WindowPort = { id: 1, send: (message) => messages.push(message), isDestroyed: () => false };
    const written: string[] = [];
    const service = new AgentSessionService({
        catalog,
        store: new SessionStore(path.join(base, name, 'sessions'), { debounceMs: 5 }),
        decisions: new JsonKeyValueStore(path.join(base, name, 'decisions.json')),
        rootOf: () => root,
        isTrusted: () => options.trusted ?? true,
        readText: (file) => fs.promises.readFile(file, 'utf8'),
        writeText: async (file, content) => {
            written.push(file);
            await fs.promises.writeFile(file, content);
        },
        openTerminal: () => Promise.reject(new Error('no terminal in tests')),
        connect: (_launch, _cwd, handlers) => AcpConnection.inProcess(fakeAgent(log), handlers),
        ...(options.changes
            ? {
                review: options.changes,
                beforePrompt: (sessionId: string, workspaceRoot: string) => options.changes!.beforePrompt(sessionId, workspaceRoot),
                afterTurn: (sessionId: string, workspaceRoot: string) => options.changes!.afterTurn(sessionId, workspaceRoot),
            }
            : { beforePrompt: () => Promise.resolve({ checkpointId: 'cp-1' }) }),
        ...(options.afterTurn ? { afterTurn: options.afterTurn } : {}),
        spawnAllowed: true,
        probeDir: path.join(base, name, 'probe'),
        homeDir: os.homedir(),
        terminalEnv: { PATH: process.env['PATH'] ?? '' },
        cancelGraceMs: 2000,
    });
    return { root, service, window, messages, log, written, ref: `acp:${custom.id}` };
}

function lastText(state: AgentSessionState): string {
    const item = [...state.items].reverse().find((candidate) => candidate.kind === 'assistant');
    return item && 'text' in item ? item.text : '';
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (check()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}.`);
}

describe('AgentSessionService with a fake ACP agent', () => {
    it('runs a prompt round trip and streams the same events the renderer applies', async () => {
        const { service, window, messages, ref, log } = await setup('roundtrip', { afterTurn: () => Promise.resolve(2) });
        const created = await service.create(window, ref);
        await service.prompt(window, created.id, 'hello world', [{ kind: 'file', path: 'a.txt' }, { kind: 'selection', path: 'a.txt', startLine: 1, endLine: 2, text: 'one\ntwo' }]);
        const state = await service.get(window, created.id);
        assert.equal(lastText(state), 'Hi there');
        assert.equal(state.title, 'hello world');
        assert.equal(state.status, 'idle');
        assert.equal(state.agentSessionId, 'agent-1');
        assert.deepEqual(state.modes?.available.map((mode) => mode.id), ['ask', 'code']);
        assert.equal(state.configOptions[0]?.current, 'a');
        assert.deepEqual(state.usage, { used: 5, size: 100 });
        assert.equal(state.plan.length, 1);
        assert.equal(state.pendingChanges, 2);
        const user = state.items.find((item) => item.kind === 'user');
        assert.ok(user?.kind === 'user');
        assert.deepEqual(user.attachments, ['a.txt', 'a.txt:1-2']);
        assert.equal(user.checkpoint, 'cp-1');
        assert.equal(state.items.at(-1)?.kind, 'turn-end');
        // The file was embedded (the agent accepts embedded context).
        assert.deepEqual((log.prompts[0] as { type: string }[]).map((block) => block.type), ['text', 'resource', 'text']);
        // Replaying the streamed events on the created state gives the main process's state.
        let replayed = created;
        for (const message of messages) {
            if (message.kind === 'event' && message.sessionId === created.id) {
                replayed = applySessionEvent(replayed, message.event, message.updatedAt);
            }
        }
        assert.deepEqual(replayed, state);

        await service.setConfigOption(window, created.id, 'model', 'b');
        await service.setMode(window, created.id, 'code');
        const after = await service.get(window, created.id);
        assert.equal(after.configOptions[0]?.current, 'b');
        assert.equal(after.modes?.current, 'code');
        await service.markRead(window, created.id);
        assert.equal((await service.get(window, created.id)).unread, false);
        const projects = await service.listProjects(window);
        assert.equal(projects[0]?.sessions[0]?.id, created.id);
        await service.remove(window, created.id);
        await assert.rejects(service.get(window, created.id), /no longer exists/);
        await service.stopAll();
    });

    it('asks for permission, waits for the answer and remembers allow_always per agent and tool kind', async () => {
        const { service, window, ref, log } = await setup('permission');
        const created = await service.create(window, ref);
        const turn = service.prompt(window, created.id, 'perm', []);
        let waiting: Extract<TranscriptItem, { kind: 'permission' }> | undefined;
        await waitFor(() => {
            void service.get(window, created.id).then((state) => {
                waiting = state.items.find((item): item is Extract<TranscriptItem, { kind: 'permission' }> => item.kind === 'permission' && item.outcome === undefined);
            });
            return waiting !== undefined;
        }, 'the permission request');
        assert.ok(waiting);
        assert.equal(waiting.title, 'Run ls');
        assert.equal((await service.get(window, created.id)).status, 'awaiting');
        await assert.rejects(service.respondPermission(window, created.id, waiting.id, 'invented'), /not one the agent offered/);
        await service.respondPermission(window, created.id, waiting.id, 'always');
        await turn;
        assert.deepEqual(log.permissionOutcome, { outcome: 'selected', optionId: 'always' });
        // The same agent and tool kind is answered without asking.
        log.permissionOutcome = undefined;
        await service.prompt(window, created.id, 'perm', []);
        assert.deepEqual(log.permissionOutcome, { outcome: 'selected', optionId: 'always' });
        const state = await service.get(window, created.id);
        assert.equal(state.items.filter((item) => item.kind === 'permission').length, 1);
        await service.stopAll();
    });

    it('cancels a waiting permission when the person stops the turn', async () => {
        const { service, window, ref, log } = await setup('cancel');
        const created = await service.create(window, ref);
        const turn = service.prompt(window, created.id, 'perm', []);
        await waitFor(() => log.prompts.length === 1, 'the prompt');
        await new Promise((resolve) => setTimeout(resolve, 30));
        await service.cancel(window, created.id);
        await turn;
        assert.deepEqual(log.permissionOutcome, { outcome: 'cancelled' });
        assert.equal(log.cancelled, 1);
        const state = await service.get(window, created.id);
        const end = state.items.at(-1);
        assert.ok(end?.kind === 'turn-end' && end.stopReason === 'cancelled');
        await service.stopAll();
    });

    it('serves file reads and writes inside the project only', async () => {
        const { root, service, window, ref, written } = await setup('files');
        const created = await service.create(window, ref);
        await service.prompt(window, created.id, `read ${path.join(root, 'a.txt')}`, []);
        assert.equal(lastText(await service.get(window, created.id)), 'READ:two');
        await service.prompt(window, created.id, `read ${path.join(root, '..', 'secret.txt')}`, []);
        assert.match(lastText(await service.get(window, created.id)), /^ERR:.*outside the project folder/);
        await service.prompt(window, created.id, `write ${path.join(root, 'new.txt')}`, []);
        assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'written');
        await service.prompt(window, created.id, `write ${path.join(root, '..', 'evil.txt')}`, []);
        assert.match(lastText(await service.get(window, created.id)), /^ERR:.*outside/);
        assert.equal(fs.existsSync(path.join(root, '..', 'evil.txt')), false);
        if (process.platform !== 'win32') {
            fs.symlinkSync(path.join(root, '..'), path.join(root, 'link'));
            await service.prompt(window, created.id, `read ${path.join(root, 'link', 'secret.txt')}`, []);
            assert.match(lastText(await service.get(window, created.id)), /^ERR:.*outside/);
        }
        assert.deepEqual(written, [path.join(root, 'new.txt')]);
        await assert.rejects(service.prompt(window, created.id, 'x', [{ kind: 'file', path: '../secret.txt' }]), /outside the project/);
        await service.stopAll();
    });

    it('reviews the chat\'s changes: list, diff, undo, keep and restore to a message (AF5, AF6)', async () => {
        const changes = new SessionChanges({ storageDir: path.join(base, 'review', 'checkpoints'), bases: new JsonKeyValueStore(path.join(base, 'review', 'review.json')) });
        const { root, service, window, ref } = await setup('review', { changes });
        const created = await service.create(window, ref);
        const file = path.join(root, 'a.txt');
        await service.prompt(window, created.id, `write ${file}`, []);
        let state = await service.get(window, created.id);
        assert.equal(state.pendingChanges, 1);
        const first = state.items.find((item) => item.kind === 'user');
        assert.ok(first?.kind === 'user' && first.checkpoint && /^[0-9a-f]{40,64}$/.test(first.checkpoint));

        let listed = await service.changes(window, created.id);
        assert.deepEqual(listed.files.map((entry) => [entry.path, entry.status]), [['a.txt', 'modified']]);
        assert.deepEqual(await service.changeDiff(window, created.id, './a.txt'), { path: 'a.txt', oldText: 'one\ntwo\nthree\n', newText: 'written' });

        // Undo puts the file back and the chat's count follows.
        listed = await service.undoChanges(window, created.id, ['a.txt']);
        assert.equal(listed.files.length, 0);
        assert.equal(fs.readFileSync(file, 'utf8'), 'one\ntwo\nthree\n');
        assert.equal((await service.get(window, created.id)).pendingChanges, 0);

        // Keep accepts the change: no longer pending, still on disk.
        await service.prompt(window, created.id, `write ${file}`, []);
        assert.equal((await service.get(window, created.id)).pendingChanges, 1);
        listed = await service.keepChanges(window, created.id, 'all');
        assert.equal(listed.files.length, 0);
        assert.equal(fs.readFileSync(file, 'utf8'), 'written');

        // Restore to the first message: preview lists the file, restore writes it.
        assert.deepEqual(await service.previewRestore(window, created.id, first.checkpoint), ['a.txt']);
        assert.deepEqual(await service.restoreCheckpoint(window, created.id, first.checkpoint), ['a.txt']);
        assert.equal(fs.readFileSync(file, 'utf8'), 'one\ntwo\nthree\n');
        state = await service.get(window, created.id);
        assert.equal(state.pendingChanges, 1, 'the restore differs from what was kept');

        // The renderer is untrusted: foreign checkpoints, paths that leave the project and bad lists are refused.
        await assert.rejects(service.restoreCheckpoint(window, created.id, 'a'.repeat(40)), /not part of this chat/);
        await assert.rejects(service.changeDiff(window, created.id, '../secret.txt'), /cannot leave the project/);
        await assert.rejects(service.undoChanges(window, created.id, []), /Invalid list/);
        await assert.rejects(service.keepChanges(window, created.id, [42]), /Invalid file path/);
        await assert.rejects(service.undoChanges(window, created.id, ['.git/config']), /\.git/);
        await service.remove(window, created.id);
        assert.equal(changes.reviewBase(created.id), null);
        await service.stopAll();
        await changes.dispose();
    });

    it('refuses to undo or restore while the agent works', async () => {
        const changes = new SessionChanges({ storageDir: path.join(base, 'review-busy', 'checkpoints'), bases: new JsonKeyValueStore(path.join(base, 'review-busy', 'review.json')) });
        const { service, window, ref, log } = await setup('review-busy', { changes });
        const created = await service.create(window, ref);
        const turn = service.prompt(window, created.id, 'perm', []);
        await waitFor(() => log.prompts.length === 1, 'the prompt');
        const user = (await service.get(window, created.id)).items.find((item) => item.kind === 'user');
        assert.ok(user?.kind === 'user' && user.checkpoint);
        await assert.rejects(service.undoChanges(window, created.id, 'all'), /still working/);
        await assert.rejects(service.restoreCheckpoint(window, created.id, user.checkpoint), /still working/);
        // Reading is fine while it works.
        assert.deepEqual((await service.changes(window, created.id)).files, []);
        await service.cancel(window, created.id);
        await turn;
        await service.stopAll();
        await changes.dispose();
    });

    it('attaches a metric delta to its turn and refuses review actions without checkpoints', async () => {
        const { service, window, ref, messages } = await setup('delta');
        const created = await service.create(window, ref);
        await service.prompt(window, created.id, 'hello', []);
        const turn = (await service.get(window, created.id)).items.at(-1);
        assert.ok(turn?.kind === 'turn-end');
        const delta = { summary: '1 file (1 changed)', totals: [{ metric: 'codeLines', before: 10, after: 4 }], files: [], moreFiles: 0 };
        service.attachMetricDelta(created.id, turn.id, delta);
        service.attachMetricDelta(created.id, 'unknown-turn', delta);
        const after = await service.get(window, created.id);
        const ended = after.items.at(-1);
        assert.ok(ended?.kind === 'turn-end');
        assert.deepEqual(ended.metricDelta, delta);
        assert.equal(messages.filter((message) => message.kind === 'event' && message.event.type === 'metric-delta').length, 1);
        await assert.rejects(service.changes(window, created.id), /not available/);
        await service.stopAll();
    });

    it('runs agent terminals and shows their output in the tool card', { skip: process.platform === 'win32' }, async () => {
        const { service, window, ref } = await setup('terminal');
        const created = await service.create(window, ref);
        await service.prompt(window, created.id, 'term', []);
        const state = await service.get(window, created.id);
        assert.equal(lastText(state), 'EXIT:0 OUT:from terminal');
        const tool = state.items.find((item) => item.kind === 'tool' && item.id === 'tc2');
        assert.ok(tool?.kind === 'tool');
        const block = tool.content[0];
        assert.ok(block?.type === 'terminal');
        assert.equal(block.output.trim(), 'from terminal');
        assert.equal(block.exitCode, 0);
        await service.stopAll();
    });

    it('turns an auth error into a notice and marks the agent as needing a login', async () => {
        const { service, window, ref } = await setup('auth');
        const created = await service.create(window, ref);
        await service.prompt(window, created.id, 'auth', []);
        const state = await service.get(window, created.id);
        const notice = state.items.find((item) => item.kind === 'notice' && item.level === 'error');
        assert.ok(notice?.kind === 'notice' && /log in/i.test(notice.text));
        assert.equal(state.status, 'error');
        const agents = await service.listAgents(window);
        const fake = agents.find((view) => view.ref === ref);
        assert.equal(fake?.availability, 'needs-login');
        assert.deepEqual(fake?.authMethods?.map((method) => method.type), ['terminal']);
        await service.stopAll();
    });

    it('starts no agent in an untrusted folder and refuses the built-in agent', async () => {
        const { service, window, ref, log } = await setup('untrusted', { trusted: false });
        const created = await service.create(window, ref);
        await service.prompt(window, created.id, 'hello', []);
        const state = await service.get(window, created.id);
        assert.ok(state.items.some((item) => item.kind === 'notice' && /Restricted Mode/.test(item.text)));
        assert.equal(log.prompts.length, 0);
        await assert.rejects(service.create(window, 'builtin:p1'), /Agents view/);
        await assert.rejects(service.get(window, '../x'), /Invalid chat/);
        await service.stopAll();
    });
});

describe('AcpConnection over a real child process', () => {
    it('spawns an agent, speaks ndjson over its stdio and stops it on close', async () => {
        const updates: unknown[] = [];
        const handlers = {
            onUpdate: (_id: string, update: unknown) => updates.push(update),
            requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' as const } }),
            readTextFile: () => Promise.reject(new Error('no')),
            writeTextFile: () => Promise.reject(new Error('no')),
            createTerminal: () => Promise.reject(new Error('no')),
            terminalOutput: () => ({ output: '', truncated: false }),
            waitForTerminalExit: () => Promise.reject(new Error('no')),
            killTerminal: () => undefined,
            releaseTerminal: () => undefined,
        };
        const script = path.join(import.meta.dirname, 'fixtures', 'fakeAcpAgent.mjs');
        const connection = AcpConnection.spawn({ command: process.execPath, args: [script], env: { PATH: process.env['PATH'] ?? '' } }, import.meta.dirname, handlers);
        const init = await connection.initialize();
        assert.equal(init.protocolVersion, 1);
        const session = await connection.newSession(import.meta.dirname, []);
        const response = await connection.prompt(session.sessionId, [{ type: 'text', text: 'ping' }]);
        assert.equal(response.stopReason, 'end_turn');
        assert.deepEqual(updates, [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo:ping' } }]);
        const closed = new Promise<void>((resolve) => connection.onClose(() => resolve()));
        connection.close();
        await closed;
        assert.equal(connection.isClosed, true);
    });

    it('rejects pending requests with the reason when the agent cannot start', async () => {
        const connection = AcpConnection.spawn({ command: path.join(base, 'no-such-agent'), args: [], env: {} }, base, {} as never);
        await assert.rejects(connection.initialize(), /no-such-agent|ENOENT|exited/);
    });

    it('reports the exit code and the stderr tail when the agent dies, not just a closed stream', async () => {
        const crash = 'process.stdin.once("data", () => { process.stderr.write("Cannot find module foo\\n"); process.exit(3); });';
        const connection = AcpConnection.spawn({ command: process.execPath, args: ['-e', crash], env: { PATH: process.env['PATH'] ?? '' } }, base, {} as never);
        await assert.rejects(connection.initialize(), /exited with code 3.*Cannot find module foo/);
    });
});

