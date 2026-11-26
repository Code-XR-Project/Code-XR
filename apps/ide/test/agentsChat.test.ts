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
import { AgentChat, fitHistory } from '../src/main/agents/agentChat.ts';
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

let counter = 0;
async function setup(fetchImpl: FetchLike) {
    counter += 1;
    const dir = path.join(base, `case-${counter}`);
    const providers = new ProviderRegistry(new JsonKeyValueStore(path.join(dir, 'providers.json')), new KeyVault(path.join(dir, 'keys.json'), cipher), fetchImpl);
    const profiles = new AgentProfiles(new JsonKeyValueStore(path.join(dir, 'agents.json')));
    const sessions = new ChatSessions(path.join(dir, 'sessions'));
    const chat = new AgentChat(providers, profiles, sessions);
    const provider = await providers.save({ kind: 'openai', apiKey: 'sk-test-0123456789' });
    const [assistant] = await profiles.list();
    assert.ok(assistant);
    const agent = await profiles.save({ ...assistant, providerId: provider.id, model: 'gpt-test' }, assistant.id);
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
        await chat.send('/w', session.id, 'Explain the build', (event) => events.push(event));
        assert.deepEqual(events.map((event) => event.type), ['start', 'delta', 'delta', 'end']);
        const stored = await chat.get('/w', session.id);
        assert.equal(stored.title, 'Explain the build');
        assert.deepEqual(stored.messages.map((m) => [m.role, m.content]), [['user', 'Explain the build'], ['assistant', 'Hello there']]);
        assert.deepEqual(stored.messages[1]?.usage, { inputTokens: 9, outputTokens: 2 });
        assert.equal(body['model'], 'gpt-test');
        assert.deepEqual((body['messages'] as unknown[])[0], { role: 'system', content: agent.instructions });
        assert.equal((await sessions.list('/w'))[0]?.messageCount, 2);
    });

    it('records a provider error as an assistant turn instead of throwing', async () => {
        const { chat, agent } = await setup(() => Promise.resolve(new Response('{"error":{"message":"bad key"}}', { status: 401 })));
        const session = await chat.create(null, agent.id);
        await chat.send(null, session.id, 'hi', () => undefined);
        const answer = (await chat.get(null, session.id)).messages[1];
        assert.match(answer?.error ?? '', /API key was rejected \(401\): bad key/);
    });

    it('explains an agent with no provider without calling the network', async () => {
        let called = false;
        const { chat, profiles, provider } = await setup(() => { called = true; return Promise.reject(new Error('no')); });
        const unbound = await profiles.save({ name: 'Lonely', providerId: '', model: '', instructions: '', tools: [] });
        const session = await chat.create(null, unbound.id);
        await chat.send(null, session.id, 'hi', () => undefined);
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
        const sending = chat.send(null, session.id, 'long task', (event) => {
            if (event.type === 'delta') {
                chat.stop(session.id);
            }
        });
        await assert.rejects(chat.send(null, session.id, 'again', () => undefined), /still answering/);
        await sending;
        const answer = (await chat.get(null, session.id)).messages[1];
        assert.equal(answer?.stopped, true);
        assert.equal(answer?.content, 'partial');
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
