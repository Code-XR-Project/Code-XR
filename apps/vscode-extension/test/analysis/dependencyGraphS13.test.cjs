/**
 * S13 (#85): the dependency graph shows correct numbers and a usable view.
 * DEPGRAPH-1 (folder cards), -4 (scope and dataset travel together),
 * -5 (render budget, a real force layout), -6 (worker ownership),
 * -8 (file cache invalidation), -11 (snapshot identity).
 * The engine side (DEPGRAPH-2, -3, -10) is in
 * backend/tests/dependencies/test_dependency_resolution.py.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const { readAssembledRuntime } = require(path.join(root, 'test', 'helpers', 'runtimeAssembly.cjs'));

function loadRuntime(extra = {}) {
  const source = readAssembledRuntime('dependency-graph', 'dependencyGraphRuntime.js');
  const context = { ...extra };
  vm.runInNewContext(source, context);
  return { context, helpers: context.CodeXRDependencyGraphRuntime.__testing };
}

const file = (id, relativePath, metrics = {}) => ({
  id, kind: 'file', label: relativePath.split('/').pop(), relativePath, external: false,
  metrics: { totalLines: 10, fanIn: 0, fanOut: 0, degree: 0, dependentCount: 0, cycleSize: 0, relationCount: 0, ...metrics },
});
const edge = (source, target, kind = 'import') => ({ id: `${source}>${target}`, source, target, kind, confidence: 'exact', occurrences: 1 });

test('S13 DEPGRAPH-1: a folder card is computed on the folder, not summed per file', () => {
  const { helpers } = loadRuntime();
  // Two files of a/ import each other (a cycle of 2) and one external package.
  const dataset = {
    nodes: [
      file('f:a1', 'a/one.ts', { fanIn: 1, fanOut: 2, degree: 2, relationCount: 3, cycleSize: 2 }),
      file('f:a2', 'a/two.ts', { fanIn: 1, fanOut: 2, degree: 2, relationCount: 3, cycleSize: 2 }),
      file('f:main', 'main.ts', { fanOut: 1 }),
      { id: 'external:react', kind: 'external', label: 'react', external: true, metrics: {} },
    ],
    edges: [edge('f:a1', 'f:a2'), edge('f:a2', 'f:a1'), edge('f:a1', 'external:react'), edge('f:a2', 'external:react'), edge('f:main', 'f:a1')],
  };
  const projected = helpers.projectDirectoryScope(dataset, '');
  const withMetrics = helpers.aggregateMetricsFromEdges(projected.nodes, projected.edges);
  const folder = withMetrics.find((node) => node.id === 'scope:directory:a');
  assert.equal(folder.metrics.files, 2);
  assert.equal(folder.metrics.totalLines, 20);
  assert.equal(folder.metrics.fanOut, 1, 'one distinct target outside the folder: react');
  assert.equal(folder.metrics.fanIn, 1, 'main.ts');
  assert.equal(folder.metrics.degree, 2);
  assert.equal(folder.metrics.cycleSize, 2, 'files of the folder in a cycle, not a sum of cycle sizes');

  const card = helpers.nodeDetailModel(folder);
  const rows = Object.fromEntries(card.rows.map((row) => [row.label, row.value]));
  assert.equal(rows.Files, '2');
  assert.equal(rows['In cycles'], '2');
  assert.equal(rows.Cycle, undefined);
  const fileCard = Object.fromEntries(helpers.nodeDetailModel(dataset.nodes[0]).rows.map((row) => [row.label, row.value]));
  assert.equal(fileCard['Cycle size'], '2');
});

test('S13 DEPGRAPH-5: a view over the render budget keeps 600 nodes and says so', () => {
  const { helpers } = loadRuntime();
  const nodes = Array.from({ length: 2000 }, (_unused, index) => file(`f:${index}`, `src/f${index}.ts`));
  const edges = Array.from({ length: 3000 }, (_unused, index) => edge(`f:${index % 50}`, `f:${(index * 7) % 2000}`));
  const budgeted = helpers.applyRenderBudget(nodes, edges);
  assert.equal(budgeted.nodes.length, 600);
  assert.ok(budgeted.edges.length <= 2000);
  const rest = budgeted.nodes.find((node) => node.syntheticKind === 'budget-rest');
  assert.equal(rest.label, '1401 more');
  assert.ok(budgeted.nodes.some((node) => node.id === 'f:0'), 'the best-connected nodes stay');
  assert.match(helpers.renderBudgetNotice(budgeted.budget), /^Showing 600 of 2000 nodes/);
  const small = helpers.applyRenderBudget(nodes.slice(0, 10), edges.slice(0, 5));
  assert.equal(small.budget, null);
  assert.equal(helpers.renderBudgetNotice(small.budget), '');
});


test('S13 DEPGRAPH-5/6: the force layout uses the edges and the whole table; the Blob URL is revoked', () => {
  const captured = {};
  const { helpers } = loadRuntime({
    Blob: function Blob(parts) { captured.source = parts.join(''); },
    URL: { createObjectURL: () => 'blob:layout', revokeObjectURL: (url) => { captured.revoked = url; } },
    Worker: function Worker(url) { captured.url = url; },
  });
  helpers.createLayoutWorker();
  assert.equal(captured.url, 'blob:layout');
  assert.equal(captured.revoked, 'blob:layout', 'the URL is revoked once the worker exists');

  const self = {};
  vm.runInNewContext(captured.source, { self, Math });
  const nodes = Array.from({ length: 300 }, (_unused, index) => ({ id: `n${index}`, metrics: {} }));
  const links = Array.from({ length: 299 }, (_unused, index) => ({ source: `n${index}`, target: `n${index + 1}` }));
  let positions = null;
  self.postMessage = (message) => { positions = message.positions; };
  self.onmessage({ data: { nodes, edges: links, layout: 'force-3d', width: 4.7, depth: 2.35, generation: 1 } });
  const radii = new Set(Object.values(positions).map((point) => Math.hypot(point.x, point.z).toFixed(3)));
  assert.ok(radii.size > 20, `distinct radii: ${radii.size}`);
  const xs = Object.values(positions).map((point) => Math.abs(point.x));
  const zs = Object.values(positions).map((point) => Math.abs(point.z));
  assert.ok(Math.max(...xs) <= 4.7 / 2 && Math.max(...zs) <= 2.35 / 2, 'inside the table');
  assert.ok(Math.max(...xs) > 1.5, 'uses the table width, not a 1 m disc');
  // Linked nodes sit closer than the average pair.
  const distance = (a, b) => Math.hypot(positions[a].x - positions[b].x, positions[a].z - positions[b].z);
  const linked = links.reduce((sum, link) => sum + distance(link.source, link.target), 0) / links.length;
  const random = nodes.slice(0, 100).reduce((sum, node, index) => sum + distance(node.id, nodes[(index * 97 + 50) % 300].id), 0) / 100;
  assert.ok(linked < random, `linked ${linked.toFixed(2)} < unrelated ${random.toFixed(2)}`);
});

test('S13 DEPGRAPH-6: no graph is handed to a component A-Frame has not initialized', () => {
  const { helpers } = loadRuntime();
  assert.equal(helpers.isGraphComponentReady({ setGraph() {}, initialized: false }), false);
  assert.equal(helpers.isGraphComponentReady({ setGraph() {}, initialized: true }), true);
  assert.equal(helpers.isGraphComponentReady(undefined), false);
  const source = readAssembledRuntime('dependency-graph', 'dependencyGraphRuntime.js');
  assert.match(source, /init: function \(\) \{[\s\S]{0,400}this\.worker\?\.terminate\?\.\(\);\s+this\.worker = null;/);
  assert.match(source, /this\.worker\.onerror = function/);
});

test('S13 DEPGRAPH-4: the dataset fetched is the one that draws the scope', () => {
  const { helpers } = loadRuntime();
  const project = '/dependencies/dependency-graph-4.json';
  const fileUrl = '/dependencies/dependency-scope-5.json';
  // A folder after a drill-down: the entity's datasetUrl may still name the file.
  assert.equal(helpers.datasetUrlForScope({
    scope: { kind: 'directory', relativePath: 'core' }, datasetUrl: fileUrl, projectDatasetUrl: project,
  }), project);
  assert.equal(helpers.datasetUrlForScope({
    scope: { kind: 'file', relativePath: 'core/a.ts' }, datasetUrl: project, projectDatasetUrl: project,
    fileDatasetUrl: fileUrl, fileDatasetPath: 'core/a.ts',
  }), fileUrl);
  // A file dataset for another file is not used.
  assert.equal(helpers.datasetUrlForScope({
    scope: { kind: 'file', relativePath: 'core/b.ts' }, datasetUrl: project, projectDatasetUrl: project,
    fileDatasetUrl: fileUrl, fileDatasetPath: 'core/a.ts',
  }), project);
});

test('S13 DEPGRAPH-8: a new project revision drops the cached file datasets; opening a file always asks the server', () => {
  const sent = [];
  const { helpers } = loadRuntime({
    CodeXRCollaborationRuntime: { getClient: () => ({ sendMessage: (type, payload) => sent.push([type, payload]) }) },
  });
  helpers.state.projectDataset = { revision: 1, targetType: 'directory' };
  helpers.state.fileDatasets = { 'a.ts': { id: 'old-a' }, 'b.ts': { id: 'old-b' } };
  helpers.setProjectDataset({ revision: 2, targetType: 'directory' }, 'b.ts');
  assert.deepEqual(Object.keys(helpers.state.fileDatasets), ['b.ts'], 'only the file the same snapshot delivered stays');
  helpers.setProjectDataset({ revision: 2, targetType: 'directory' }, '');
  assert.deepEqual(Object.keys(helpers.state.fileDatasets), ['b.ts'], 'the same revision keeps the cache');

  helpers.openFile('b.ts');
  assert.equal(JSON.stringify(sent), JSON.stringify([['dependency-file-scope-request', { relativePath: 'b.ts' }]]));
});
