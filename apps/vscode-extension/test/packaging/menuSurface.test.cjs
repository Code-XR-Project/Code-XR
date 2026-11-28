const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The menu surface of package.json as a reviewed table, plus the rules every
// entry follows. test/baseline/ snapshots the same entries mechanically; this
// file states the intent, so a change here is a decision, not a refresh.
const projectRoot = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const { commands, menus, submenus } = manifest.contributes;

const UI_LOCK_GUARD = '!codeXR.pythonEnv.uiLocked';
const SUBMENU = 'codeXR.analysis.contextMenu';
const REVEAL_IN_SCENE = 'codeXR.analysis.revealInScene';
const ANALYZE_IN_SCENE = 'codeXR.analysis.analyzeInScene';

const RUN_LAST_FILE = ['analyzeFile', 'analyzeFileXR'];
const RUN_LAST_DIRECTORY = ['analyzeDirectory', 'analyzeDirectoryDeep', 'analyzeDirectoryXR', 'analyzeDirectoryXRDeep'];
const RUN_LAST_PROJECT = ['analyzeProject', 'analyzeProjectDeep', 'analyzeProjectXR', 'analyzeProjectXRDeep'];
const runLast = (kinds) => kinds.map((kind) => `codeXR.analysis.runLast.${kind}`);

/** Each menu location, in display order: `command` or `submenu:<id>`. */
const MENU_SURFACE = {
    'view/title': [
        'codeXR.activeServers.refreshServers',
        'codeXR.activeServers.stopAllServers',
    ],
    'explorer/context': [
        ...runLast([...RUN_LAST_FILE, ...RUN_LAST_DIRECTORY, ...RUN_LAST_PROJECT, 'visualizeDOM']),
        // #339 and #178: on a file or folder (reveal: files only), while an analysis server runs.
        ANALYZE_IN_SCENE,
        REVEAL_IN_SCENE,
        `submenu:${SUBMENU}`,
    ],
    // The editor has no folder under the cursor: no directory entries.
    'editor/context': [
        ...runLast([...RUN_LAST_FILE, ...RUN_LAST_PROJECT, 'visualizeDOM']),
        ANALYZE_IN_SCENE,
        REVEAL_IN_SCENE,
        `submenu:${SUBMENU}`,
    ],
    // #178: the editor tab's own menu.
    'editor/title/context': [REVEAL_IN_SCENE],
    'view/item/context': [
        'codeXR.analysis.activeAnalyses.showDetails',
        'codeXR.analysis.activeAnalyses.viewInBrowser',
        'codeXR.analysis.activeAnalyses.exportFolder',
        'codeXR.analysis.activeAnalyses.close',
        'codeXR.activeServers.removeParticipant',
    ],
    [SUBMENU]: [
        ...[...RUN_LAST_FILE, ...RUN_LAST_DIRECTORY, ...RUN_LAST_PROJECT, 'visualizeDOM']
            .map((kind) => `codeXR.analysis.${kind}`),
    ],
    // Hidden from the palette: the run-last shortcuts need a resource, and
    // debugFailInstallation deletes the user's venv (ROADMAP section B).
    commandPalette: [
        ...runLast([...RUN_LAST_FILE, ...RUN_LAST_DIRECTORY, ...RUN_LAST_PROJECT, 'visualizeDOM']),
        'codeXR.pythonEnv.debugFailInstallation',
    ],
};

// Only these groups draw a command's icon; everywhere else (context menus, the
// palette, tree-item clicks) the icon is never rendered.
const isRenderingGroup = (group) => /^navigation(@|$)/.test(group || '') || /^inline(@|$)/.test(group || '');

