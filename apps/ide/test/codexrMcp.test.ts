import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ANALYSIS_QUERIES, NO_ANALYSIS, readEvolution, readMetrics } from '../src/main/agents/tools/analysisQueries.ts';
import { ANALYSIS_TOOLS } from '../src/main/agents/tools/analysisTools.ts';
import { createCodexrMcpServer, parseArgs, type CodexrMcpOptions } from '../src/codexrMcp/server.ts';
import { codexrMcpServerSpec } from '../src/main/agentSessions/codexrMcpSpec.ts';

/** AF10: Code-XR's analysis queries as an MCP server for external agents. */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-mcp-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const records = [
    { relativePath: 'src/a.ts', language: 'TypeScript', codeLines: 100, maxComplexity: 12, functionCount: 5, cyclomaticComplexityNumber: 3 },
    { relativePath: 'src\\b.ts', language: 'TypeScript', codeLines: 40, maxComplexity: 3, functionCount: 2, cyclomaticComplexityNumber: 1 },
];
const graph = {
    nodes: [
        { id: 'n1', relativePath: 'src/a.ts', metrics: { fanIn: 0, fanOut: 1, degree: 1, cycleSize: 0 } },
        { id: 'n2', relativePath: 'src/b.ts', metrics: { fanIn: 1, fanOut: 0, degree: 1, cycleSize: 0 } },
    ],
    edges: [{ source: 'n1', target: 'n2', kind: 'import' }],
};

/** A fixture analysis folder, as an XR analysis leaves it. */
function analysisFolder(withGraph: boolean): string {
    const dir = fs.mkdtempSync(path.join(base, 'analysis-'));
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(records));
    if (withGraph) {
        fs.writeFileSync(path.join(dir, 'dependency-graph.json'), JSON.stringify(graph));
    }
    const revision = path.join(dir, 'evolution', 'revision-3');
    fs.mkdirSync(revision, { recursive: true });
    fs.writeFileSync(path.join(revision, 'manifest.json'), JSON.stringify({ frames: [
        { date: '2026-01-01', url: '/evolution/revision-3/data1.json' },
        { date: '2026-02-01', url: '/evolution/revision-3/data2.json' },
        { date: '2026-03-01', url: '../../../outside.json' },
    ] }));
    fs.writeFileSync(path.join(revision, 'data1.json'), JSON.stringify(records.slice(0, 1)));
    fs.writeFileSync(path.join(revision, 'data2.json'), JSON.stringify(records));
    return dir;
}

async function connect(options: CodexrMcpOptions): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createCodexrMcpServer(options).connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    return client;
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
    const content = result.content as { type: string; text?: string }[];
    return content.map((item) => item.text ?? '').join('');
}

describe('analysis queries (shared by the agent and the MCP server)', () => {
    it('reads the metrics and the evolution frames of an analysis folder', async () => {
        const dir = analysisFolder(false);
        assert.deepEqual((await readMetrics(dir)).map((record) => record.relativePath), ['src/a.ts', 'src/b.ts']);
        const frames = await readEvolution(dir);
        // The third frame points outside the revision folder: it is skipped, never read.
        assert.deepEqual(frames?.map(({ frame }) => frame.date), ['2026-01-01', '2026-02-01']);
        await assert.rejects(readMetrics(path.join(base, 'missing')), { message: NO_ANALYSIS });
    });
    it('answers every query from the folder, and explains what is missing', async () => {
        const dir = analysisFolder(false);
        const query = (name: string) => ANALYSIS_QUERIES.find((candidate) => candidate.name === name)!;
        assert.match(await query('get_metrics').run({ path: 'src' }, dir), /src: 2 analysed files[\s\S]*total codeLines: 140/);
        assert.match(await query('get_hotspots').run({ limit: '1' }, dir), /Top 1 files by maxComplexity:\n1\. src\/a\.ts/);
        await assert.rejects(query('get_dependencies').run({}, dir), /Dependency graph mode/);
        assert.match(await query('get_evolution').run({ path: 'src/a.ts' }, dir), /2026-01-01: codeLines=100\n- 2026-02-01: codeLines=100/);
    });
    it('are exactly the built-in agent\'s analysis tools', () => {
        assert.deepEqual(ANALYSIS_TOOLS.map((tool) => [tool.name, tool.title, tool.description, tool.parameters, tool.risk]),
            ANALYSIS_QUERIES.map((query) => [query.name, query.title, query.description, query.parameters, 'read']));
        assert.equal(ANALYSIS_TOOLS[1]!.preview({ metric: 'codeLines' }).summary, 'top files by codeLines');
    });
});

