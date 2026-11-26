import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentChatEvent, ChatMessageView } from '../src/shared/agents.ts';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';
import { KeyVault, type SecretCipher } from '../src/main/agents/keyVault.ts';
import { ProviderRegistry } from '../src/main/agents/providerRegistry.ts';
import { AgentProfiles, parseProfile, STARTER_AGENTS } from '../src/main/agents/agentProfiles.ts';
import { ChatSessions, sessionToMarkdown, titleFrom } from '../src/main/agents/chatSessions.ts';
import { AgentChat, fitHistory, type ChatWindow } from '../src/main/agents/agentChat.ts';
import { ToolCatalog } from '../src/main/agents/tools/toolCatalog.ts';
import { WORKSPACE_TOOLS } from '../src/main/agents/tools/workspaceTools.ts';
import type { AgentTool, ToolWorkspace } from '../src/main/agents/tools/toolTypes.ts';
import { buildAttachmentContext } from '../src/main/agents/attachments.ts';
import { applyReplacements, proposeEditTool } from '../src/main/agents/tools/editTools.ts';
import { applyHunks, diffLines, matchLineEndings } from '../src/shared/lineDiff.ts';
import type { FetchLike } from '../src/main/agents/providers/types.ts';
import { parseInline, parseMarkdown } from '../src/renderer/agents/markdownModel.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-chat-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const cipher: SecretCipher = {
    isAvailable: () => true,
    backend: () => 'gnome_libsecret',
    encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x55)),
    decrypt: (data) => Buffer.from(data.map((byte) => byte ^ 0x55)).toString('utf8'),
};

function sse(chunks: readonly string[]): Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) { controller.enqueue(encoder.encode(chunk)); } controller.close(); } }));
}

/** An in-memory folder: `ignored.txt` exists but is git-ignored, like quick open would skip it. */
function fakeWorkspace(files: Readonly<Record<string, string>>): ToolWorkspace {
    return {
        listDirectory: (relative) => {
            const inside = Object.keys(files).filter((file) => relative === '' || file.startsWith(`${String(relative)}/`));
            return relative !== '' && inside.length === 0
                ? Promise.reject(new Error('ENOENT: no such file or directory'))
                : Promise.resolve(inside.map((file) => ({ name: file, path: file, kind: 'file' as const, ignored: false })));
        },
        readFile: (relative) => {
            const text = files[String(relative)];
            return text === undefined ? Promise.reject(new Error('ENOENT: no such file or directory')) : Promise.resolve({ kind: 'text' as const, path: String(relative), text, mtimeMs: 0 });
        },
        listFiles: () => Promise.resolve({ files: Object.keys(files).filter((file) => file !== 'ignored.txt'), truncated: false }),
        search: () => Promise.resolve({ files: 0, matches: 0, limitHit: false, cancelled: false }),
    };
}

function windowOf(events: AgentChatEvent[], workspace: ToolWorkspace | null = null, onEvent?: (event: AgentChatEvent) => void): ChatWindow {
    return { workspace, emit: (event) => { events.push(event); onEvent?.(event); } };
}

const quiet: ChatWindow = { workspace: null, emit: () => undefined };

/** A risky tool for the approval tests; records whether it ran. */
function riskyTool(log: string[]): AgentTool {
    return {
        name: 'touch_file',
        title: 'Touch a file',
        description: 'Test tool that pretends to change a file.',
        risk: 'write',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        preview: (args) => ({ summary: `touch ${String(args['path'])}`, detail: `Will touch ${String(args['path'])}` }),
        run: (args) => { log.push(String(args['path'])); return Promise.resolve('touched'); },
    };
}

