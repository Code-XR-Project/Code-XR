import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectLocalServers, listLocalModels, parseOllamaTags, parseOpenAiModels, type FetchFn } from '@codexr/local-models/discovery.ts';
import { isPrivateNetworkHost, normalizeLocalBaseUrl } from '@codexr/local-models/servers.ts';
import { applyEdit, buildSystemPrompt, globToRegExp, numberLines } from '@codexr/local-models/tools.ts';
import { clampToolResult, isToolsUnsupportedError, runAgentTurn, type ChatEvent, type ChatMessage, type ChatRequest, type ModelClient } from '@codexr/local-models/agentLoop.ts';
import type { AgentSessionState, TranscriptItem } from '../src/shared/agentSession.ts';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';
import { AcpConnection } from '../src/main/agentSessions/acpConnection.ts';
import { AgentCatalog, parseLocalModel } from '../src/main/agentSessions/agentCatalog.ts';
import { AgentSessionService, type WindowPort } from '../src/main/agentSessions/agentSessionService.ts';
import { SessionStore } from '../src/main/agentSessions/sessionStore.ts';
import { createLocalAgent, mcpToolName, promptText, resolveInside } from '../src/localAgent/localAgent.ts';
import { addressAfterServerChange, detectedSummary, initialValues, modelLabel, suggestName, toInput } from '../src/renderer/agentFirst/localModelModel.ts';
import { setupActions } from '../src/renderer/agentFirst/agentSetupModel.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-local-models-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

