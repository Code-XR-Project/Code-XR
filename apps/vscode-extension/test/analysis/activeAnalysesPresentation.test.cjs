const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

// Characterization of what the Active Analyses tree shows for a session
// (ROADMAP W4-T11, hotspots-ts/CPLX-10b/c): the item's icon (id and theme
// colour) per analysis mode and target type, its description (mode label and
// status label), its resourceUri, and the session fields copied onto the
// TreeItem for the context-menu commands. Runs the real service from out/
// against a stub session registry.

const MODULE = 'features/analysis/sections/active-analyses/activeAnalysesDataService.js';

async function render(sessions) {
    const fake = createFakeVscode();
    return withFakeVscode(fake, async ({ requireOut }) => {
        const { ActiveAnalysesDataService } = requireOut(MODULE);
        const service = ActiveAnalysesDataService.getInstance();
        service.sessionRegistry = { getAllSessions: () => sessions, getSession: (id) => sessions.find((s) => s && s.id === id) };
        const items = await service.getChildren();
        return items.map((item) => {
            const treeItem = service.getTreeItem(item);
            return {
                label: treeItem.label,
                description: treeItem.description,
                contextValue: treeItem.contextValue,
                icon: treeItem.iconPath && [treeItem.iconPath.id, treeItem.iconPath.color && treeItem.iconPath.color.id],
                resource: treeItem.resourceUri && treeItem.resourceUri.fsPath,
                sessionId: treeItem.sessionId,
                analysisType: treeItem.analysisType,
                status: treeItem.status,
                targetPath: treeItem.targetPath,
                serverUrl: treeItem.serverUrl,
                assignedPort: treeItem.assignedPort,
                command: treeItem.command && treeItem.command.command,
            };
        });
    });
}

const ICONS = [
    // [analysisMode, targetType, icon id, colour]
    ['LivePanel', 'file', 'file', 'charts.green'],
    ['FileLivePanel', 'file', 'file', 'charts.green'],
    ['XR', 'file', 'file', 'charts.purple'],
    ['FileXRAnalysis', 'file', 'file', 'charts.purple'],
    ['VisualizeDOM', 'file', 'file', 'charts.orange'],
    ['FileVisualizeDOM', 'file', 'file', 'charts.orange'],
    ['DirectoryLivePanel', 'file', 'file', undefined],
    ['Unknown', 'file', 'file', undefined],
    [undefined, 'file', 'file', undefined],
    ['LivePanel', 'directory', 'folder', 'charts.green'],
    ['DirectoryLivePanel', 'directory', 'folder', 'charts.green'],
    ['DeepDirectoryLivePanel', 'directory', 'folder', 'charts.green'],
    ['XR', 'directory', 'folder', 'charts.purple'],
    ['DirectoryXRAnalysis', 'directory', 'folder', 'charts.purple'],
    ['DeepDirectoryXRAnalysis', 'directory', 'folder', 'charts.purple'],
    ['VisualizeDOM', 'directory', 'folder', 'charts.orange'],
    ['FileVisualizeDOM', 'directory', 'folder', undefined],
    ['FileLivePanel', 'directory', 'folder', undefined],
    ['Other', 'directory', 'folder', undefined],
    // Anything that is not 'directory' renders as a file.
    ['XR', undefined, 'file', 'charts.purple'],
    ['XR', 'weird', 'file', 'charts.purple'],
];

test('icon per analysis mode and target type', async () => {
    const sessions = ICONS.map(([analysisMode, targetType], index) => ({
        id: `s${index}`, analysisMode, targetType, status: 'monitoring', targetPath: `/t/${index}`,
    }));
    const items = await render(sessions);
    assert.deepEqual(items.map((item) => item.icon), ICONS.map(([, , id, color]) => [id, color]));
});

const LABELS = [
    ['LivePanel', 'Live Panel'],
    ['XR', 'XR Analysis'],
    ['VisualizeDOM', 'Visualize DOM'],
    ['FileLivePanel', 'Live Panel'],
    ['FileVisualizeDOM', 'Visualize DOM'],
    ['FileXRAnalysis', 'XR Analysis'],
    ['DirectoryLivePanel', 'Directory Live Panel'],
    ['DeepDirectoryLivePanel', 'Deep Directory Live Panel'],
    ['DirectoryXRAnalysis', 'Directory XR Analysis'],
    ['DeepDirectoryXRAnalysis', 'Deep Directory XR Analysis'],
    ['Custom', 'Custom'],
];
const STATUSES = [
    ['creating', 'Creating...'],
    ['analyzing', 'Analyzing...'],
    ['monitoring', 'Monitoring'],
    ['completed', 'Ready'],
    ['error', 'Error'],
    ['failed', 'Failed'],
    ['closing', 'Closing...'],
    ['paused', 'paused'],
];

