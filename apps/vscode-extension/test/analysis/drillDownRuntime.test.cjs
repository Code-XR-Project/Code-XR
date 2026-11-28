/**
 * #333 drill-down, the scene runtime (templates/components/codexr/drill-down):
 * what a picked Babia element stands for, how the crumbs fit the bar, the
 * status line, the inspector's actions and the messages they send. The
 * server side is test/analysis/drillDownCore.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const { readAssembledRuntime } = require(path.join(projectRoot, 'test', 'helpers', 'runtimeAssembly.cjs'));
const source = readAssembledRuntime('drill-down', 'drillDownRuntime.js');

/** The runtime without a document: nothing mounts, the pure parts and the API are there. */
function loadRuntime({ mode = 'single', client, mappingUi } = {}) {
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout() { return 0; },
        clearTimeout() {},
        CodeXRAnalysisModeRuntime: { getState: () => ({ mode }) },
        CodeXRCollaborationRuntime: client ? { getClient: () => client } : undefined,
        CodeXRMappingUiRuntime: mappingUi,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(source, sandbox, { filename: 'drillDownRuntime.js' });
    return sandbox.CodeXRDrillDownRuntime;
}

const ROOT = '/home/ana/proj';

test('a directory building is a file, a district a folder, and the drilled tree namespace is stripped', () => {
    const { __testing: t } = loadRuntime();
    const context = { viewKind: 'directory', rootPath: ROOT };

    const file = t.targetFromRaw({ filePath: `${ROOT}/src/a.ts`, fileName: 'a.ts' }, context);
    assert.equal(file.type, 'file');
    assert.equal(file.relativePath, 'src/a.ts');
    assert.equal(file.folderPath, `${ROOT}/src`);
    assert.equal(file.folderRelativePath, 'src');
    assert.equal(file.inside, true);

    const district = t.targetFromRaw({ uid: 'drill-down:home/ana/proj/src/util', name: 'util', children: [] }, context);
    assert.equal(district.type, 'folder');
    assert.equal(district.path, `${ROOT}/src/util`);
    assert.equal(district.relativePath, 'src/util');

    const outside = t.targetFromRaw({ filePath: '/elsewhere/x.ts' }, context);
    assert.equal(outside.inside, false);
    assert.equal(t.targetFromRaw({ nothing: true }, context), null);
    assert.equal(t.targetFromRaw(null, context), null);
});

test('a drilled folder resolves its relative district uids from the folder it shows', () => {
    const { __testing: t } = loadRuntime();
    // Drilled into ROOT/src: the tree path is `src/<path>`, hanging from ROOT.
    const context = { viewKind: 'directory', rootPath: ROOT, treeBase: ROOT };
    assert.equal(t.targetFromRaw({ uid: 'drill-down:src/util/net', name: 'net', children: [] }, context).relativePath, 'src/util/net');
    assert.equal(t.targetFromRaw({ uid: 'drill-down:src', name: 'src', children: [] }, context).relativePath, 'src', 'the top district is the folder itself');
});

test('in a file analysis, a building is a function with its line and the district is the file', () => {
    const { __testing: t } = loadRuntime();
    const context = { viewKind: 'file', rootPath: ROOT, currentPath: `${ROOT}/src/a.ts` };
    const fn = t.targetFromRaw({ functionName: 'run', filePath: `${ROOT}/src/a.ts`, lineStart: 12, lineEnd: 30 }, context);
    assert.equal(fn.type, 'function');
    assert.equal(fn.line, 12);
    assert.equal(fn.folderRelativePath, 'src');
    const district = t.targetFromRaw({ uid: 'a.ts', name: 'a.ts', children: [] }, context);
    assert.equal(district.type, 'file');
    assert.equal(district.relativePath, 'src/a.ts');
});

test('paths are normalised the way Babia writes them, and compared without case', () => {
    const { __testing: t } = loadRuntime();
    assert.equal(t.normalizePath('C:\\Proj\\src\\'), '/Proj/src');
    assert.equal(t.normalizePath('a//b/'), '/a/b');
    assert.equal(t.relativeTo('/Proj', '/proj/Src/A.ts'), 'Src/A.ts');
    assert.equal(t.relativeTo('/proj', '/project/a.ts'), null, 'a sibling with the same prefix is outside');
    assert.equal(t.parentPath('/a'), '/');
});

