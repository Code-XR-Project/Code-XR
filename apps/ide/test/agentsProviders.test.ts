import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';
import { KeyVault, type SecretCipher } from '../src/main/agents/keyVault.ts';
import { normalizeBaseUrl } from '../src/main/agents/providerCatalog.ts';
import { ProviderRegistry } from '../src/main/agents/providerRegistry.ts';
import { createAdapter } from '../src/main/agents/providers/createAdapter.ts';
import { readSse } from '../src/main/agents/providers/http.ts';
import { toAnthropicMessages } from '../src/main/agents/providers/anthropic.ts';
import { toGeminiContents } from '../src/main/agents/providers/gemini.ts';
import { toOpenAiMessages } from '../src/main/agents/providers/openai.ts';
import { ProviderError, type ChatEvent, type ChatMessage, type FetchLike } from '../src/main/agents/providers/types.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-agents-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

/** A reversible fake of safeStorage: enough to prove nothing is written in clear. */
function fakeCipher(backend = 'gnome_libsecret', available = true): SecretCipher {
    return {
        isAvailable: () => available,
        backend: () => backend,
        encrypt: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
        decrypt: (cipher) => {
            const text = cipher.toString('utf8');
            if (!text.startsWith('enc:')) {
                throw new Error('bad');
            }
            return [...text.slice(4)].reverse().join('');
        },
    };
}

function sseBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
}

interface Recorded { url: string; init: RequestInit }

function fakeFetch(responses: Array<() => Response>, recorded: Recorded[] = []): FetchLike {
    return (url, init) => {
        recorded.push({ url, init });
        const next = responses.shift();
        if (!next) {
            throw new Error(`unexpected request to ${url}`);
        }
        return Promise.resolve(next());
    };
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
    const out: ChatEvent[] = [];
    for await (const event of events) {
        out.push(event);
    }
    return out;
}

const SECRET = 'sk-test-0123456789abcd';

describe('KeyVault', () => {
    it('encrypts keys on disk and reads them back in a new instance', async () => {
        const file = path.join(base, 'vault-a', 'keys.json');
        const vault = new KeyVault(file, fakeCipher());
        assert.equal(await vault.set('p1', `  ${SECRET} `), 'os-encrypted');
        const onDisk = fs.readFileSync(file, 'utf8');
        assert.ok(!onDisk.includes(SECRET), 'plaintext key must never reach the disk');
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        }
        const again = new KeyVault(file, fakeCipher());
        assert.equal(again.get('p1'), SECRET);
        assert.equal(again.hint('p1'), 'abcd');
        assert.equal(again.storageOf('p1'), 'os-encrypted');
        await again.delete('p1');
        assert.equal(new KeyVault(file, fakeCipher()).get('p1'), undefined);
    });

    it('keeps keys in memory only when the store is missing or is basic_text', async () => {
        for (const cipher of [fakeCipher('basic_text'), fakeCipher('unknown'), fakeCipher('dpapi', false)]) {
            const file = path.join(base, `vault-${cipher.backend()}-${String(cipher.isAvailable())}.json`);
            const vault = new KeyVault(file, cipher);
            assert.equal(vault.status().available, false);
            assert.equal(await vault.set('p', SECRET), 'session-only');
            assert.equal(vault.get('p'), SECRET);
            assert.equal(fs.existsSync(file), false);
            assert.equal(new KeyVault(file, cipher).get('p'), undefined);
        }
    });

    it('treats an undecryptable entry as no key, and an empty key as a delete', async () => {
        const file = path.join(base, 'vault-b.json');
        fs.writeFileSync(file, JSON.stringify({ version: 1, keys: { p: Buffer.from('garbage').toString('base64') } }));
        const vault = new KeyVault(file, fakeCipher());
        assert.equal(vault.get('p'), undefined);
        assert.equal(await vault.set('p', '   '), 'none');
        assert.equal(vault.storageOf('p'), 'none');
    });
});

