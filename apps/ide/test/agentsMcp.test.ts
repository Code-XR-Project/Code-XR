import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';
import { KeyVault, type SecretCipher } from '../src/main/agents/keyVault.ts';
import { contentText, McpClient } from '../src/main/agents/mcp/mcpClient.ts';
import { httpTransport, processInvocation, quoteForCmd, readEvents, stdioTransport } from '../src/main/agents/mcp/mcpTransports.ts';
import { agentToolName, commandLine, McpRegistry } from '../src/main/agents/mcp/mcpRegistry.ts';
import { ToolCatalog } from '../src/main/agents/tools/toolCatalog.ts';
import type { ToolContext } from '../src/main/agents/tools/toolTypes.ts';
import { joinArgs, splitArgs } from '../src/shared/argLine.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-mcp-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const cipher: SecretCipher = {
    isAvailable: () => true,
    backend: () => 'gnome_libsecret',
    encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x55)),
    decrypt: (data) => Buffer.from(data.map((byte) => byte ^ 0x55)).toString('utf8'),
};

/** A stdio MCP server in a dozen lines: two pages of tools, an echo, a failure and a tool that never answers. */
const SERVER = `
const readline = require('node:readline');
process.stdout.write('a log line that is not JSON\\n');
process.stderr.write('fake server started\\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0' } } });
    else if (message.method === 'tools/list' && !message.params.cursor) send({ id: message.id, result: { tools: [{ name: 'echo', description: 'Echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }], nextCursor: 'p2' } });
    else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [{ name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } }, { name: 'hang', description: 'Never answers' }, { name: 'ask', description: 'Asks the client to sample' }] } });
    else if (message.method === 'tools/call' && message.params.name === 'echo') send({ id: message.id, result: { content: [{ type: 'text', text: 'echo: ' + message.params.arguments.text }, { type: 'image', data: '', mimeType: 'image/png' }] } });
    else if (message.method === 'tools/call' && message.params.name === 'fail') send({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'it broke' }] } });
    else if (message.method === 'tools/call' && message.params.name === 'ask') { send({ id: 'srv-1', method: 'sampling/createMessage', params: {} }); globalThis.pendingAsk = message.id; }
    else if (message.id === 'srv-1') send({ id: globalThis.pendingAsk, result: { content: [{ type: 'text', text: 'client said: ' + (message.error ? message.error.message : 'ok') }] } });
    else if (message.method === 'notifications/cancelled') process.stderr.write('cancelled ' + message.params.requestId + '\\n');
});
`;
const serverFile = path.join(base, 'fake-mcp-server.cjs');
fs.writeFileSync(serverFile, SERVER);

const context = (signal = new AbortController().signal): ToolContext => ({
    workspace: null,
    signal,
    reviewEdit: () => Promise.reject(new Error('no reviews here')),
});

