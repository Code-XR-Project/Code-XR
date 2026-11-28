'use strict';

/**
 * Agent Flow core (docs/agent-flow/): the trace sources (Claude Code
 * transcripts, Codex rollouts, ACP chats), the shell classifier, the city
 * layout, the dataset builder and the service that follows a session and
 * writes the dataset the XR runtime draws.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const out = (...parts) => require(path.join(projectRoot, 'out', 'core', 'agent-flow', ...parts));

const { classifyShellCommand, parseApplyPatch, splitShellWords } = out('shellCommandClassifier.js');
const { parseClaudeCodeTranscript, encodeClaudeProjectDir, claudeToolKind } = out('claudeCodeTranscript.js');
const { parseCodexRollout } = out('codexRollout.js');
const { AcpSessionEventMapper } = out('acpSessionEvents.js');
const { layoutCity } = out('agentFlowLayout.js');
const { buildAgentFlowDataset, relativeToRoot } = out('agentFlowBuilder.js');
const { AgentFlowService, readAnalysisMetrics, readDependencyEdges, openAgentFlowInScenes, registerAgentFlowController } = out('agentFlowService.js');
const { PushAgentTraceSource, registerLiveAgentTraceSource, listAgentTraceSources, discoverClaudeCodeSessions, discoverCodexSessions, isWithinRoot } = out('agentTraceSources.js');
const { sampleEvents, sampleBaseMetrics, EXT_ROOT, T0 } = require('../manual/agent-flow/sampleSession.cjs');

const ROOT = '/work/demo';
const session = (extra = {}) => ({ id: 's', source: 'fixture', agent: 'Test', label: 'Test', startedAt: 0, updatedAt: 0, live: false, ...extra });

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- shell classification ---------------------------------------------------

test('shell commands are read as the step they really are', () => {
    assert.deepEqual(classifyShellCommand('cat src/a.ts'), { kind: 'read', paths: ['src/a.ts'] });
    assert.deepEqual(classifyShellCommand("sed -n '1,80p' src/b.ts"), { kind: 'read', paths: ['src/b.ts'] });
    assert.equal(classifyShellCommand("sed -i 's/a/b/' src/b.ts").kind, 'execute', 'an in-place sed edits, it is not a read');
    assert.deepEqual(classifyShellCommand('rg -n "fanIn" src'), { kind: 'search', paths: [] });
    assert.deepEqual(classifyShellCommand('cd apps/x && cat README.md | head -20'), { kind: 'read', paths: ['README.md'] });
    assert.equal(classifyShellCommand('npm test').kind, 'execute');
    assert.equal(classifyShellCommand('git grep foo').kind, 'search');
    assert.deepEqual(splitShellWords(`echo "a b" 'c'`), ['echo', 'a b', 'c']);
});

test('apply_patch headers name the edited, added and deleted files', () => {
    const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '@@', '-old', '+new', '+more', '*** Add File: src/b.ts', '+x', '*** Delete File: src/c.ts', '*** End Patch'].join('\n');
    assert.deepEqual(parseApplyPatch(patch), { updated: ['src/a.ts'], added: ['src/b.ts'], deleted: ['src/c.ts'], plus: 3, minus: 1 });
});

// ---- Claude Code ------------------------------------------------------------

function claudeLine(obj) {
    return JSON.stringify({ sessionId: 'abc', cwd: ROOT, timestamp: '2026-11-28T10:00:00.000Z', ...obj });
}

test('a Claude Code transcript becomes turns and steps, tool results completing their tool calls', () => {
    const text = [
        claudeLine({ type: 'user', message: { role: 'user', content: 'Fix the parser' } }),
        claudeLine({ type: 'assistant', timestamp: '2026-11-28T10:00:02.000Z', message: { role: 'assistant', content: [
            { type: 'text', text: 'Looking' },
            { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'parse', path: `${ROOT}/src` } },
        ] } }),
        claudeLine({ type: 'user', timestamp: '2026-11-28T10:00:03.000Z', toolUseResult: { filenames: [`${ROOT}/src/parser.ts`, `${ROOT}/src/lexer.ts`] }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
        claudeLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: `${ROOT}/src/parser.ts`, offset: 10 } }] } }),
        claudeLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '...' }] } }),
        claudeLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: `${ROOT}/src/parser.ts`, old_string: 'a\nb', new_string: 'a\nb\nc' } }] } }),
        claudeLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'done' }] } }),
        claudeLine({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'npm test' } }] } }),
        claudeLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', is_error: true, content: 'fail' }] } }),
        claudeLine({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } }),
        '{not json',
        claudeLine({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }),
        claudeLine({ type: 'user', message: { role: 'user', content: '<local-command-stdout>x</local-command-stdout>' } }),
    ].join('\n');
    const { events, sessionId, cwd } = parseClaudeCodeTranscript(text);
    assert.equal(sessionId, 'abc');
    assert.equal(cwd, ROOT);
    const types = events.map((e) => e.type === 'step' ? `${e.kind}:${e.status}` : e.type);
    assert.deepEqual(types, ['turn-start', 'search:running', 'search:done', 'read:running', 'read:done', 'write:running', 'write:done', 'execute:running', 'execute:failed', 'turn-end']);
    assert.equal(events[0].prompt, 'Fix the parser');
    assert.deepEqual(events[2].locations.map((l) => l.path), [`${ROOT}/src/parser.ts`, `${ROOT}/src/lexer.ts`], 'grep hits come from toolUseResult');
    assert.deepEqual(events[3].locations, [{ path: `${ROOT}/src/parser.ts`, line: 10 }]);
    assert.equal(events[5].added, 3);
    assert.equal(events[5].removed, 2);
    assert.equal(events[7].command, 'npm test');
});

test('Claude Code tool names map onto the visual verbs, and project folders are encoded like Claude Code does', () => {
    assert.equal(claudeToolKind('MultiEdit'), 'write');
    assert.equal(claudeToolKind('Glob'), 'search');
    assert.equal(claudeToolKind('WebFetch'), 'fetch');
    assert.equal(claudeToolKind('mcp__code-xr__get_metrics'), 'fetch');
    assert.equal(claudeToolKind('Task'), 'think');
    assert.equal(encodeClaudeProjectDir('/home/a/Code-XR'), '-home-a-Code-XR');
    assert.equal(encodeClaudeProjectDir('C:\\Users\\A\\x.y'), 'C--Users-A-x-y');
});

// ---- Codex ------------------------------------------------------------------

test('a Codex rollout becomes turns and steps: shell reads/searches classified, apply_patch as writes', () => {
    const line = (type, payload, ts = '2026-11-28T10:00:00Z') => JSON.stringify({ timestamp: ts, type, payload });
    const text = [
        line('session_meta', { id: 'cx1', cwd: ROOT }),
        line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...' }] }),
        line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a flag' }] }),
        line('response_item', { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'rg -n flag src'] }) }),
        line('response_item', { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: '', metadata: { exit_code: 0 } }) }),
        line('response_item', { type: 'function_call', name: 'shell', call_id: 'c2', arguments: JSON.stringify({ command: ['bash', '-lc', "sed -n '1,40p' src/cli.ts"] }) }),
        line('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c3', input: '*** Begin Patch\n*** Update File: src/cli.ts\n+x\n*** Add File: src/flag.ts\n+y\n*** End Patch' }),
        line('response_item', { type: 'custom_tool_call_output', call_id: 'c3', output: 'Success' }),
        line('response_item', { type: 'function_call', name: 'shell', call_id: 'c4', arguments: JSON.stringify({ command: ['npm', 'test'] }) }),
        line('response_item', { type: 'function_call_output', call_id: 'c4', output: JSON.stringify({ output: 'x', metadata: { exit_code: 2 } }) }),
        line('event_msg', { type: 'task_complete' }),
    ].join('\n');
    const { events, sessionId, cwd } = parseCodexRollout(text);
    assert.equal(sessionId, 'cx1');
    assert.equal(cwd, ROOT);
    const types = events.map((e) => e.type === 'step' ? `${e.kind}:${e.status}` : e.type);
    assert.deepEqual(types, ['turn-start', 'search:running', 'search:done', 'read:running', 'write:running', 'write:done', 'execute:running', 'execute:failed', 'turn-end']);
    assert.equal(events[0].prompt, 'Add a flag');
    assert.deepEqual(events[3].locations, [{ path: 'src/cli.ts' }]);
    assert.deepEqual(events[4].created, ['src/flag.ts']);
    assert.equal(events[7].exitCode, 2);
});

// ---- ACP (the IDE's chats) --------------------------------------------------

test('ACP chat events map to trace events: kinds kept across updates, diffs as writes, terminals report exit codes', () => {
    const mapper = new AcpSessionEventMapper();
    const all = [];
    const push = (event, at) => all.push(...mapper.map(event, at));
    push({ type: 'user', text: 'Rename  the\nhelper' }, 1);
    push({ type: 'tool', id: 'a', title: 'Read helper.ts', toolKind: 'read', status: 'in_progress', locations: [{ path: `${ROOT}/helper.ts`, line: 3 }] }, 2);
    push({ type: 'tool', id: 'a', status: 'completed' }, 3);
    push({ type: 'tool', id: 'b', title: 'Edit', status: 'pending', content: [{ type: 'diff', path: `${ROOT}/helper.ts`, oldText: 'a', newText: 'a\nb' }, { type: 'diff', path: `${ROOT}/new.ts`, oldText: null, newText: 'x' }] }, 4);
    push({ type: 'tool', id: 'c', toolKind: 'execute', status: 'in_progress', rawInput: JSON.stringify({ command: 'npm test' }), content: [{ type: 'terminal', terminalId: 'term1' }] }, 5);
    push({ type: 'terminal-output', terminalId: 'term1', exitCode: 1 }, 6);
    push({ type: 'metric-delta', delta: { files: [{ path: 'helper.ts', changes: [{ metric: 'codeLines', before: 10, after: 12 }, { metric: 'cyclomaticComplexityNumber', before: 2, after: 3 }] }] } }, 7);
    push({ type: 'turn-end', stopReason: 'end_turn' }, 8);
    push({ type: 'plan' }, 9);
    assert.equal(all[0].type, 'turn-start');
    assert.equal(all[0].prompt, 'Rename the helper');
    assert.equal(all[1].kind, 'read');
    assert.equal(all[2].kind, 'read', 'an update without a kind keeps the step verb');
    assert.equal(all[2].status, 'done');
    assert.equal(all[3].kind, 'write');
    assert.deepEqual(all[3].created, [`${ROOT}/new.ts`]);
    assert.equal(all[4].command, 'npm test');
    assert.deepEqual({ id: all[5].id, status: all[5].status, exitCode: all[5].exitCode }, { id: 'c', status: 'failed', exitCode: 1 });
    assert.deepEqual(all[6].files, [{ path: 'helper.ts', codeLines: 2, complexity: 1 }]);
    assert.equal(all[7].type, 'turn-end');
    assert.equal(all.length, 8);
});

// ---- layout -----------------------------------------------------------------

function overlaps(a, b) {
    return Math.abs(a.x - b.x) * 2 < (a.w + b.w) - 1e-9 && Math.abs(a.z - b.z) * 2 < (a.d + b.d) - 1e-9;
}

test('the city fits the table box, never overlaps, and keeps files outside the analysis in their own strip', () => {
    const base = Array.from({ length: 120 }, (_, i) => ({ path: `src/m${i % 6}/f${i}.ts`, weight: 10 + (i * 37) % 400 }));
    const extra = Array.from({ length: 30 }, (_, i) => ({ path: `docs/new${i}.md`, weight: 1 }));
    const layout = layoutCity(base, extra);
    const rects = [...layout.files.values()];
    assert.equal(rects.length, 150);
    for (const r of rects) {
        assert.ok(r.w > 0 && r.d > 0);
        assert.ok(r.x - r.w / 2 >= -2.35 - 1e-6 && r.x + r.w / 2 <= 2.35 + 1e-6, 'inside the width');
        assert.ok(r.z - r.d / 2 >= -1.175 - 1e-6 && r.z + r.d / 2 <= 1.175 + 1e-6, 'inside the depth');
    }
    for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
            assert.ok(!overlaps(rects[i], rects[j]), `buildings ${i} and ${j} overlap`);
        }
    }
    assert.ok(layout.extraStrip);
    for (let i = 0; i < 30; i += 1) {
        assert.ok(layout.files.get(`docs/new${i}.md`).x > layout.extraStrip.x - layout.extraStrip.w / 2, 'extra files sit in the strip');
    }
    assert.ok(layout.districts.some((d) => d.path === 'src/m0' || d.path.startsWith('src')));
});

test('relativeToRoot keeps paths inside the root only, on both separator styles', () => {
    assert.equal(relativeToRoot('/a/b', '/a/b/src/x.ts'), 'src/x.ts');
    assert.equal(relativeToRoot('/a/b', 'src/./y/../x.ts'), 'src/x.ts');
    assert.equal(relativeToRoot('/a/b', '/a/bc/x.ts'), null);
    assert.equal(relativeToRoot('/a/b', '../x.ts'), null);
    assert.equal(relativeToRoot('C:\\Work\\P', 'c:/work/p/src/A.ts'), 'src/A.ts');
    assert.equal(relativeToRoot('/a/b', '/a/b'), null);
});

// ---- builder ----------------------------------------------------------------

test('the sample session builds the dataset the scene draws: turns, touches, path, deltas, blast radius, metrics', () => {
    const base = sampleBaseMetrics(EXT_ROOT);
    const tooltips = 'templates/components/codexr/dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js';
    const current = base.map((f) => (f.path === tooltips ? { ...f, loc: f.loc + 11, complexity: f.complexity + 3 } : { ...f }));
    const { dataset, layout } = buildAgentFlowDataset({
        root: EXT_ROOT,
        session: session({ startedAt: T0 }),
        events: sampleEvents(EXT_ROOT),
        baseMetrics: base,
        currentMetrics: current,
        dependencyEdges: [['templates/components/codexr/dependency-graph/dependencyGraphRuntime/viewLifecycle.js', tooltips]],
        revision: 7,
        now: T0,
    });
    assert.equal(dataset.schemaVersion, 1);
    assert.equal(dataset.revision, 7);
    assert.equal(dataset.rootName, 'vscode-extension');
    assert.equal(dataset.turns.length, 3);
    assert.equal(dataset.steps.length, 20);
    assert.deepEqual(dataset.turns.map((t) => [t.stepStart, t.stepEnd]), [[0, 5], [6, 14], [15, 19]]);
    const file = dataset.files.find((f) => f.path === tooltips);
    assert.equal(file.touches.reads, 3);
    assert.equal(file.touches.writes, 2);
    assert.deepEqual(file.turns, [0, 1, 2]);
    assert.deepEqual(file.delta, { codeLines: 11, complexity: 3 }, 'the live re-analysis is the delta source');
    assert.equal(file.dependents, 1);
    const created = dataset.files.find((f) => f.path === 'test/analysis/dependencyGraphTooltip.test.cjs');
    assert.equal(created.created, true);
    const changelog = dataset.files.find((f) => f.path === 'CHANGELOG.md');
    assert.ok(changelog, 'a touched file outside the analysis joins the extra strip');
    assert.ok(layout.extraStrip);
    assert.equal(dataset.metrics.blindWrites, 1, 'CHANGELOG.md was edited without being read');
    assert.equal(dataset.metrics.failures, 1);
    assert.equal(dataset.metrics.unverifiedEdits, 0, 'the last edit is followed by a lint run');
    assert.equal(dataset.metrics.unreadDependents, 1);
    assert.ok(dataset.metrics.revisitRate > 0);
    assert.ok(dataset.transitions.length > 0);
    assert.deepEqual(dataset.blastRadius.map((b) => dataset.files[b.file].path), [tooltips]);
    const failed = dataset.steps.find((s) => s.status === 'failed');
    assert.equal(failed.kind, 'execute');
    assert.equal(failed.exitCode, 1);
    for (const step of dataset.steps) {
        assert.ok(!('paths' in step), 'builder internals do not leak into the dataset');
    }
});

test('a rebuild with the previous layout never moves a building, and new outside files take new slots', () => {
    const base = [{ path: 'a/x.ts', loc: 100 }, { path: 'a/y.ts', loc: 50 }, { path: 'b/z.ts', loc: 70 }];
    const ev1 = [{ type: 'turn-start', at: 1, prompt: 'p' }, { type: 'step', at: 2, id: '1', kind: 'read', locations: [{ path: `${ROOT}/a/x.ts` }] }];
    const first = buildAgentFlowDataset({ root: ROOT, session: session(), events: ev1, baseMetrics: base, revision: 1 });
    const ev2 = [...ev1, { type: 'step', at: 3, id: '2', kind: 'write', created: [`${ROOT}/docs/new.md`], locations: [{ path: `${ROOT}/docs/new.md` }] }];
    const second = buildAgentFlowDataset({ root: ROOT, session: session(), events: ev2, baseMetrics: base, revision: 2, layout: first.layout });
    const pos = (ds, p) => { const f = ds.files.find((x) => x.path === p); return f && [f.x, f.z]; };
    const third = buildAgentFlowDataset({ root: ROOT, session: session(), events: ev2, baseMetrics: base, revision: 3, layout: second.layout });
    assert.deepEqual(pos(third.dataset, 'a/x.ts'), pos(second.dataset, 'a/x.ts'));
    assert.deepEqual(pos(third.dataset, 'docs/new.md'), pos(second.dataset, 'docs/new.md'));
    assert.ok(pos(second.dataset, 'docs/new.md'));
    assert.deepEqual(pos(first.dataset, 'a/x.ts'), pos(second.dataset, 'a/x.ts'), 'the first outside file does not move the city');
    assert.equal(second.dataset.files.find((f) => f.path === 'docs/new.md').created, true);
});

test('a search names many files without moving the agent; folders, outside paths and unknown steps are handled', () => {
    const base = [{ path: 'src/a.ts', loc: 10 }, { path: 'src/b.ts', loc: 10 }];
    const events = [
        { type: 'step', at: 1, id: 's', kind: 'search', locations: [{ path: `${ROOT}/src` }, { path: `${ROOT}/src/a.ts` }, { path: `${ROOT}/src/b.ts` }, { path: '/elsewhere/c.ts' }] },
        { type: 'step', at: 2, id: 'r', kind: 'read', locations: [{ path: 'src/a.ts' }] },
        { type: 'step', at: 3, id: 't', kind: 'think', title: 'Plan' },
        { type: 'step', at: 4, id: 'w', kind: 'write', locations: [{ path: 'src/b.ts' }], added: 5, removed: 1 },
    ];
    const { dataset } = buildAgentFlowDataset({ root: ROOT, session: session(), events, baseMetrics: base, revision: 1 });
    assert.equal(dataset.turns.length, 1, 'steps before any prompt open an unnamed turn');
    assert.deepEqual(dataset.steps[0].files.map((i) => dataset.files[i].path).sort(), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(dataset.transitions, [{ from: dataset.files.find((f) => f.path === 'src/a.ts').index, to: dataset.files.find((f) => f.path === 'src/b.ts').index, count: 1 }]);
    assert.match(dataset.warnings.join(' '), /outside the analysed folder/);
    assert.deepEqual(dataset.files.find((f) => f.path === 'src/b.ts').delta, { codeLines: 4, complexity: 0 }, 'without analysis data the diff estimates the delta');
    assert.equal(dataset.metrics.unverifiedEdits, 1);
    assert.equal(dataset.metrics.unreadDependents, -1, 'unknown without a dependency graph');
    assert.equal(dataset.files.length, 2, 'the folder named by the search scope is not a building');
});

test('a huge project keeps every touched file inside the building budget', () => {
    const base = Array.from({ length: 2000 }, (_, i) => ({ path: `p${i % 20}/f${i}.ts`, loc: i + 1 }));
    const events = [{ type: 'step', at: 1, id: 'r', kind: 'read', locations: [{ path: 'p0/f0.ts' }] }];
    const { dataset } = buildAgentFlowDataset({ root: ROOT, session: session(), events, baseMetrics: base, revision: 1 });
    assert.equal(dataset.files.length, 900);
    assert.ok(dataset.files.some((f) => f.path === 'p0/f0.ts'), 'the smallest file stays because the agent read it');
    assert.match(dataset.warnings.join(' '), /900 of 2000/);
});

// ---- sources + service ------------------------------------------------------

test('Claude Code and Codex sessions of a folder are discovered from the local history, and only those', () => {
    const home = tmpDir('codexr-af-home-');
    const root = path.join(home, 'work', 'proj');
    fs.mkdirSync(root, { recursive: true });
    const claudeDir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(root));
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'one.jsonl'), `${JSON.stringify({ type: 'user', cwd: root, sessionId: 'one', message: { role: 'user', content: 'Make it faster' } })}\n`);
    const other = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(path.join(home, 'work', 'other')));
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'two.jsonl'), `${JSON.stringify({ type: 'user', cwd: path.join(home, 'work', 'other'), message: { role: 'user', content: 'x' } })}\n`);
    const codexDay = path.join(home, '.codex', 'sessions', '2026', '11', '28');
    fs.mkdirSync(codexDay, { recursive: true });
    fs.writeFileSync(path.join(codexDay, 'rollout-a.jsonl'), [
        JSON.stringify({ timestamp: '2026-11-28T10:00:00Z', type: 'session_meta', payload: { id: 'a', cwd: path.join(root, 'sub') } }),
        JSON.stringify({ timestamp: '2026-11-28T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write docs' }] } }),
    ].join('\n'));
    fs.writeFileSync(path.join(codexDay, 'rollout-b.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'b', cwd: '/somewhere/else' } }));
    const options = { home };
    const claude = discoverClaudeCodeSessions(root, options);
    assert.deepEqual(claude.map((s) => [s.id, s.label()]), [['claude-code:one', 'Make it faster']]);
    const codex = discoverCodexSessions(root, options);
    assert.deepEqual(codex.map((s) => [s.id, s.label()]), [['codex:rollout-a', 'Write docs']]);
    assert.equal(listAgentTraceSources(root, options).length, 2);
    assert.equal(isWithinRoot(root, path.join(root, 'a')), true);
    assert.equal(isWithinRoot(root, path.join(home, 'work')), false);
    assert.deepEqual(discoverClaudeCodeSessions(path.join(home, 'nothing'), options), []);
});

test('the service follows a transcript as it grows and rewrites the dataset the scene fetches', async () => {
    const home = tmpDir('codexr-af-svc-');
    const root = path.join(home, 'proj');
    const staticRoot = path.join(home, 'static');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(staticRoot, { recursive: true });
    fs.writeFileSync(path.join(staticRoot, 'data.json'), JSON.stringify([
        { relativePath: 'src/a.ts', codeLines: 40, cyclomaticComplexityNumber: 4, functionCount: 3, language: 'TypeScript' },
        { relativePath: 'src/b.ts', codeLines: 20, cyclomaticComplexityNumber: 2 },
    ]));
    fs.writeFileSync(path.join(staticRoot, 'dependency-graph.json'), JSON.stringify({ nodes: [{ id: 'n1', relativePath: 'src/a.ts' }, { id: 'n2', relativePath: 'src/b.ts' }], edges: [{ source: 'n2', target: 'n1' }] }));
    assert.equal(readAnalysisMetrics(staticRoot).length, 2);
    assert.deepEqual(readDependencyEdges(staticRoot), [['src/b.ts', 'src/a.ts']]);
    const dir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(root));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'live.jsonl');
    const line = (obj) => `${JSON.stringify({ cwd: root, timestamp: new Date().toISOString(), ...obj })}\n`;
    fs.writeFileSync(file, line({ type: 'user', message: { role: 'user', content: 'Refactor a' } }));

    const service = new AgentFlowService({ root, staticRoot, discovery: { home }, throttleMs: 5 });
    const entities = [];
    service.onEntity((entity) => entities.push(entity));
    const sources = service.listSources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].live, true, 'a transcript written just now is live');
    service.open(sources[0].id);
    assert.equal(entities[0].status, 'loading');
    const waitFor = async (predicate) => {
        for (let i = 0; i < 200; i += 1) {
            if (predicate()) { return; }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('timed out');
    };
    await waitFor(() => service.getEntity().status === 'ready');
    // The agent works: the transcript grows.
    fs.appendFileSync(file, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: path.join(root, 'src', 'a.ts') } }] } }));
    fs.appendFileSync(file, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'y', name: 'Edit', input: { file_path: path.join(root, 'src', 'a.ts'), old_string: 'a', new_string: 'a\nb' } }] } }));
    // ... and the live re-analysis sees it.
    fs.writeFileSync(path.join(staticRoot, 'data.json'), JSON.stringify([
        { relativePath: 'src/a.ts', codeLines: 43, cyclomaticComplexityNumber: 5 },
        { relativePath: 'src/b.ts', codeLines: 20, cyclomaticComplexityNumber: 2 },
    ]));
    await waitFor(() => (service.getDataset()?.steps.length ?? 0) === 2);
    service.requestRefresh();
    await waitFor(() => service.getDataset()?.files.find((f) => f.path === 'src/a.ts').delta?.codeLines === 3);
    const entity = service.getEntity();
    assert.equal(entity.status, 'ready');
    assert.match(entity.datasetUrl, /^\/agent-flow\/agent-flow-\d+\.json$/);
    const written = JSON.parse(fs.readFileSync(path.join(staticRoot, entity.datasetUrl), 'utf8'));
    assert.equal(written.revision, entity.revision);
    assert.equal(written.metrics.unreadDependents, 1, 'b.ts imports the edited a.ts and was never read');
    const kept = fs.readdirSync(path.join(staticRoot, 'agent-flow')).filter((n) => /^agent-flow-\d+\.json$/.test(n));
    assert.ok(kept.length <= 3, 'old revisions are pruned');
    service.close();
    assert.equal(service.getEntity().status, 'idle');
    assert.equal(service.getEntity().datasetUrl, null);
    assert.throws(() => service.open('claude-code:missing'), /no longer available/);
    service.dispose();
});

test('a host pushes a live chat: it is listed for its folder, followed, and "Watch in XR" opens it in that folder\'s scenes', async () => {
    const staticRoot = tmpDir('codexr-af-live-');
    const root = tmpDir('codexr-af-live-root-');
    const source = new PushAgentTraceSource('ide-chat:1', 'ide-acp', 'Claude Code', 'Chat one');
    source.push([{ type: 'turn-start', at: 1, prompt: 'hi' }]);
    const unregister = registerLiveAgentTraceSource(root, source);
    const service = new AgentFlowService({ root, staticRoot, discovery: { home: staticRoot }, throttleMs: 1 });
    assert.deepEqual(service.listSources().map((s) => [s.id, s.kind, s.live]), [['ide-chat:1', 'ide-acp', true]]);
    let activated = 0;
    const unregisterController = registerAgentFlowController({ service, activate: () => { activated += 1; } });
    assert.equal(openAgentFlowInScenes(path.join(root, '.'), 'ide-chat:1'), 1);
    assert.equal(openAgentFlowInScenes('/not/this/root', 'ide-chat:1'), 0);
    assert.equal(activated, 1);
    source.push([{ type: 'step', at: 2, id: 'a', kind: 'read', locations: [{ path: path.join(root, 'x.ts') }] }]);
    service.rebuildNow();
    assert.equal(service.getDataset().steps.length, 1);
    assert.equal(service.getDataset().files[0].path, 'x.ts');
    unregisterController();
    unregister();
    assert.deepEqual(service.listSources(), []);
    service.dispose();
});