describe('normalizeBaseUrl', () => {
    it('accepts https and loopback http, strips trailing slashes', () => {
        assert.equal(normalizeBaseUrl('https://example.com/v1/'), 'https://example.com/v1');
        assert.equal(normalizeBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
        assert.equal(normalizeBaseUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
    });
    it('refuses remote http, credentials in the URL and other schemes', () => {
        assert.throws(() => normalizeBaseUrl('http://example.com/v1'), /https/);
        assert.throws(() => normalizeBaseUrl('https://user:pw@example.com'), /own field/);
        assert.throws(() => normalizeBaseUrl('file:///etc/passwd'), /https/);
        assert.throws(() => normalizeBaseUrl('not a url'), /valid URL/);
    });
});

describe('ProviderRegistry', () => {
    it('saves providers without secrets in the store and exposes only a hint', async () => {
        const store = new JsonKeyValueStore(path.join(base, 'reg', 'state.json'));
        const registry = new ProviderRegistry(store, new KeyVault(path.join(base, 'reg', 'keys.json'), fakeCipher()));
        const saved = await registry.save({ kind: 'anthropic', apiKey: SECRET });
        assert.equal(saved.label, 'Anthropic');
        assert.equal(saved.hasKey, true);
        assert.equal(saved.keyHint, 'abcd');
        assert.equal(saved.baseUrl, 'https://api.anthropic.com/v1');
        assert.ok(!fs.readFileSync(path.join(base, 'reg', 'state.json'), 'utf8').includes(SECRET));
        assert.ok(!JSON.stringify(registry.list()).includes(SECRET));

        const local = await registry.save({ kind: 'openai-compatible', label: 'Ollama', baseUrl: 'http://localhost:11434/v1/' });
        assert.equal(local.hasKey, false);
        assert.equal(local.baseUrl, 'http://localhost:11434/v1');
        // A fixed endpoint cannot be redirected elsewhere by the renderer.
        const edited = await registry.save({ kind: 'anthropic', baseUrl: 'https://evil.example' }, saved.id);
        assert.equal(edited.baseUrl, 'https://api.anthropic.com/v1');
        assert.equal(edited.hasKey, true, 'omitting apiKey keeps the stored key');
        await assert.rejects(registry.save({ kind: 'openai' }, saved.id), /change kind/);
        await assert.rejects(registry.save({ kind: 'nope' }), /Unknown provider kind/);

        await registry.remove(saved.id);
        assert.deepEqual(registry.list().map((provider) => provider.label), ['Ollama']);
    });

    it('reports a failed connection test as a message, not a throw', async () => {
        const store = new JsonKeyValueStore(path.join(base, 'reg2', 'state.json'));
        const fetchImpl = fakeFetch([() => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 })]);
        const registry = new ProviderRegistry(store, new KeyVault(path.join(base, 'reg2', 'keys.json'), fakeCipher()), fetchImpl);
        const saved = await registry.save({ kind: 'anthropic', apiKey: SECRET });
        const result = await registry.test(saved.id);
        assert.equal(result.ok, false);
        assert.match(result.ok ? '' : result.error, /API key was rejected \(401\): invalid x-api-key/);
    });
});

describe('readSse', () => {
    it('handles split chunks, CRLF, comments and multi-line data', async () => {
        const messages = [];
        for await (const message of readSse(sseBody([': hi\r\nevent: a\r\nda', 'ta: 1\r\ndata: 2\r\n\r\ndata: x\n\n', 'data: tail']))) {
            messages.push(message);
        }
        assert.deepEqual(messages, [{ event: 'a', data: '1\n2' }, { event: 'message', data: 'x' }, { event: 'message', data: 'tail' }]);
    });
});