test('the crumbs keep the root and the current target, collapsing the middle into one jump', () => {
    const { __testing: t } = loadRuntime();
    const crumbs = ['proj', 'src', 'core', 'server', 'analysis', 'collaboration', 'drillDownHostWiring.ts'].map((label, index, all) => ({
        label,
        relativePath: all.slice(1, index + 1).join('/'),
        kind: index === all.length - 1 ? 'file' : 'directory',
    }));
    const short = t.layoutCrumbs(crumbs.slice(0, 3), 10);
    assert.equal(short.length, 3, 'crumbs that fit are left alone');
    const laid = t.layoutCrumbs(crumbs, 3.55, 0.16);
    assert.equal(laid[0].label, 'proj');
    assert.equal(laid[1].ellipsis, true);
    assert.equal(laid.at(-1).relativePath, crumbs.at(-1).relativePath);
    const width = laid.reduce((sum, c) => sum + t.crumbWidth(c.ellipsis ? '...' : c.label) + 0.16, -0.16);
    assert.ok(width <= 3.55 + 1e-9, `the crumbs fit the bar (${width.toFixed(2)} m)`);
    const hidden = crumbs.slice(1, crumbs.length - (laid.length - 2));
    assert.equal(laid[1].relativePath, hidden.at(-1).relativePath, 'the ellipsis jumps to the deepest hidden ancestor');
});

test('the status line tells reuse from analysis', () => {
    const { __testing: t } = loadRuntime();
    assert.equal(t.describeReady({ rowCount: 12, analyzedCount: 2, reusedCount: 10, target: { kind: 'directory' } }), '12 files: 10 reused, 2 analysed.');
    assert.equal(t.describeReady({ rowCount: 3, analyzedCount: 0, reusedCount: 3, target: { kind: 'directory' } }), '3 files: all up to date, nothing analysed.');
    assert.equal(t.describeReady({ rowCount: 1, analyzedCount: 0, target: { kind: 'file' } }), '1 function: up to date, nothing analysed.');
    assert.equal(t.formatElapsed(1234), '1.2 s');
    assert.equal(t.formatElapsed(42000), '42 s');
});

test('a shared entity is normalised defensively', () => {
    const { __testing: t } = loadRuntime();
    assert.equal(t.normalizeEntity(null), null);
    const entity = t.normalizeEntity({ status: 'ready', revision: '3', target: { kind: 'weird', relativePath: 'src' }, datasetUrl: '', mapping: 'x' });
    assert.equal(entity.revision, 3);
    assert.equal(entity.target.kind, 'directory');
    assert.equal(entity.datasetUrl, null);
    assert.deepEqual({ ...entity.mapping }, {});
    assert.equal(entity.atHome, true);
    assert.equal(entity.chartId, 'boats');
});

test('the inspector offers Analyze file and Analyze folder, and refuses targets outside the root', () => {
    const sent = [];
    const runtime = loadRuntime({ client: { sendMessage: (type, payload) => { sent.push([type, payload]); return true; } } });
    const t = runtime.__testing;
    runtime.applySharedState({ status: 'ready', revision: 1, rootLabel: 'proj', rootPath: ROOT, atHome: true, target: { kind: 'directory', relativePath: '' } });

    const file = t.targetFromRaw({ filePath: `${ROOT}/src/a.ts` }, { viewKind: 'directory', rootPath: ROOT });
    const { actions, note } = t.cardActions(file);
    assert.equal(note, '');
    assert.deepEqual(JSON.parse(JSON.stringify(actions.map((a) => [a.label, a.enabled]))), [['Analyze file', true], ['Analyze folder', true]]);
    actions[0].run();
    actions[1].run();
    assert.deepEqual(sent.map(([type, payload]) => [type, payload.kind, payload.path]), [
        ['drilldown-open', 'file', `${ROOT}/src/a.ts`],
        ['drilldown-open', 'directory', `${ROOT}/src`],
    ]);

    const outside = t.targetFromRaw({ filePath: '/elsewhere/x.ts' }, { viewKind: 'directory', rootPath: ROOT });
    const refused = t.cardActions(outside);
    assert.ok(refused.actions.every((a) => !a.enabled));
    assert.equal(refused.note, 'Outside proj');
});