test('description is "<mode label> - <status label>", contextValue follows the status', async () => {
    const sessions = [];
    for (const [mode] of LABELS) {
        for (const [status] of STATUSES) {
            sessions.push({ id: `${mode}-${status}`, analysisMode: mode, targetType: 'file', status, targetPath: '/x/a.py' });
        }
    }
    const items = await render(sessions);
    const expected = [];
    for (const [, modeLabel] of LABELS) {
        for (const [status, statusLabel] of STATUSES) {
            expected.push([`${modeLabel} - ${statusLabel}`, `activeAnalysis.${status}`]);
        }
    }
    assert.deepEqual(items.map((item) => [item.description, item.contextValue]), expected);
});

test('missing fields: unknown mode/status, label from the path, closed sessions and id-less sessions are skipped', async () => {
    const items = await render([
        { id: 'a', targetType: 'file', targetPath: path.join(path.sep, 'p', 'q', 'main.py') },
        { id: 'b', analysisMode: 'XR', targetType: 'directory', status: 'closed', targetPath: '/p' },
        { analysisMode: 'XR', targetType: 'file', status: 'monitoring' },
        null,
        { id: 'c', analysisMode: 'XR', targetType: 'file', status: 'monitoring', targetName: 'Named' },
    ]);
    assert.equal(items.length, 2);
    assert.equal(items[0].label, 'main.py');
    // An undefined mode becomes 'unknown' for analysisType but stays undefined for the label lookup.
    assert.equal(items[0].description, 'undefined - unknown');
    assert.equal(items[0].analysisType, 'unknown');
    assert.equal(items[0].status, 'unknown');
    assert.equal(items[0].contextValue, 'activeAnalysis.unknown');
    assert.equal(items[1].label, 'Named');
    assert.equal(items[1].targetPath, undefined);
    assert.equal(items[1].resource, undefined);
});

test('resourceUri is the normalized, trimmed target path; blank and non-string paths get none', async () => {
    const target = path.join(path.sep, 'repo', 'src', '..', 'lib', 'x.ts');
    const items = await render([
        { id: 'a', analysisMode: 'XR', targetType: 'file', status: 'monitoring', targetPath: `  ${target}  ` },
        { id: 'b', analysisMode: 'XR', targetType: 'file', status: 'monitoring', targetPath: '   ' },
        { id: 'c', analysisMode: 'XR', targetType: 'file', status: 'monitoring', targetPath: 42, targetName: 'n' },
        { id: 'd', analysisMode: 'XR', targetType: 'file', status: 'monitoring', targetPath: '' },
        // Without a targetName, path.basename(42) throws and the session is left out of the tree.
        { id: 'e', analysisMode: 'XR', targetType: 'file', status: 'monitoring', targetPath: 42 },
    ]);
    assert.equal(items.length, 4);
    assert.equal(items[0].resource, path.resolve(path.normalize(target.trim())));
    // The untrimmed path is what the item carries for the commands.
    assert.equal(items[0].targetPath, `  ${target}  `);
    assert.equal(items[1].resource, undefined);
    assert.equal(items[1].targetPath, '   ');
    assert.equal(items[2].resource, undefined);
    assert.equal(items[3].resource, undefined);
    assert.equal(items[3].targetPath, undefined);
});

test('session fields reach the TreeItem for the context-menu commands', async () => {
    const [item] = await render([{
        id: 'x1', analysisMode: 'LivePanel', targetType: 'directory', status: 'completed',
        targetPath: '/d', serverUrl: 'http://localhost:3000', assignedPort: 3000,
    }]);
    assert.deepEqual(item, {
        label: 'd',
        description: 'Live Panel - Ready',
        contextValue: 'activeAnalysis.completed',
        icon: ['folder', 'charts.green'],
        resource: path.resolve('/d'),
        sessionId: 'x1',
        analysisType: 'LivePanel',
        status: 'completed',
        targetPath: '/d',
        serverUrl: 'http://localhost:3000',
        assignedPort: 3000,
        command: 'codeXR.analysis.activeAnalyses.showActions',
    });
});