describe('MCP transports (A12)', () => {
    it('starts .exe and POSIX commands directly and .cmd scripts through cmd.exe, escaped', () => {
        assert.deepEqual(processInvocation('npx', ['-y', 'pkg'], 'linux'), { file: 'npx', args: ['-y', 'pkg'], verbatim: false });
        assert.deepEqual(processInvocation('C:\\node\\node.exe', ['a b'], 'win32'), { file: 'C:\\node\\node.exe', args: ['a b'], verbatim: false });
        const windows = processInvocation('npx', ['-y', '@scope/pkg', 'C:\\My Folder\\'], 'win32');
        assert.equal(windows.verbatim, true);
        assert.deepEqual(windows.args.slice(0, 3), ['/d', '/s', '/c']);
        assert.equal(windows.args[3], '"npx ^"-y^" ^"@scope/pkg^" ^"C:\\My^ Folder\\\\^""');
        assert.equal(quoteForCmd('a&b'), '^"a^&b^"');
        assert.equal(quoteForCmd('say "hi"'), '^"say^ \\^"hi\\^"^"');
    });

    it('speaks JSON-RPC to a real stdio server: handshake, paged tools/list, calls, errors, refused requests', async () => {
        const transport = stdioTransport(process.execPath, [serverFile], { cwd: base, env: { PATH: process.env['PATH'] ?? '' } });
        const client = new McpClient(transport);
        await client.connect();
        assert.equal(client.serverInfo, 'fake 1.0');
        const tools = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name), ['echo', 'fail', 'hang', 'ask']);
        assert.deepEqual(tools[2]?.inputSchema, { type: 'object', properties: {} });
        assert.equal(await client.callTool('echo', { text: 'hi' }, new AbortController().signal), 'echo: hi\n[image content left out]');
        await assert.rejects(client.callTool('fail', {}, new AbortController().signal), /it broke/);
        // The server asks for sampling: refused, and the call still completes.
        assert.match(await client.callTool('ask', {}, new AbortController().signal), /client said: sampling\/createMessage is not supported/);
        const stop = new AbortController();
        const hanging = client.callTool('hang', {}, stop.signal);
        stop.abort();
        await assert.rejects(hanging, /Stopped/);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.match(transport.stderrTail(), /fake server started[\s\S]*cancelled \d+/);
        await client.close();
        assert.equal(client.closed, true);
        await assert.rejects(client.callTool('echo', { text: 'x' }, new AbortController().signal), /Closed/);
    });

    it('reports a process that exits before answering as one that could not start', async () => {
        const client = new McpClient(stdioTransport(process.execPath, ['-e', 'process.stderr.write("boom\\r\\n"); process.exit(3)'], { cwd: base, env: {} }));
        await assert.rejects(client.connect(), /^Error: Could not start .* \(exited with code 3\): boom$/);
    });

    it('reports a command that cannot start', async () => {
        const client = new McpClient(stdioTransport(path.join(base, 'no-such-server'), [], { cwd: base, env: {} }));
        await assert.rejects(client.connect(), /Could not start/);
    });

    it('speaks Streamable HTTP: JSON and SSE answers, the session id and the bearer token', async () => {
        const seen: { method: string; headers: Record<string, string>; body: string }[] = [];
        const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
            const headers = init.headers as Record<string, string>;
            seen.push({ method: String(init.method), headers, body: String(init.body ?? '') });
            if (init.method === 'DELETE') {
                return new Response(null, { status: 204 });
            }
            const message = JSON.parse(String(init.body)) as { id?: number; method: string };
            if (message.method === 'initialize') {
                return Response.json({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'remote' } } }, { headers: { 'Mcp-Session-Id': 'session-7' } });
            }
            if (message.id === undefined) {
                return new Response(null, { status: 202 });
            }
            const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search', description: 'Searches' }] } })}\n\n`;
            return new Response(event, { headers: { 'Content-Type': 'text/event-stream' } });
        };
        const client = new McpClient(httpTransport('https://mcp.example/mcp', () => 'secret-token', fetch));
        await client.connect();
        assert.deepEqual((await client.listTools()).map((tool) => tool.name), ['search']);
        await client.close();
        assert.deepEqual(seen.map((request) => request.method), ['POST', 'POST', 'POST', 'DELETE']);
        assert.equal(seen[0]?.headers['Authorization'], 'Bearer secret-token');
        assert.equal(seen[0]?.headers['Accept'], 'application/json, text/event-stream');
        assert.equal(seen[0]?.headers['Mcp-Session-Id'], undefined);
        assert.equal(seen[1]?.headers['Mcp-Session-Id'], 'session-7');
        assert.equal(seen[3]?.headers['Mcp-Session-Id'], 'session-7');
    });

    it('turns HTTP failures into readable errors', async () => {
        const client = new McpClient(httpTransport('https://mcp.example/mcp', () => undefined, () => Promise.resolve(new Response('no', { status: 401 }))));
        await assert.rejects(client.connect(), /check its token/);
    });

    it('reads multi-line SSE events, CRLF included', async () => {
        const got: unknown[] = [];
        await readEvents(new Response(': comment\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":{}}\r\n\r\ndata: {"jsonrpc":"2.0","id":2,"result":{}}'), (message) => got.push(message.id));
        assert.deepEqual(got, [1, 2]);
    });

    it('flattens tool results to text', () => {
        assert.equal(contentText({ content: [{ type: 'resource', resource: { uri: 'file:///a', text: 'A' } }, { type: 'resource_link', uri: 'file:///b' }] }), 'A\n[resource file:///b]');
        assert.equal(contentText({ content: [], structuredContent: { n: 1 } }), '{\n  "n": 1\n}');
    });
});