describe('provider adapters', () => {
    const conversation: ChatMessage[] = [
        { role: 'user', content: 'Where is main?' },
        { role: 'assistant', content: 'Let me look.', toolCalls: [{ id: 't1', name: 'search', arguments: '{"q":"main"}' }] },
        { role: 'tool', toolCallId: 't1', toolName: 'search', content: 'src/main.ts' },
    ];

    it('Anthropic: streams text and a tool call, sends the key in a header', async () => {
        const recorded: Recorded[] = [];
        const body = sseBody([
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
            'event: ping\ndata: {"type":"ping"}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"read"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}\n\n',
        ]);
        const adapter = createAdapter({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: SECRET }, fakeFetch([() => new Response(body)], recorded), 0);
        const events = await collect(adapter.stream({ model: 'claude-x', system: 'be brief', messages: conversation, tools: [{ name: 'read', description: 'r', parameters: { type: 'object' } }] }));
        assert.deepEqual(events, [
            { type: 'text', text: 'Hi' },
            { type: 'tool-call', call: { id: 'tu1', name: 'read', arguments: '{"path":"a.ts"}' } },
            { type: 'usage', inputTokens: 12, outputTokens: 30 },
            { type: 'done', stopReason: 'tool-calls' },
        ]);
        const request = recorded[0];
        assert.ok(request);
        assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
        assert.equal((request.init.headers as Record<string, string>)['x-api-key'], SECRET);
        const sent = JSON.parse(String(request.init.body)) as Record<string, unknown>;
        assert.equal(sent['system'], 'be brief');
        assert.deepEqual(sent['tools'], [{ name: 'read', description: 'r', input_schema: { type: 'object' } }]);
    });

    it('OpenAI-compatible: assembles fragmented tool calls and usage; no key header without a key', async () => {
        const recorded: Recorded[] = [];
        const body = sseBody([
            'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"rea","arguments":"{\\"p"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"d","arguments":"\\":1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}\n\n',
            'data: [DONE]\n\n',
        ]);
        const adapter = createAdapter({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKey: undefined }, fakeFetch([() => new Response(body)], recorded), 0);
        const events = await collect(adapter.stream({ model: 'llama', messages: [{ role: 'user', content: 'hi' }] }));
        assert.deepEqual(events, [
            { type: 'text', text: 'Hel' },
            { type: 'text', text: 'lo' },
            { type: 'tool-call', call: { id: 'c1', name: 'read', arguments: '{"p":1}' } },
            { type: 'usage', inputTokens: 5, outputTokens: 7 },
            { type: 'done', stopReason: 'tool-calls' },
        ]);
        assert.equal((recorded[0]?.init.headers as Record<string, string>)['authorization'], undefined);
    });

    it('Gemini: maps parts, function calls and usage; key in a header, not the URL', async () => {
        const recorded: Recorded[] = [];
        const body = sseBody([
            'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"On it"}]}}]}\n\n',
            'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read","args":{"path":"a"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}}\n\n',
        ]);
        const adapter = createAdapter({ kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: SECRET }, fakeFetch([() => new Response(body)], recorded), 0);
        const events = await collect(adapter.stream({ model: 'models/gemini-x', messages: [{ role: 'user', content: 'hi' }] }));
        assert.deepEqual(events, [
            { type: 'text', text: 'On it' },
            { type: 'tool-call', call: { id: 'call_1', name: 'read', arguments: '{"path":"a"}' } },
            { type: 'usage', inputTokens: 3, outputTokens: 4 },
            { type: 'done', stopReason: 'tool-calls' },
        ]);
        assert.equal(recorded[0]?.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
        assert.ok(!recorded[0]?.url.includes(SECRET));
    });

    it('retries 429/5xx, then surfaces a typed error', async () => {
        let calls = 0;
        const flaky: FetchLike = () => {
            calls += 1;
            return Promise.resolve(calls < 3
                ? new Response('busy', { status: calls === 1 ? 429 : 503 })
                : new Response(JSON.stringify({ data: [{ id: 'gpt-x' }] })));
        };
        const models = await createAdapter({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: SECRET }, flaky, 0).listModels();
        assert.deepEqual(models, [{ id: 'gpt-x', label: 'gpt-x' }]);
        assert.equal(calls, 3);

        const alwaysDown: FetchLike = () => Promise.resolve(new Response('{"error":{"message":"down"}}', { status: 500 }));
        await assert.rejects(createAdapter({ kind: 'openai', baseUrl: 'https://x/v1', apiKey: SECRET }, alwaysDown, 0).listModels(),
            (error: unknown) => error instanceof ProviderError && error.kind === 'server' && /down/.test(error.message));
        assert.throws(() => createAdapter({ kind: 'anthropic', baseUrl: 'https://x', apiKey: undefined }), /needs an API key/);
    });

    it('stops when the signal aborts', async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchImpl: FetchLike = (_url, init) => Promise.reject(Object.assign(new Error('aborted'), { aborted: init.signal?.aborted }));
        await assert.rejects(collect(createAdapter({ kind: 'openai', baseUrl: 'https://x/v1', apiKey: SECRET }, fetchImpl, 0).stream({ model: 'm', messages: [] }, controller.signal)),
            (error: unknown) => error instanceof ProviderError && error.kind === 'aborted');
    });

    it('maps the shared conversation to each wire format', () => {
        assert.deepEqual(toAnthropicMessages(conversation), [
            { role: 'user', content: [{ type: 'text', text: 'Where is main?' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't1', name: 'search', input: { q: 'main' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'src/main.ts' }] },
        ]);
        assert.deepEqual(toOpenAiMessages('sys', conversation), [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'Where is main?' },
            { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"main"}' } }] },
            { role: 'tool', tool_call_id: 't1', content: 'src/main.ts' },
        ]);
        assert.deepEqual(toGeminiContents(conversation), [
            { role: 'user', parts: [{ text: 'Where is main?' }] },
            { role: 'model', parts: [{ text: 'Let me look.' }, { functionCall: { name: 'search', args: { q: 'main' } } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'search', response: { result: 'src/main.ts' } } }] },
        ]);
    });
});