test('the public API sends the navigation messages, and an exported copy explains why it cannot', () => {
    const sent = [];
    const runtime = loadRuntime({ client: { sendMessage: (type, payload) => { sent.push([type, payload]); return true; } } });
    runtime.back();
    runtime.forward();
    runtime.home();
    runtime.goto('src', 'directory');
    assert.deepEqual(sent.map(([type]) => type), ['drilldown-back', 'drilldown-forward', 'drilldown-home', 'drilldown-goto']);
    assert.deepEqual({ ...sent[3][1] }, { relativePath: 'src', kind: 'directory' });

    const offline = loadRuntime({ client: { sendMessage: () => true, isOfflineExport: () => true } });
    assert.equal(offline.back(), false);
    assert.match(offline.getState().lastError, /exported copy/);
});

test('the card lists a building\'s three metrics from the chart\'s own mapping, and none for a district', () => {
    const { __testing: t } = loadRuntime();
    const chart = { getAttribute: (name) => (name === 'babia-boats' ? { height: 'totalLines', area: 'functionCount', color: 'cyclomaticComplexityNumber' } : null) };
    const lines = t.chartMetrics(chart, { totalLines: 500, functionCount: 23, cyclomaticComplexityNumber: 5.0833 });
    assert.deepEqual([...lines], ['totalLines (height): 500', 'functionCount (area): 23', 'cyclomaticComplexityNumber (color): 5.08']);
    assert.deepEqual([...t.chartMetrics(chart, { uid: 'src', children: [] })], []);
    assert.deepEqual([...t.chartMetrics(chart, { totalLines: 3 })], ['totalLines (height): 3'], 'a metric the row lacks is left out');
    assert.deepEqual([...t.chartMetrics({ getAttribute: () => null }, { totalLines: 3 })], [], 'not a boats chart');
});

test('only the legend boats hangs beside a pickable chart is recognised as Babia\'s legend', () => {
    const { __testing: t } = loadRuntime();
    const node = (tagName, attributes, parentNode) => ({
        nodeType: 1, tagName, parentNode, id: attributes.id || '',
        hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attributes, name),
    });
    const parent = { children: [] };
    parent.children.push(node('A-ENTITY', { id: 'chart', 'babia-boats': '' }, parent));
    assert.equal(t.isBoatsLegend(node('A-PLANE', { 'babia-lookat': '[camera]' }, parent)), true);
    assert.equal(t.isBoatsLegend(node('A-PLANE', {}, parent)), false, 'a plain plane');
    assert.equal(t.isBoatsLegend(node('A-TEXT', { 'babia-lookat': '' }, parent)), false);
    const barsParent = { children: [] };
    barsParent.children.push(node('A-ENTITY', { id: 'chart', 'babia-bars': '' }, barsParent));
    assert.equal(t.isBoatsLegend(node('A-PLANE', { 'babia-lookat': '' }, barsParent)), false, 'another chart keeps its legend');
});

test('a drill with the session\'s own schema follows the controller; the functions of a file keep the server\'s mapping', () => {
    const entity = (kind) => ({ target: { kind, relativePath: 'src' }, homeKind: 'directory', chartId: 'boats', mapping: { height: 'nloc' } });
    const plain = (value) => JSON.parse(JSON.stringify(value));

    const alone = loadRuntime().__testing;
    assert.deepEqual(plain(alone.drillChartSpec(entity('directory'))), { chartId: 'boats', mapping: { height: 'nloc' }, controllerDriven: false }, 'no controller in the page');

    const controller = { chartId: 'bars', lastKnownGoodMapping: { height: 'totalLines', x_axis: 'fileName' } };
    const t = loadRuntime({ mappingUi: { getState: () => controller } }).__testing;
    assert.deepEqual(plain(t.drillChartSpec(entity('directory'))), { chartId: 'bars', mapping: { height: 'totalLines', x_axis: 'fileName' }, controllerDriven: true }, 'a folder of a project');
    assert.deepEqual(plain(t.drillChartSpec(entity('file'))), { chartId: 'boats', mapping: { height: 'nloc' }, controllerDriven: false }, 'the functions of one file');
});