describe('MCP registry (A12)', () => {
    const make = (name: string, confirm: (line: string) => boolean) => {
        const asked: string[] = [];
        const registry = new McpRegistry({
            store: new JsonKeyValueStore(path.join(base, `${name}.json`)),
            vault: new KeyVault(path.join(base, `${name}-keys.json`), cipher),
            cwd: base,
            env: { PATH: process.env['PATH'] ?? '' },
            confirmCommand: ({ commandLine: line }) => {
                asked.push(line);
                return Promise.resolve(confirm(line));
            },
        });
        return { registry, asked };
    };

    it('runs a local command only after the person confirmed that exact line', async () => {
        const { registry, asked } = make('refused', () => false);
        await assert.rejects(registry.save({ name: 'Fake', transport: 'stdio', command: process.execPath, args: [serverFile], enabled: true }), /not approved/);
        assert.equal(asked.length, 1);
        assert.equal(asked[0], commandLine({ command: process.execPath, args: [serverFile] }));
        assert.deepEqual(registry.list(), []);
    });

    it('lists a server\'s tools as agent tools that ask first, runs them, and keeps them across edits', async () => {
        const { registry, asked } = make('servers', () => true);
        const saved = await registry.save({ name: 'Fake Server', transport: 'stdio', command: process.execPath, args: [serverFile], enabled: true });
        assert.equal(saved.status, 'ready');
        assert.deepEqual(saved.tools.map((tool) => tool.name), ['mcp__fake-server__echo', 'mcp__fake-server__fail', 'mcp__fake-server__hang', 'mcp__fake-server__ask']);
        assert.ok(saved.tools.every((tool) => tool.risk === 'network'));

        const catalog = new ToolCatalog([]);
        catalog.addSource(() => registry.tools());
        const echo = catalog.get('mcp__fake-server__echo');
        assert.ok(echo);
        assert.match(echo.preview({ text: 'hi' }).detail ?? '', /MCP server "Fake Server"[\s\S]*tool: echo[\s\S]*"text": "hi"/);
        assert.equal(await echo.run({ text: 'hi' }, context()), 'echo: hi\n[image content left out]');
        assert.deepEqual(catalog.forAgent(['mcp__fake-server__fail', 'read_file']).map((tool) => tool.name), ['mcp__fake-server__fail']);

        // Renaming keeps the command, so no new question, and keeps the tool list.
        const renamed = await registry.save({ name: 'Fake Server', transport: 'stdio', command: process.execPath, args: [serverFile], enabled: false }, saved.id);
        assert.equal(asked.length, 1);
        assert.equal(renamed.tools.length, 4);
        assert.equal(renamed.status, 'stopped');
        assert.deepEqual(registry.tools(), [], 'a server that is off offers no tools');
        await assert.rejects(echo.run({ text: 'x' }, context()), /turned off/);

        // A changed command asks again.
        await registry.save({ name: 'Fake Server', transport: 'stdio', command: process.execPath, args: [serverFile, '--flag'], enabled: true }, saved.id);
        assert.equal(asked.length, 2);
        await registry.remove(saved.id);
        assert.deepEqual(registry.list(), []);
        await registry.closeAll();
    });

    it('keeps an HTTP token in the vault, never in the view, and checks the URL', async () => {
        const { registry, asked } = make('http', () => true);
        await assert.rejects(registry.save({ name: 'Remote', transport: 'http', url: 'http://example.com/mcp', enabled: false }), /must be https/);
        await assert.rejects(registry.save({ name: 'Remote', transport: 'http', url: 'https://user:pw@example.com/mcp', enabled: false }), /not in the URL/);
        const saved = await registry.save({ name: 'Remote', transport: 'http', url: 'https://example.com/mcp', token: 'tok-123456789', enabled: false });
        assert.equal(asked.length, 0, 'a URL needs no command confirmation');
        assert.equal(saved.hasToken, true);
        assert.ok(!JSON.stringify(saved).includes('tok-123456789'));
        assert.ok(!fs.readFileSync(path.join(base, 'http.json'), 'utf8').includes('tok-123456789'));
        const kept = await registry.save({ name: 'Remote', transport: 'http', url: 'http://localhost:3000/mcp', enabled: false }, saved.id);
        assert.equal(kept.hasToken, true, 'an absent token keeps the stored one');
        const cleared = await registry.save({ name: 'Remote', transport: 'http', url: 'http://127.0.0.1:3000/mcp', token: '', enabled: false }, saved.id);
        assert.equal(cleared.hasToken, false);
    });

    it('shows a server that fails to connect without throwing', async () => {
        const { registry } = make('broken', () => true);
        const saved = await registry.save({ name: 'Broken', transport: 'stdio', command: path.join(base, 'missing-binary'), args: [], enabled: true });
        assert.equal(saved.status, 'error');
        assert.match(saved.error ?? '', /Could not start/);
    });

    it('names tools within the providers\' rule', () => {
        assert.equal(agentToolName('github', 'create.issue'), 'mcp__github__create_issue');
        assert.equal(agentToolName('s', 'x'.repeat(100)).length, 64);
        assert.deepEqual(splitArgs('-y "@scope/pkg" \'/a b/c\' --x=""'), ['-y', '@scope/pkg', '/a b/c', '--x=']);
        const args = ['-y', 'a b', 'say "hi"', ''];
        assert.deepEqual(splitArgs(joinArgs(args)), args);
    });
});