function toolCallChunk(id: string, name: string, args: string): Response {
    return sse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] })}\n\n`,
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
    ]);
}

let counter = 0;
async function setup(fetchImpl: FetchLike, extraTools: readonly AgentTool[] = []) {
    counter += 1;
    const dir = path.join(base, `case-${counter}`);
    const providers = new ProviderRegistry(new JsonKeyValueStore(path.join(dir, 'providers.json')), new KeyVault(path.join(dir, 'keys.json'), cipher), fetchImpl);
    const profiles = new AgentProfiles(new JsonKeyValueStore(path.join(dir, 'agents.json')));
    const sessions = new ChatSessions(path.join(dir, 'sessions'));
    const tools = new ToolCatalog([...WORKSPACE_TOOLS, ...extraTools]);
    const chat = new AgentChat(providers, profiles, sessions, tools);
    const provider = await providers.save({ kind: 'openai', apiKey: 'sk-test-0123456789' });
    const [assistant] = await profiles.list();
    assert.ok(assistant);
    const agent = await profiles.save({ ...assistant, providerId: provider.id, model: 'gpt-test', tools: [...assistant.tools, ...extraTools.map((tool) => tool.name)] }, assistant.id);
    return { dir, providers, profiles, sessions, chat, agent, provider };
}

describe('AgentProfiles', () => {
    it('seeds the starters unbound, validates input, and unbinds a removed provider', async () => {
        const profiles = new AgentProfiles(new JsonKeyValueStore(path.join(base, 'profiles', 'agents.json')));
        const seeded = await profiles.list();
        assert.deepEqual(seeded.map((agent) => agent.name), STARTER_AGENTS.map((agent) => agent.name));
        assert.ok(seeded.every((agent) => agent.providerId === '' && agent.model === ''));
        const saved = await profiles.save({ name: ' Reviewer ', providerId: 'p1', model: 'm', instructions: 'x', temperature: 0.5, tools: [] });
        assert.equal(saved.name, 'Reviewer');
        await profiles.unbindProvider('p1');
        assert.equal((await profiles.get(saved.id))?.providerId, '');
        assert.throws(() => parseProfile({ name: '', providerId: '', model: '', instructions: '', tools: [] }), /needs a name/);
        assert.throws(() => parseProfile({ name: 'a', temperature: 3, tools: [] }), /between 0 and 2/);
        assert.throws(() => parseProfile({ name: 'a', tools: [1] }), /Invalid tools/);
        await profiles.remove(saved.id);
        assert.equal(await profiles.get(saved.id), undefined);
    });
});

describe('ChatSessions', () => {
    it('keeps chats per folder, refuses ids that could leave the folder, exports Markdown', async () => {
        const sessions = new ChatSessions(path.join(base, 'sessions'));
        const a = await sessions.create('/work/a', 'agent');
        await sessions.create('/work/b', 'agent');
        assert.deepEqual((await sessions.list('/work/a')).map((session) => session.id), [a.id]);
        assert.equal((await sessions.list(null)).length, 0);
        await assert.rejects(sessions.get('/work/a', '../../etc/passwd'), /no longer exists/);
        const renamed = await sessions.rename('/work/a', a.id, '  Hello  ');
        assert.equal(renamed.title, 'Hello');
        const markdown = sessionToMarkdown({ ...a, title: 'T', messages: [{ role: 'user', content: 'hi', at: '' }, { role: 'assistant', content: '', at: '', error: 'boom' }] }, 'Bot');
        assert.match(markdown, /# T[\s\S]*## You\n\nhi[\s\S]*## Bot\n\n_boom_/);
        await sessions.delete('/work/a', a.id);
        assert.equal((await sessions.list('/work/a')).length, 0);
    });

    it('titles a chat from its first line', () => {
        assert.equal(titleFrom('Why is main slow?\nmore'), 'Why is main slow?');
        assert.equal(titleFrom('a '.repeat(40)).endsWith('…'), true);
        assert.equal(titleFrom('   '), 'New chat');
    });
});

describe('fitHistory', () => {
    const message = (role: 'user' | 'assistant', size: number): ChatMessageView => ({ role, content: 'x'.repeat(size), at: '' });
    it('keeps the newest messages that fit, starting with a user turn', () => {
        const history = [message('user', 50), message('assistant', 50), message('user', 50), message('assistant', 50), message('user', 50)];
        assert.deepEqual(fitHistory(history, 10_000), { kept: history, trimmed: 0 });
        const fitted = fitHistory(history, 150);
        assert.equal(fitted.kept[0]?.role, 'user');
        assert.equal(fitted.kept.length + fitted.trimmed, history.length);
        assert.ok(fitted.trimmed > 0);
        assert.equal(fitHistory([message('user', 10_000)], 10).kept.length, 1, 'the last message is always sent');
    });
});

describe('AgentChat', () => {
    it('streams an answer, stores both turns and titles the chat', async () => {
        let body: Record<string, unknown> = {};
        const { chat, agent, sessions } = await setup((_url, init) => {
            body = JSON.parse(String(init.body)) as Record<string, unknown>;
            return Promise.resolve(sse([
                'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"there"},"finish_reason":"stop"}]}\n\n',
                'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
            ]));
        });
        const session = await chat.create('/w', agent.id);
        const events: AgentChatEvent[] = [];
        await chat.send('/w', session.id, 'Explain the build', [], windowOf(events));
        assert.deepEqual(events.map((event) => event.type), ['start', 'delta', 'delta', 'end']);
        const stored = await chat.get('/w', session.id);
        assert.equal(stored.title, 'Explain the build');
        assert.deepEqual(stored.messages.map((m) => [m.role, m.content]), [['user', 'Explain the build'], ['assistant', 'Hello there']]);
        assert.deepEqual(stored.messages[1]?.usage, { inputTokens: 9, outputTokens: 2 });
        assert.equal(body['model'], 'gpt-test');
        assert.deepEqual((body['messages'] as unknown[])[0], { role: 'system', content: agent.instructions });
        assert.deepEqual((body['tools'] as Array<{ function: { name: string } }>).map((tool) => tool.function.name), ['list_directory', 'read_file', 'find_files', 'search_text']);
        assert.equal((await sessions.list('/w'))[0]?.messageCount, 2);
    });

    it('records a provider error as an assistant turn instead of throwing', async () => {
        const { chat, agent } = await setup(() => Promise.resolve(new Response('{"error":{"message":"bad key"}}', { status: 401 })));
        const session = await chat.create(null, agent.id);
        await chat.send(null, session.id, 'hi', [], quiet);
        const answer = (await chat.get(null, session.id)).messages[1];
        assert.match(answer?.error ?? '', /API key was rejected \(401\): bad key/);
    });

    it('explains an agent with no provider without calling the network', async () => {
        let called = false;
        const { chat, profiles, provider } = await setup(() => { called = true; return Promise.reject(new Error('no')); });
        const unbound = await profiles.save({ name: 'Lonely', providerId: '', model: '', instructions: '', tools: [] });
        const session = await chat.create(null, unbound.id);
        await chat.send(null, session.id, 'hi', [], quiet);
        assert.match((await chat.get(null, session.id)).messages[1]?.error ?? '', /has no provider/);
        assert.equal(called, false);
        assert.ok(provider.id);
    });

    it('stops a streaming answer and keeps what arrived', async () => {
        const { chat, agent } = await setup((_url, init) => {
            const encoder = new TextEncoder();
            return Promise.resolve(new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
                    init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
                },
            })));
        });
        const session = await chat.create(null, agent.id);
        const sending = chat.send(null, session.id, 'long task', [], windowOf([], null, (event) => {
            if (event.type === 'delta') {
                chat.stop(session.id);
            }
        }));
        await assert.rejects(chat.send(null, session.id, 'again', [], quiet), /still answering/);
        await sending;
        const answer = (await chat.get(null, session.id)).messages[1];
        assert.equal(answer?.stopped, true);
        assert.equal(answer?.content, 'partial');
    });
});

describe('AgentChat tools (A7)', () => {
    it('runs a read tool without asking and sends the result back to the model', async () => {
        const bodies: Array<Record<string, unknown>> = [];
        const { chat, agent } = await setup((_url, init) => {
            bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
            return Promise.resolve(bodies.length === 1
                ? toolCallChunk('call_1', 'read_file', '{"path":"src/a.ts"}')
                : sse(['data: {"choices":[{"delta":{"content":"It exports x."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']));
        });
        const session = await chat.create('/w', agent.id);
        const events: AgentChatEvent[] = [];
        await chat.send('/w', session.id, 'What is in a.ts?', [], windowOf(events, fakeWorkspace({ 'src/a.ts': 'export const x = 1;' })));
        assert.equal(events.some((event) => event.type === 'approval'), false);
        const toolMessage = (bodies[1]?.['messages'] as Array<Record<string, unknown>>).find((message) => message['role'] === 'tool');
        assert.match(String(toolMessage?.['content']), /src\/a\.ts \(lines 1-1 of 1\)\n1  export const x = 1;/);
        const answer = (await chat.get('/w', session.id)).messages[1];
        assert.equal(answer?.content, 'It exports x.');
        assert.deepEqual(answer?.toolRuns?.map((run) => [run.name, run.status]), [['read_file', 'done']]);
    });

    it('asks before a risky tool; "always" remembers it on the agent, "deny" skips it', async () => {
        const log: string[] = [];
        let calls = 0;
        const { chat, agent, profiles } = await setup(() => {
            calls += 1;
            return Promise.resolve(calls % 2 === 1
                ? toolCallChunk(`call_${calls}`, 'touch_file', `{"path":"f${calls}"}`)
                : sse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n']));
        }, [riskyTool(log)]);
        const session = await chat.create(null, agent.id);

        const denied: AgentChatEvent[] = [];
        await chat.send(null, session.id, 'touch', [], windowOf(denied, null, (event) => {
            if (event.type === 'approval') {
                assert.equal(event.request.detail, 'Will touch f1');
                chat.approve(event.request.id, 'deny');
            }
        }));
        assert.deepEqual(log, []);
        assert.equal((await chat.get(null, session.id)).messages[1]?.toolRuns?.[0]?.status, 'denied');

        await chat.send(null, session.id, 'touch again', [], windowOf([], null, (event) => {
            if (event.type === 'approval') {
                chat.approve(event.request.id, 'always');
            }
        }));
        assert.deepEqual(log, ['f3']);
        assert.deepEqual((await profiles.get(agent.id))?.alwaysAllow, ['touch_file']);

        const third: AgentChatEvent[] = [];
        await chat.send(null, session.id, 'and again', [], windowOf(third));
        assert.equal(third.some((event) => event.type === 'approval'), false, 'an always-allowed tool runs without asking');
        assert.deepEqual(log, ['f3', 'f5']);
    });

    it('refuses a tool the agent was not given', async () => {
        let calls = 0;
        const { chat, agent } = await setup(() => {
            calls += 1;
            return Promise.resolve(calls === 1 ? toolCallChunk('c', 'run_command', '{}') : sse(['data: {"choices":[{"delta":{"content":"sorry"},"finish_reason":"stop"}]}\n\n']));
        });
        const session = await chat.create(null, agent.id);
        await chat.send(null, session.id, 'rm -rf', [], quiet);
        assert.equal((await chat.get(null, session.id)).messages[1]?.toolRuns?.[0]?.status, 'error');
    });
});

describe('line diff (A8)', () => {
    it('finds the hunks and applies any subset of them', () => {
        const original = 'a\nb\nc\nd\ne';
        const proposed = 'a\nB\nc\nd\ne\nf';
        const hunks = diffLines(original, proposed);
        assert.deepEqual(hunks, [
            { originalStart: 1, originalCount: 1, modifiedStart: 1, lines: ['B'] },
            { originalStart: 5, originalCount: 0, modifiedStart: 5, lines: ['f'] },
        ]);
        assert.equal(applyHunks(original, hunks, new Set([0, 1])), proposed);
        assert.equal(applyHunks(original, hunks, new Set()), original);
        assert.equal(applyHunks(original, hunks, new Set([1])), 'a\nb\nc\nd\ne\nf');
        assert.deepEqual(diffLines('same', 'same'), []);
        assert.equal(matchLineEndings('x\r\ny', 'p\nq'), 'p\r\nq');
    });
    it('replaces exactly once or explains why not', () => {
        assert.equal(applyReplacements('let a = 1;\nlet b = 2;', [{ find: 'b = 2', replace: 'b = 3' }]), 'let a = 1;\nlet b = 3;');
        assert.throws(() => applyReplacements('x x', [{ find: 'x', replace: 'y' }]), /more than once/);
        assert.throws(() => applyReplacements('x', [{ find: 'z', replace: 'y' }]), /not in the file/);
    });
});

describe('propose_edit (A8)', () => {
    const files = { 'src/a.ts': 'const a = 1;\r\nconst b = 2;\r\n' };
    const contextWith = (outcome: 'applied' | 'rejected', seen: unknown[]) => ({
        workspace: fakeWorkspace(files),
        signal: new AbortController().signal,
        reviewEdit: (request: unknown) => { seen.push(request); return Promise.resolve({ outcome, accepted: 1, total: 1 }); },
    });
    it('sends the proposed file (with the file\'s line endings) to review and reports the outcome', async () => {
        const seen: Array<Record<string, unknown>> = [];
        const text = await proposeEditTool.run({ path: 'src/a.ts', summary: 'bump b', edits: [{ find: 'const b = 2;', replace: 'const b = 3;' }] }, contextWith('applied', seen));
        assert.match(text, /Applied and saved: src\/a\.ts/);
        assert.equal(seen[0]?.['proposed'], 'const a = 1;\r\nconst b = 3;\r\n');
        assert.equal(seen[0]?.['isNew'], false);
        assert.match(await proposeEditTool.run({ path: 'src/a.ts', summary: 'x', content: 'other' }, contextWith('rejected', [])), /rejected/);
    });
    it('proposes a new file only inside an existing folder, and refuses ambiguous arguments', async () => {
        const seen: Array<Record<string, unknown>> = [];
        await proposeEditTool.run({ path: 'src/new.ts', summary: 'add', content: 'export {};' }, contextWith('applied', seen));
        assert.equal(seen[0]?.['isNew'], true);
        await assert.rejects(proposeEditTool.run({ path: 'nope/new.ts', summary: 'add', content: 'x' }, contextWith('applied', [])), /does not exist/);
        await assert.rejects(proposeEditTool.run({ path: 'src/a.ts', summary: 'x' }, contextWith('applied', [])), /either "edits" or "content"/);
        assert.match(await proposeEditTool.run({ path: 'src/a.ts', summary: 'x', content: files['src/a.ts'] }, contextWith('applied', [])), /No change/);
    });
    it('runs through AgentChat without an approval card and waits for the review', async () => {
        let calls = 0;
        const { chat, agent } = await setup(() => {
            calls += 1;
            return Promise.resolve(calls === 1
                ? toolCallChunk('e1', 'propose_edit', JSON.stringify({ path: 'src/a.ts', summary: 'bump', edits: [{ find: '2', replace: '3' }] }))
                : sse(['data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n']));
        }, [proposeEditTool]);
        const session = await chat.create(null, agent.id);
        const events: AgentChatEvent[] = [];
        await chat.send(null, session.id, 'bump b', [], windowOf(events, fakeWorkspace(files), (event) => {
            if (event.type === 'review') {
                chat.resolveReview(event.request.id, { outcome: 'applied', accepted: 1, total: 1 });
            }
        }));
        assert.equal(events.some((event) => event.type === 'approval'), false);
        assert.equal(events.filter((event) => event.type === 'review').length, 1);
        const run = (await chat.get(null, session.id)).messages[1]?.toolRuns?.[0];
        assert.deepEqual([run?.name, run?.status], ['propose_edit', 'done']);
        assert.match(run?.result ?? '', /Applied and saved/);
    });
});

describe('attachments (A6)', () => {
    const workspace = fakeWorkspace({ 'src/a.ts': 'const a = 1;', 'ignored.txt': 'secret' });
    it('wraps files and selections as labelled context', async () => {
        const context = await buildAttachmentContext(workspace, [
            { kind: 'file', path: 'src/a.ts' },
            { kind: 'selection', path: 'src/a.ts', startLine: 1, endLine: 1, text: 'a = 1' },
        ]);
        assert.deepEqual(context.labels, ['src/a.ts', 'src/a.ts:1-1']);
        assert.match(context.text, /<context source="src\/a\.ts">\n```ts\nconst a = 1;\n```\n<\/context>/);
    });
    it('refuses git-ignored files, missing folders and oversize context', async () => {
        await assert.rejects(buildAttachmentContext(workspace, [{ kind: 'file', path: 'ignored.txt' }]), /not a project file/);
        await assert.rejects(buildAttachmentContext(null, [{ kind: 'file', path: 'src/a.ts' }]), /Open a folder/);
        await assert.rejects(buildAttachmentContext(fakeWorkspace({ 'big.txt': 'x'.repeat(130_000) }), [{ kind: 'file', path: 'big.txt' }]), /does not fit/);
        assert.deepEqual(await buildAttachmentContext(null, []), { text: '', labels: [] });
    });
    it('stores attachment labels on the user turn and sends the context to the model', async () => {
        let body: Record<string, unknown> = {};
        const { chat, agent } = await setup((_url, init) => {
            body = JSON.parse(String(init.body)) as Record<string, unknown>;
            return Promise.resolve(sse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n']));
        });
        const session = await chat.create('/w', agent.id);
        await chat.send('/w', session.id, 'Review this', [{ kind: 'file', path: 'src/a.ts' }], windowOf([], workspace));
        const user = (await chat.get('/w', session.id)).messages[0];
        assert.deepEqual(user?.attachments, ['src/a.ts']);
        const sent = (body['messages'] as Array<Record<string, unknown>>).at(-1);
        assert.match(String(sent?.['content']), /^<context source="src\/a\.ts">[\s\S]*Review this$/);
    });
});

describe('parseMarkdown', () => {
    it('reads code fences (open while streaming), headings, lists, quotes and paragraphs', () => {
        const blocks = parseMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n```ts\nconst x = 1;\n```\n\n```py\nprint(1)');
        assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'paragraph', 'list', 'list', 'quote', 'code', 'code']);
        assert.deepEqual(blocks[5], { kind: 'code', language: 'ts', text: 'const x = 1;', open: false });
        assert.deepEqual(blocks[6], { kind: 'code', language: 'py', text: 'print(1)', open: true });
    });
    it('parses inline spans and leaves odd markup as text', () => {
        assert.deepEqual(parseInline('a `b` **c** *d* [e](https://x.org) snake_case_name <img>'), [
            { kind: 'text', text: 'a ' },
            { kind: 'code', text: 'b' },
            { kind: 'text', text: ' ' },
            { kind: 'strong', children: [{ kind: 'text', text: 'c' }] },
            { kind: 'text', text: ' ' },
            { kind: 'em', children: [{ kind: 'text', text: 'd' }] },
            { kind: 'text', text: ' ' },
            { kind: 'link', text: 'e', href: 'https://x.org' },
            { kind: 'text', text: ' snake_case_name <img>' },
        ]);
        assert.deepEqual(parseInline('[x](javascript:alert(1))'), [{ kind: 'text', text: '[x](javascript:alert(1))' }]);
    });
});