describe('Code-XR MCP server (AF10)', () => {
    it('lists the four read-only tools with the agent\'s names and argument schemas', async () => {
        const client = await connect({ root: base, analysisDir: analysisFolder(true) });
        assert.equal(client.getServerVersion()?.name, 'code-xr');
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name), ['get_metrics', 'get_hotspots', 'get_dependencies', 'get_evolution']);
        for (const tool of tools) {
            const query = ANALYSIS_QUERIES.find((candidate) => candidate.name === tool.name)!;
            assert.equal(tool.description, `[Code-XR] ${query.description}`);
            assert.equal(tool.annotations?.readOnlyHint, true);
            assert.equal(tool.annotations?.openWorldHint, false);
            assert.deepEqual(tool.inputSchema.required ?? [], []);
            for (const [key, property] of Object.entries(query.parameters.properties)) {
                assert.equal((tool.inputSchema.properties?.[key] as { type?: string }).type, property.type, `${tool.name}.${key}`);
                assert.equal((tool.inputSchema.properties?.[key] as { description?: string }).description, property.description);
            }
            assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), Object.keys(query.parameters.properties).sort());
        }
        await client.close();
    });
    it('answers tool calls from the analysis folder and reports failures as tool errors', async () => {
        const client = await connect({ root: base, analysisDir: analysisFolder(true) });
        const hot = await client.callTool({ name: 'get_hotspots', arguments: { limit: 1 } });
        assert.equal(hot.isError, undefined);
        assert.match(text(hot), /1\. src\/a\.ts: maxComplexity=12/);
        assert.match(text(await client.callTool({ name: 'get_dependencies', arguments: { path: 'src/b.ts' } })), /Used by \(1\):\n- src\/a\.ts \(import\)/);
        const missing = await client.callTool({ name: 'get_metrics', arguments: { path: 'nope' } });
        assert.equal(missing.isError, true);
        assert.match(text(missing), /no file at or under "nope"/);
        const invalid = await client.callTool({ name: 'get_hotspots', arguments: { limit: 'many' } });
        assert.equal(invalid.isError, true);
        await client.close();
    });
    it('answers with the built-in agent\'s "no analysis" message when none has run', async () => {
        for (const analysisDir of [null, path.join(base, 'not-yet')]) {
            const client = await connect({ root: base, analysisDir });
            const result = await client.callTool({ name: 'get_metrics', arguments: {} });
            assert.equal(result.isError, true);
            assert.equal(text(result), NO_ANALYSIS);
            await client.close();
        }
    });
    it('parses its command line', () => {
        const root = path.resolve(base, 'project');
        assert.deepEqual(parseArgs(['--root', root, '--analysis', '']), { root, analysisDir: null });
        assert.deepEqual(parseArgs(['--root', root, '--analysis', path.join(root, 'out')]), { root, analysisDir: path.join(root, 'out') });
        assert.throws(() => parseArgs(['--analysis', root]), /--root/);
        assert.throws(() => parseArgs(['--root', 'relative']), /--root/);
        assert.throws(() => parseArgs(['--root', root, '--analysis', 'relative']), /--analysis/);
    });
    it('serves MCP over stdio from its entry point', async () => {
        const entry = fileURLToPath(new URL('../src/codexrMcp/index.ts', import.meta.url));
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: ['--experimental-strip-types', '--no-warnings', entry, '--root', base, '--analysis', analysisFolder(false)],
            stderr: 'pipe',
        });
        const client = new Client({ name: 'test', version: '0' });
        await client.connect(transport);
        assert.equal((await client.listTools()).tools.length, 4);
        assert.match(text(await client.callTool({ name: 'get_metrics', arguments: { path: 'src/b.ts' } })), /^src\/b\.ts \(TypeScript\): codeLines=40/);
        await client.close();
    });
});

describe('codexrMcpServerSpec', () => {
    it('runs the bundled server with the IDE\'s own binary in Node mode', () => {
        const spec = codexrMcpServerSpec({ execPath: '/opt/Code-XR IDE/code-xr-ide', appPath: '/opt/Code-XR IDE/resources/app.asar', root: '/home/me/project', analysisDir: '/home/me/.codexr/out', isPackaged: true });
        assert.deepEqual(spec, {
            name: 'code-xr',
            command: '/opt/Code-XR IDE/code-xr-ide',
            args: [path.join('/opt/Code-XR IDE/resources/app.asar', 'out', 'codexrMcp', 'index.cjs'), '--root', '/home/me/project', '--analysis', '/home/me/.codexr/out'],
            env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
        });
        const dev = codexrMcpServerSpec({ execPath: '/repo/node_modules/electron/dist/electron', appPath: '/repo/apps/ide', root: '/p', analysisDir: null, isPackaged: false });
        assert.deepEqual(dev.args, [path.join('/repo/apps/ide', 'out', 'codexrMcp', 'index.cjs'), '--root', '/p', '--analysis', '']);
    });
});
