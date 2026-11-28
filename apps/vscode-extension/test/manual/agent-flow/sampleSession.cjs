'use strict';
/**
 * A scripted, deterministic agent session over the extension's own sources,
 * used by the Agent Flow harness, the runtime tests and the screenshots. It
 * reads like a real Claude Code session: explore, implement, a failing test,
 * a fix, a passing test. Paths are relative to the extension root.
 *
 * `node test/manual/agent-flow/sampleSession.cjs` (after `npm run compile-tests`)
 * writes `sample-dataset.json` next to this file from the real file sizes.
 */
const fs = require('fs');
const path = require('path');

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const T0 = Date.parse('2026-11-28T09:00:00Z');

function sampleEvents(root) {
    const abs = (rel) => path.join(root, rel);
    let t = T0;
    let n = 0;
    const tick = (s) => (t += s * 1000);
    const events = [];
    const step = (kind, tool, files, extra = {}) => {
        const id = `tool-${++n}`;
        events.push({ type: 'step', at: tick(extra.wait ?? 4), id, kind, tool, title: extra.title ?? `${tool} ${files.map((f) => path.basename(f)).join(', ')}`.trim(), status: 'running', locations: files.map((f) => ({ path: abs(f) })), ...(extra.fields ?? {}) });
        events.push({ type: 'step', at: tick(1), id, kind, status: extra.failed ? 'failed' : 'done', ...(extra.update ?? {}) });
    };
    events.push({ type: 'turn-start', at: tick(0), prompt: 'The dependency graph tooltip should show fan-in and fan-out. Find where it is built and add both.' });
    step('search', 'Grep', [], { title: 'Grep tooltip', update: { locations: [
        'templates/components/codexr/dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js',
        'templates/components/codexr/dependency-graph/dependencyGraphRuntime/edgesAndHighlights.js',
        'templates/components/common/codexrCommonRuntime.js',
        'src/core/dependencies/dependencyGraphModels.ts',
    ].map((p) => ({ path: abs(p) })) } });
    // Two sub-agents explore in parallel while the main agent reads on.
    step('delegate', 'Agent', [], { title: 'Agent: Map the tooltip code', fields: { spawns: { id: 'tool-sub-a', label: 'Map the tooltip code' } }, wait: 3 });
    const spawnA = t;
    step('delegate', 'Agent', [], { title: 'Agent: Find the dependency tests', fields: { spawns: { id: 'tool-sub-b', label: 'Find the dependency tests' } }, wait: 1 });
    const spawnB = t;
    const sub = (actor, start, kind, tool, files, extra = {}) => {
        const id = `${actor}-${++n}`;
        events.push({ type: 'step', at: start, id, kind, tool, title: extra.title ?? `${tool} ${files.map((f) => path.basename(f)).join(', ')}`.trim(), status: 'running', actor, subagent: true, locations: files.map((f) => ({ path: abs(f) })) });
        events.push({ type: 'step', at: start + 2500, id, kind, status: 'done', actor, ...(extra.update ?? {}) });
    };
    sub('tool-sub-a', spawnA + 2000, 'read', 'Read', ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/edgesAndHighlights.js']);
    sub('tool-sub-a', spawnA + 6000, 'read', 'Read', ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/componentCore.js']);
    sub('tool-sub-a', spawnA + 10000, 'read', 'Read', ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/scalesAndControls.js']);
    sub('tool-sub-b', spawnB + 1500, 'search', 'Glob', [], { title: 'Glob test/analysis/dependency*', update: { locations: ['test/analysis/dependencyGraph.test.cjs'].map((p) => ({ path: abs(p) })) } });
    sub('tool-sub-b', spawnB + 5500, 'read', 'Read', ['test/analysis/dependencyGraph.test.cjs']);
    sub('tool-sub-b', spawnB + 9500, 'read', 'Read', ['src/core/server/analysis/dependencyGraphBridge.ts']);
    step('read', 'Read', ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js']);
    step('read', 'Read', ['src/core/dependencies/dependencyGraphModels.ts']);
    step('read', 'Read', ['src/core/dependencies/dependencyGraphService.ts']);
    step('search', 'Glob', [], { title: 'Glob **/datasetProjection*', update: { locations: [{ path: abs('templates/components/codexr/dependency-graph/dependencyGraphRuntime/datasetProjection.js') }] } });
    step('read', 'Read', ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/datasetProjection.js']);
    events.push({ type: 'turn-end', at: tick(6), stopReason: 'end_turn' });

    events.push({ type: 'turn-start', at: tick(40), prompt: 'Go ahead and implement it, with a unit test.' });
    step('read', 'Read', ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js']);
    step('write', 'Edit', ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js'], { fields: { added: 14, removed: 3 } });
    step('write', 'Edit', ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/datasetProjection.js'], { fields: { added: 6, removed: 1 } });
    step('read', 'Read', ['test/analysis/dependencyGraph.test.cjs']);
    step('write', 'Write', ['test/analysis/dependencyGraphTooltip.test.cjs'], { fields: { added: 58, created: [abs('test/analysis/dependencyGraphTooltip.test.cjs')] } });
    // The agent stops for the person's permission before running the tests.
    step('wait', 'permission', [], { title: 'Allow: npm run test:unit', wait: 3, update: {} });
    events[events.length - 1].at += 5000;
    t += 5000;
    step('execute', 'Bash', [], { title: 'npm run test:unit -- dependencyGraphTooltip', fields: { command: 'npm run test:unit -- dependencyGraphTooltip' }, failed: true, update: { exitCode: 1 }, wait: 8 });
    step('read', 'Read', ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js']);
    step('write', 'Edit', ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js'], { fields: { added: 2, removed: 2 } });
    step('execute', 'Bash', [], { title: 'npm run test:unit -- dependencyGraphTooltip', fields: { command: 'npm run test:unit -- dependencyGraphTooltip' }, update: { exitCode: 0 }, wait: 8 });
    events.push({ type: 'turn-end', at: tick(5), stopReason: 'end_turn' });

    events.push({ type: 'turn-start', at: tick(55), prompt: 'Also show them in the LivePanel dependency summary.' });
    step('search', 'Grep', [], { title: 'Grep fanIn', update: { locations: [
        'templates/components/livepanel/dependencySummaryPanel.js',
        'src/core/dependencies/dependencyGraphModels.ts',
        'templates/components/codexr/dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js',
    ].map((p) => ({ path: abs(p) })) } });
    step('read', 'Read', ['templates/components/livepanel/dependencySummaryPanel.js']);
    step('write', 'Edit', ['templates/components/livepanel/dependencySummaryPanel.js'], { fields: { added: 21, removed: 4 } });
    step('write', 'Edit', ['CHANGELOG.md'], { fields: { added: 2, removed: 0 } });
    step('execute', 'Bash', [], { title: 'npm run lint', fields: { command: 'npm run lint' }, update: { exitCode: 0 }, wait: 12 });
    events.push({ type: 'turn-end', at: tick(4), stopReason: 'end_turn' });
    return events;
}

function walk(dir, root, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full, root, out); continue; }
        if (!/\.(ts|js|cjs)$/.test(entry.name)) { continue; }
        const text = fs.readFileSync(full, 'utf8');
        const loc = text.split('\n').filter((line) => line.trim()).length;
        const complexity = (text.match(/\b(if|for|while|case|catch)\b|\?\s|&&|\|\|/g) || []).length;
        out.push({ path: path.relative(root, full).split(path.sep).join('/'), loc, complexity, language: entry.name.endsWith('.ts') ? 'TypeScript' : 'JavaScript' });
    }
}

function sampleBaseMetrics(root) {
    const out = [];
    for (const folder of ['src/core/dependencies', 'src/core/history', 'src/core/server/analysis', 'src/core/charts', 'templates/components/codexr/dependency-graph', 'templates/components/codexr/project-evolution', 'templates/components/livepanel', 'templates/components/common', 'test/analysis']) {
        const dir = path.join(root, folder);
        if (fs.existsSync(dir)) { walk(dir, root, out); }
    }
    return out;
}

module.exports = { sampleEvents, sampleBaseMetrics, EXT_ROOT, T0 };

if (require.main === module) {
    const { buildAgentFlowDataset } = require(path.join(EXT_ROOT, 'out', 'core', 'agent-flow', 'agentFlowBuilder.js'));
    const base = sampleBaseMetrics(EXT_ROOT);
    const current = base.map((file) => ({ ...file }));
    const bump = (rel, lines, cx) => { const f = current.find((x) => x.path === rel); if (f) { f.loc += lines; f.complexity += cx; } };
    bump('templates/components/codexr/dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js', 11, 3);
    bump('templates/components/codexr/dependency-graph/dependencyGraphRuntime/datasetProjection.js', 5, 1);
    bump('templates/components/livepanel/dependencySummaryPanel.js', 17, 4);
    current.push({ path: 'test/analysis/dependencyGraphTooltip.test.cjs', loc: 52, complexity: 2, language: 'JavaScript' });
    const edges = [
        ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/viewLifecycle.js', 'templates/components/codexr/dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js'],
        ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/componentCore.js', 'templates/components/codexr/dependency-graph/dependencyGraphRuntime/tooltipsAndSelection.js'],
        ['templates/components/codexr/dependency-graph/dependencyGraphRuntime/scalesAndControls.js', 'templates/components/codexr/dependency-graph/dependencyGraphRuntime/datasetProjection.js'],
        ['src/core/server/analysis/dependencyGraphBridge.ts', 'src/core/dependencies/dependencyGraphModels.ts'],
    ];
    const { dataset } = buildAgentFlowDataset({
        root: EXT_ROOT,
        session: { id: 'sample', source: 'fixture', agent: 'Claude Code', label: 'Fan-in/fan-out tooltip (sample)', startedAt: T0, updatedAt: T0 + 600000, live: false },
        events: sampleEvents(EXT_ROOT),
        baseMetrics: base,
        currentMetrics: current,
        dependencyEdges: edges,
        revision: 1,
        now: T0 + 600000,
    });
    const out = path.join(__dirname, 'sample-dataset.json');
    fs.writeFileSync(out, JSON.stringify(dataset, null, 1));
    console.log(`wrote ${out}: ${dataset.files.length} files, ${dataset.steps.length} steps, ${dataset.turns.length} turns`);
    console.log(JSON.stringify(dataset.metrics));
}