// Commands that carry an icon no menu renders (MENU-02: inert, 53 at the
// audit). Seeded so the rule can land without touching the manifest; the list
// may only shrink. Removing an icon here is a manifest-only cleanup.
const INERT_ICON_EXEMPTIONS = [
    'codeXR.activeServers.copyRemoteInvitation',
    'codeXR.activeServers.copyUrl',
    'codeXR.activeServers.openInBrowser',
    'codeXR.activeServers.openInPanel',
    'codeXR.activeServers.removeParticipant',
    'codeXR.activeServers.showActions',
    'codeXR.activeServers.showDetails',
    'codeXR.activeServers.startRemoteAccess',
    'codeXR.activeServers.stopRemoteAccess',
    'codeXR.activeServers.stopServer',
    'codeXR.analysis.activeAnalyses.close',
    'codeXR.analysis.activeAnalyses.exportFolder',
    'codeXR.analysis.activeAnalyses.refresh',
    'codeXR.analysis.activeAnalyses.showActions',
    'codeXR.analysis.activeAnalyses.showDetails',
    'codeXR.analysis.activeAnalyses.viewInBrowser',
    'codeXR.analysis.analyzeDirectory',
    'codeXR.analysis.analyzeDirectoryDeep',
    'codeXR.analysis.analyzeDirectoryXR',
    'codeXR.analysis.analyzeDirectoryXRDeep',
    'codeXR.analysis.analyzeFile',
    'codeXR.analysis.analyzeFileXR',
    'codeXR.analysis.analyzeProject',
    'codeXR.analysis.analyzeProjectDeep',
    'codeXR.analysis.analyzeProjectXR',
    'codeXR.analysis.analyzeProjectXRDeep',
    'codeXR.analysis.runLast.analyzeDirectory',
    'codeXR.analysis.runLast.analyzeDirectoryDeep',
    'codeXR.analysis.runLast.analyzeDirectoryXR',
    'codeXR.analysis.runLast.analyzeDirectoryXRDeep',
    'codeXR.analysis.runLast.analyzeFile',
    'codeXR.analysis.runLast.analyzeFileXR',
    'codeXR.analysis.runLast.analyzeProject',
    'codeXR.analysis.runLast.analyzeProjectDeep',
    'codeXR.analysis.runLast.analyzeProjectXR',
    'codeXR.analysis.runLast.analyzeProjectXRDeep',
    'codeXR.analysis.runLast.visualizeDOM',
    'codeXR.analysis.visualizeDOM',
    'codeXR.babiaExamples.launchExample',
    'codeXR.babiaExamples.openFolder',
    'codeXR.babiaExamples.refresh',
    'codeXR.babiaExamples.showDetails',
    'codeXR.babiaExamples.showLibraryInfo',
    'codeXR.pythonEnv.create',
    'codeXR.pythonEnv.debugFailInstallation',
    'codeXR.pythonEnv.delete',
    'codeXR.pythonEnv.reinitialize',
    'codeXR.pythonEnv.status',
    'codeXR.pythonEnv.verifyInstallation',
    'codeXR.visualizeData.chartType',
    'codeXR.visualizeData.dimensionMapping',
    'codeXR.visualizeData.launchVisualization',
    'codeXR.visualizeData.selectJson',
];

const entryTarget = (entry) => entry.command || `submenu:${entry.submenu}`;
// VS Code's display order: the navigation group first, then groups by name,
// then the @order inside a group.
function displayOrder(a, b) {
    const [groupA, orderA] = (a.group || '').split('@');
    const [groupB, orderB] = (b.group || '').split('@');
    if (groupA !== groupB) {
        if (groupA === 'navigation' || groupB === 'navigation') {
            return groupA === 'navigation' ? -1 : 1;
        }
        return groupA < groupB ? -1 : 1;
    }
    return Number(orderA) - Number(orderB);
}

test('the menu surface matches the reviewed table, location by location, in display order', () => {
    assert.deepEqual(Object.keys(menus).sort(), Object.keys(MENU_SURFACE).sort());

    for (const [location, expected] of Object.entries(MENU_SURFACE)) {
        const entries = menus[location];
        const ordered = location === 'commandPalette'
            ? entries
            : [...entries].sort(displayOrder);
        assert.deepEqual(ordered.map(entryTarget), expected, location);
    }
});

test('every menu entry outside the palette is hidden while the Python environment locks the UI', () => {
    for (const [location, entries] of Object.entries(menus)) {
        if (location === 'commandPalette') {
            continue;
        }
        for (const entry of entries) {
            assert.ok((entry.when || '').includes(UI_LOCK_GUARD), `${location} ${entryTarget(entry)} carries ${UI_LOCK_GUARD}`);
        }
    }
});

test('view menus are scoped to the Code-XR tree, and orders are unique within a group', () => {
    for (const location of ['view/title', 'view/item/context']) {
        for (const entry of menus[location]) {
            assert.match(entry.when, /(^|&& )view == codexrTree( &&|$)/, `${location} ${entryTarget(entry)}`);
        }
    }

    for (const [location, entries] of Object.entries(menus)) {
        const seen = new Set();
        for (const entry of entries.filter((item) => item.group)) {
            assert.ok(!seen.has(entry.group), `${location}: group ${entry.group} is used twice`);
            seen.add(entry.group);
        }
    }
});

test('palette-hidden entries are exactly `when: false`, and the submenu is declared', () => {
    for (const entry of menus.commandPalette) {
        assert.equal(entry.when, 'false', `${entry.command} is hidden, not conditionally shown`);
    }
    assert.deepEqual(submenus.map((submenu) => submenu.id), [SUBMENU]);
});

test('a command carries an icon if and only if a menu renders it (inert icons are seeded exemptions)', () => {
    const rendered = new Set();
    for (const entries of Object.values(menus)) {
        for (const entry of entries) {
            if (entry.command && isRenderingGroup(entry.group)) {
                rendered.add(entry.command);
            }
        }
    }
    const withIcon = commands.filter((command) => command.icon).map((command) => command.command);

    assert.deepEqual([...rendered].filter((id) => !withIcon.includes(id)), [], 'a rendered command without an icon shows an empty button');
    assert.ok(rendered.size > 0, 'canary: some menu renders icons');

    const inert = withIcon.filter((id) => !rendered.has(id)).sort();
    assert.deepEqual(
        inert.filter((id) => !INERT_ICON_EXEMPTIONS.includes(id)),
        [],
        'a new icon on a command no menu renders is dead weight: put the command in a navigation/inline group or drop the icon',
    );
    assert.deepEqual(
        INERT_ICON_EXEMPTIONS.filter((id) => !inert.includes(id)),
        [],
        'an exemption that no longer applies must leave INERT_ICON_EXEMPTIONS (the list only shrinks)',
    );
});