/** A fetch that answers from a table of URLs; anything else is refused like a closed port. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>, seen: string[] = []): FetchFn {
    return async (url, init) => {
        seen.push(`${url} ${init.headers['authorization'] ?? ''}`.trim());
        const route = routes[url];
        if (!route) {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        }
        return { ok: (route.status ?? 200) < 400, status: route.status ?? 200, json: async () => route.body };
    };
}

describe('local model servers (#311)', () => {
    it('normalises endpoints and keeps plain http on this machine or a private network', () => {
        assert.equal(normalizeLocalBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1');
        assert.equal(normalizeLocalBaseUrl('localhost:1234/v1/'), 'http://localhost:1234/v1');
        assert.equal(normalizeLocalBaseUrl('http://192.168.1.20:8080/v1/chat/completions'), 'http://192.168.1.20:8080/v1');
        assert.equal(normalizeLocalBaseUrl('https://models.example.org/api/v1'), 'https://models.example.org/api/v1');
        assert.equal(normalizeLocalBaseUrl('http://[::1]:8000/v1?x=1#y'), 'http://[::1]:8000/v1');
        assert.throws(() => normalizeLocalBaseUrl('http://models.example.org/v1'), /local network/);
        assert.throws(() => normalizeLocalBaseUrl('http://user:pw@127.0.0.1:1234'), /API key/);
        assert.throws(() => normalizeLocalBaseUrl('ftp://127.0.0.1'), /http/);
        assert.throws(() => normalizeLocalBaseUrl('  '), /address/);
        assert.equal(isPrivateNetworkHost('10.0.0.5'), true);
        assert.equal(isPrivateNetworkHost('100.101.1.1'), true);
        assert.equal(isPrivateNetworkHost('172.32.0.1'), false);
        assert.equal(isPrivateNetworkHost('8.8.8.8'), false);
    });

    it('parses OpenAI and Ollama model lists, dropping junk', () => {
        assert.deepEqual(parseOpenAiModels({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, { id: 3 }, null] }), [{ id: 'b' }, { id: 'a' }]);
        assert.deepEqual(parseOpenAiModels({ nope: true }), []);
        assert.deepEqual(parseOllamaTags({ models: [{ name: 'qwen2.5-coder:7b', model: 'qwen2.5-coder:7b', size: 4_700_000_000, details: { parameter_size: '7.6B' } }, { foo: 1 }] }), [{ id: 'qwen2.5-coder:7b', size: 4_700_000_000, parameters: '7.6B' }]);
    });

    it('lists models (Ollama with sizes), sends a key only when given, and explains failures', async () => {
        const seen: string[] = [];
        const fetchFn = fakeFetch({
            'http://127.0.0.1:11434/api/tags': { body: { models: [{ name: 'llama3.1:8b', size: 5e9, details: { parameter_size: '8.0B' } }] } },
            'http://127.0.0.1:11434/v1/models': { body: { data: [{ id: 'llama3.1:8b' }, { id: 'extra' }] } },
            'http://127.0.0.1:1234/v1/models': { status: 401, body: {} },
        }, seen);
        const ollama = await listLocalModels('http://127.0.0.1:11434/v1', { fetch: fetchFn, serverId: 'ollama' });
        assert.deepEqual(ollama, { ok: true, models: [{ id: 'extra' }, { id: 'llama3.1:8b', size: 5e9, parameters: '8.0B' }] });
        assert.ok(seen.every((line) => !line.includes('Bearer')));
        const refused = await listLocalModels('http://127.0.0.1:1234/v1', { fetch: fetchFn, serverId: 'lmstudio', apiKey: 'k' });
        assert.equal(refused.ok, false);
        assert.match(refused.ok ? '' : refused.error, /API key/);
        assert.ok(seen.some((line) => line.endsWith('Bearer k')));
        const down = await listLocalModels('http://127.0.0.1:8080/v1', { fetch: fetchFn, serverId: 'llamacpp' });
        assert.match(down.ok ? '' : down.error, /llama\.cpp server is not answering on 127\.0\.0\.1:8080 \(connection refused\)\. Run `llama-server/);
    });

    it('detects running servers on their default ports only, each port once', async () => {
        const seen: string[] = [];
        const found = await detectLocalServers(fakeFetch({
            'http://127.0.0.1:1234/v1/models': { body: { data: [{ id: 'qwen' }] } },
            'http://127.0.0.1:1337/v1/models': { body: { data: [] } },
        }, seen));
        assert.deepEqual(found.map((server) => [server.serverId, server.models.length]), [['lmstudio', 1], ['jan', 0]]);
        assert.ok(seen.every((line) => line.startsWith('http://127.0.0.1:')));
        // llama.cpp and LocalAI share 8080: probed once.
        assert.equal(seen.filter((line) => line.startsWith('http://127.0.0.1:8080/v1/models')).length, 1);
    });
});

describe('local model tools (#312)', () => {
    it('edits exactly once, keeps CRLF, and explains a missing or repeated old_string', () => {
        assert.equal(applyEdit('a\nb\nc\n', 'b\n', 'B\n', false), 'a\nB\nc\n');
        assert.equal(applyEdit('a\r\nb\r\n', 'a\nb', 'x\ny', false), 'x\r\ny\r\n');
        assert.equal(applyEdit('x x', 'x', 'y', true), 'y y');
        assert.throws(() => applyEdit('x x', 'x', 'y', false), /2 times/);
        assert.throws(() => applyEdit('abc', 'zz', 'y', false), /not found/);
        assert.equal(applyEdit('$1 a', 'a', '$&$1', false), '$1 $&$1');
    });

    it('matches globs, numbers lines and clamps long results', () => {
        assert.ok(globToRegExp('*.ts').test('src/a/b.ts'));
        assert.ok(globToRegExp('src/**/*.{ts,js}').test('src/x.js'));
        assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
        assert.equal(numberLines('a\nb\nc\n', 2, 1), '2\tb\n[1 more lines: read again with offset 3]');
        const long = 'x'.repeat(100);
        assert.ok(clampToolResult(long, 40).includes('characters left out'));
        assert.equal(isToolsUnsupportedError(new Error('registry.ollama.ai/library/gemma:2b does not support tools')), true);
        assert.match(buildSystemPrompt({ agentName: 'A', model: 'm', cwd: '/p', platform: 'Linux', toolsEnabled: true, extraTools: ['code-xr__get_metrics'] }), /code-xr__ tools/);
    });

    it('runs the loop: tool call, result fed back, final answer; falls back to plain chat without tool support', async () => {
        const requests: ChatRequest[] = [];
        const script: ChatEvent[][] = [
            [{ type: 'tool-call', call: { id: 'c1', name: 'echo', arguments: '{"x":1}' } }, { type: 'done', stopReason: 'tool-calls' }],
            [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end' }],
        ];
        const client: ModelClient = {
            async *stream(request) {
                requests.push(structuredClone(request) as ChatRequest);
                yield* script.shift() ?? [];
            },
        };
        const history: ChatMessage[] = [{ role: 'user', content: 'hi' }];
        let text = '';
        const stop = await runAgentTurn({
            client, model: 'm', system: 's', history, toolsEnabled: { value: true }, signal: new AbortController().signal,
            tools: { definitions: () => [{ name: 'echo', description: 'e', parameters: {} }], run: async (_call, args) => ({ content: `got ${String(args['x'])}` }) },
            events: { onText: (chunk) => {
                text += chunk;
            } },
        });
        assert.equal(stop, 'end_turn');
        assert.equal(text, 'done');
        assert.deepEqual(history.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant']);
        assert.equal((history[2] as { content: string }).content, 'got 1');
        assert.equal(requests.length, 2);

        let calls = 0;
        const noTools: ModelClient = {
            async *stream(request) {
                calls++;
                if (request.tools) {
                    throw new Error('model does not support tools');
                }
                yield { type: 'text', text: 'plain' };
                yield { type: 'done', stopReason: 'end' };
            },
        };
        const flag = { value: true };
        let warned = false;
        const plain = await runAgentTurn({
            client: noTools, model: 'm', system: 's', history: [{ role: 'user', content: 'hi' }], toolsEnabled: flag, signal: new AbortController().signal,
            tools: { definitions: () => [{ name: 'echo', description: 'e', parameters: {} }], run: async () => ({ content: '' }) },
            events: { onText: () => undefined, onToolsUnsupported: () => {
                warned = true;
            } },
        });
        assert.equal(plain, 'end_turn');
        assert.equal(flag.value, false);
        assert.equal(warned, true);
        assert.equal(calls, 2);
    });

    it('keeps paths inside the project and turns prompts into one message', () => {
        const root = path.join(base, 'inside');
        assert.equal(resolveInside(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
        assert.throws(() => resolveInside(root, '../secret'), /outside/);
        assert.equal(mcpToolName('code-xr', 'get metrics'), 'code-xr__get_metrics');
        assert.equal(promptText([{ type: 'text', text: 'fix it' }, { type: 'resource', resource: { uri: 'file:///p/a.ts', text: 'x' } }]), 'fix it\n\n<file uri="file:///p/a.ts">\nx\n</file>');
    });
});

describe('local models in the catalogue and the form (#313)', () => {
    it('validates, stores the key apart and starts the IDE\'s agent with the key in the environment only', async () => {
        assert.throws(() => parseLocalModel({ name: 'x', server: 'nope', baseUrl: 'http://127.0.0.1:1', model: 'm' }), /server/);
        assert.throws(() => parseLocalModel({ name: 'x', server: 'custom', baseUrl: 'http://example.org', model: 'm' }), /local network/);
        assert.throws(() => parseLocalModel({ name: '', server: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'm' }), /name/);
        const keys = new Map<string, string>();
        const script = path.join(base, 'localAgent.cjs');
        fs.writeFileSync(script, '');
        const catalog = new AgentCatalog({
            packagesDir: path.join(base, 'packages'),
            store: new JsonKeyValueStore(path.join(base, 'catalog.json')),
            env: { PATH: '/bin', SECRET_TOKEN: 'no' },
            platform: 'linux',
            execPath: '/opt/code-xr-ide',
            builtinProfiles: () => Promise.resolve([]),
            localAgentScript: script,
            localKeys: { get: (id) => keys.get(id), set: async (id, key) => keys.set(id, key), delete: async (id) => void keys.delete(id) },
        });
        const saved = await catalog.saveLocal({ name: 'Qwen', server: 'ollama', baseUrl: '127.0.0.1:11434', model: 'qwen2.5-coder:7b', apiKey: 'sk-local' });
        assert.match(saved.id, /^local-[a-f0-9]{8}$/);
        assert.deepEqual(saved.local, { server: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' });
        assert.equal(keys.get(saved.id), 'sk-local');
        assert.ok(!JSON.stringify(fs.readFileSync(path.join(base, 'catalog.json'), 'utf8')).includes('sk-local'));
        const resolution = await catalog.resolve(catalog.definition(`acp:${saved.id}`)!);
        assert.ok(resolution.found);
        assert.equal(resolution.launch.command, '/opt/code-xr-ide');
        assert.deepEqual(resolution.launch.args, [script]);
        assert.equal(resolution.launch.env['CODEXR_LOCAL_API_KEY'], 'sk-local');
        assert.equal(resolution.launch.env['CODEXR_LOCAL_MODEL'], 'qwen2.5-coder:7b');
        assert.equal(resolution.launch.env['ELECTRON_RUN_AS_NODE'], '1');
        assert.equal(resolution.launch.env['SECRET_TOKEN'], undefined);
        const view = (await catalog.list()).find((agent) => agent.ref === `acp:${saved.id}`);
        assert.equal(view?.local?.hasKey, true);
        assert.match(view?.description ?? '', /qwen2\.5-coder:7b on Ollama \(127\.0\.0\.1:11434\)/);
        assert.deepEqual(setupActions(view!), ['check', 'edit-local', 'remove-local']);
        // Editing without a key keeps it; '' forgets it.
        await catalog.saveLocal({ name: 'Qwen 2', server: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:14b' }, saved.id);
        assert.equal(keys.get(saved.id), 'sk-local');
        await catalog.saveLocal({ name: 'Qwen 2', server: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:14b', apiKey: '' }, saved.id);
        assert.equal(keys.has(saved.id), false);
        assert.equal(catalog.localModels().length, 1);
        await catalog.removeLocal(saved.id);
        assert.equal(catalog.localModels().length, 0);
        await assert.rejects(catalog.removeLocal('claude'), /local model/);
    });

    it('form helpers: default address follows the server unless typed, names, labels and input', () => {
        assert.equal(addressAfterServerChange('http://127.0.0.1:11434/v1', 'ollama', 'lmstudio'), 'http://127.0.0.1:1234/v1');
        assert.equal(addressAfterServerChange('http://10.0.0.2:9999/v1', 'ollama', 'lmstudio'), 'http://10.0.0.2:9999/v1');
        assert.equal(suggestName('qwen', 'ollama'), 'qwen (Ollama)');
        assert.equal(modelLabel({ id: 'm', size: 4_700_000_000, parameters: '7B' }), 'm (7B, 4.7 GB)');
        assert.equal(detectedSummary({ server: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: [] }), 'Ollama on 127.0.0.1:11434: no model loaded');
        const blank = initialValues(null);
        assert.deepEqual(toInput({ ...blank, model: 'qwen' }, null), { ok: true, input: { name: 'qwen (Ollama)', server: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen' } });
        assert.equal(toInput(blank, null).ok, false);
    });
});

// ---- A whole chat: the IDE's ACP host + the local agent + a scripted model ----

describe('a chat with a local model through the IDE\'s ACP host (#312)', () => {
    it('reads and edits a file with permission, streams text and offers the server\'s models', async () => {
        const root = path.join(base, 'chat', 'project');
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'a.txt'), 'hello\nworld\n');
        const requests: ChatRequest[] = [];
        const script: ChatEvent[][] = [
            [{ type: 'tool-call', call: { id: 'r1', name: 'read_file', arguments: '{"path":"a.txt"}' } }, { type: 'done', stopReason: 'tool-calls' }],
            [{ type: 'tool-call', call: { id: 'e1', name: 'edit_file', arguments: '{"path":"a.txt","old_string":"world","new_string":"Code-XR"}' } }, { type: 'done', stopReason: 'tool-calls' }],
            [{ type: 'text', text: 'Changed ' }, { type: 'text', text: 'a.txt.' }, { type: 'done', stopReason: 'end' }],
        ];
        const client: ModelClient = {
            async *stream(request) {
                requests.push(structuredClone(request) as ChatRequest);
                yield* script.shift() ?? [{ type: 'done', stopReason: 'end' }];
            },
        };
        const catalog = new AgentCatalog({ packagesDir: path.join(base, 'chat', 'packages'), store: new JsonKeyValueStore(path.join(base, 'chat', 'agents.json')), env: { PATH: '' }, platform: process.platform, execPath: process.execPath, builtinProfiles: () => Promise.resolve([]), localAgentScript: path.join(base, 'localAgent.cjs') });
        const local = await catalog.saveLocal({ name: 'Local Qwen', server: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' });
        const window: WindowPort = { id: 1, send: () => undefined, isDestroyed: () => false };
        const written: string[] = [];
        const service = new AgentSessionService({
            catalog,
            store: new SessionStore(path.join(base, 'chat', 'sessions'), { debounceMs: 5 }),
            decisions: new JsonKeyValueStore(path.join(base, 'chat', 'decisions.json')),
            rootOf: () => root,
            isTrusted: () => true,
            readText: (file) => fs.promises.readFile(file, 'utf8'),
            writeText: async (file, content) => {
                written.push(file);
                await fs.promises.writeFile(file, content);
            },
            openTerminal: () => Promise.reject(new Error('no terminal in tests')),
            connect: (_launch, _cwd, handlers) => AcpConnection.inProcess(createLocalAgent({ name: 'Local Qwen', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' }, { client, listModels: async () => ['qwen2.5-coder:7b', 'llama3.1:8b'] }), handlers),
            beforePrompt: () => Promise.resolve({ checkpointId: 'cp-1' }),
            spawnAllowed: true,
            probeDir: path.join(base, 'chat', 'probe'),
            homeDir: os.homedir(),
            terminalEnv: { PATH: process.env['PATH'] ?? '' },
            cancelGraceMs: 2000,
        });
        const created = await service.create(window, `acp:${local.id}`);
        const turn = service.prompt(window, created.id, 'Replace world', []);
        let waiting: Extract<TranscriptItem, { kind: 'permission' }> | undefined;
        for (let i = 0; i < 300 && !waiting; i++) {
            const state = await service.get(window, created.id);
            waiting = state.items.find((item): item is Extract<TranscriptItem, { kind: 'permission' }> => item.kind === 'permission' && item.outcome === undefined);
            if (!waiting) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        assert.ok(waiting, 'the edit asks first');
        assert.match(waiting.title, /Edit a\.txt/);
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hello\nworld\n');
        await service.respondPermission(window, created.id, waiting.id, 'allow');
        await turn;
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hello\nCode-XR\n');
        assert.deepEqual(written, [path.join(root, 'a.txt')]);
        const state: AgentSessionState = await service.get(window, created.id);
        const assistant = [...state.items].reverse().find((item) => item.kind === 'assistant');
        assert.equal(assistant && 'text' in assistant ? assistant.text : '', 'Changed a.txt.');
        // The read went through ACP and its numbered text reached the model.
        const toolMessage = requests[1]?.messages.find((message) => message.role === 'tool');
        assert.match(toolMessage && 'content' in toolMessage ? toolMessage.content : '', /1\thello\n2\tworld/);
        assert.ok(requests[0]?.tools?.some((tool) => tool.name === 'edit_file'));
        // The model picker shows the server's models.
        const model = state.configOptions.find((option) => option.id === 'model');
        assert.equal(model?.current, 'qwen2.5-coder:7b');
        assert.deepEqual(model?.values.map((value) => value.id), ['qwen2.5-coder:7b', 'llama3.1:8b']);
        await service.setConfigOption(window, created.id, 'model', 'llama3.1:8b');
        assert.equal((await service.get(window, created.id)).configOptions.find((option) => option.id === 'model')?.current, 'llama3.1:8b');
        await service.stopAll();
    });
});
