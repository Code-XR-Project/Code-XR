'use strict';

/**
 * Characterization of the sidebar tree built by ModularTreeDataProvider.
 *
 * Two snapshots, both compared with a committed golden file
 * (modularTreeSnapshot.golden.json):
 *
 *  1. `tree`: the real tree, walked from the root through every expandable
 *     item (fresh storage, no workspace, no running server), executed from
 *     out/ under the fake vscode. Every item is recorded with ALL its own
 *     properties (label, collapsibleState, sectionType, itemType, command,
 *     iconPath, tooltip, description, contextValue and every bridge property)
 *     plus the class and properties of the section item that
 *     `convertToSectionItem` rebuilds from it, which is what the section
 *     provider receives when the item is expanded and what a context-menu
 *     command receives as its argument.
 *
 *  2. `transcription`: the bridge itself, fed a synthetic child for every
 *     (section, discriminator) pair, so rows the default tree never shows
 *     (running servers, participants, analysis files) are pinned too: which
 *     discriminator wins the itemType chain, which payload properties are
 *     copied, the label / collapsibleState coercions, and the per-section
 *     defaults of the rebuilt item.
 *
 * Regenerate (only for an intended change, and say so in the commit):
 *   CODEXR_WRITE_TREE_SNAPSHOT=1 node --test --test-isolation=none test/views/modularTreeSnapshot.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const { createFakeVscode, withFakeVscode, fakeExtensionContext, TreeItemCollapsibleState } = require('../helpers/fakeVscode.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const goldenPath = path.join(__dirname, 'modularTreeSnapshot.golden.json');

const SECTION_NAMES = [
    'SERVERS',
    'activeServers',
    'babiaExamples',
    'visualizeData',
    'analysis',
    'pythonEnv',
    'visualizationSettings',
    'learnMore',
];

// Every discriminator the bridge knows, each with the payload properties a
// section provider may attach next to it.
const DISCRIMINATORS = [
    { key: 'serverItemType', payloads: [] },
    { key: 'activeServerItemType', payloads: ['activeServer', 'participant'] },
    { key: 'babiaItemType', payloads: ['babiaExample'] },
    { key: 'visualizeDataItemType', payloads: ['visualizeDataItem'] },
    { key: 'analysisItemType', payloads: ['originalAnalysisItem'] },
    { key: 'pythonEnvItemType', payloads: [] },
    { key: 'visualizationSettingsItemType', payloads: ['originalSettingsItem'] },
    { key: 'learnMoreItemType', payloads: ['originalLearnMoreItem'] },
];

const VOLATILE_KEYS = new Set(['lastModified']);

function createNormalizer(roots) {
    const replacements = [];
    for (const [root, token] of roots) {
        const variants = new Set([root]);
        try {
            variants.add(fs.realpathSync.native(root));
        } catch {
            // The storage root is gone after cleanup; the recorded form is enough.
        }
        for (const variant of [...variants]) {
            variants.add(url.pathToFileURL(variant).pathname);
            variants.add(variant.split(path.sep).join('/'));
        }
        for (const variant of variants) {
            replacements.push([variant, token]);
        }
    }
    replacements.sort((left, right) => right[0].length - left[0].length);

    const normalizeString = (value) => {
        let result = value;
        for (const [from, to] of replacements) {
            result = result.split(from).join(to);
        }
        return result.replace(/\\/g, '/');
    };

    const describe = (value, seen = new WeakSet()) => {
        if (value === undefined) {
            return '<undefined>';
        }
        if (value === null || typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'string') {
            return normalizeString(value);
        }
        if (typeof value === 'function') {
            return '<function>';
        }
        if (typeof value !== 'object') {
            return String(value);
        }
        if (seen.has(value)) {
            return '<circular>';
        }
        seen.add(value);
        if (Array.isArray(value)) {
            const items = value.map((entry) => describe(entry, seen));
            seen.delete(value);
            return items;
        }
        const described = {};
        const className = value.constructor && value.constructor.name;
        if (className && className !== 'Object') {
            described.$class = className;
        }
        for (const key of Object.keys(value).sort()) {
            described[key] = VOLATILE_KEYS.has(key) ? '<volatile>' : describe(value[key], seen);
        }
        seen.delete(value);
        return described;
    };

    return describe;
}

function silenceConsole() {
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const original = methods.map((method) => console[method]);
    for (const method of methods) {
        console[method] = () => {};
    }
    return () => methods.forEach((method, index) => {
        console[method] = original[index];
    });
}

function buildTranscriptionCases() {
    const cases = [];
    const common = {
        command: { command: 'codexr.test.command', title: 'Test command', arguments: ['argument'] },
        iconPath: { id: 'test-icon' },
        tooltip: 'Test tooltip',
        description: 'Test description',
        contextValue: 'test.context',
    };

    for (const sectionName of SECTION_NAMES) {
        for (const discriminator of DISCRIMINATORS) {
            const child = {
                label: `${discriminator.key} row`,
                collapsibleState: TreeItemCollapsibleState.Expanded,
                ...common,
                [discriminator.key]: `${discriminator.key}-value`,
                type: 'type-value',
            };
            for (const payload of discriminator.payloads) {
                child[payload] = { payload, owner: discriminator.key };
            }
            cases.push({ name: `${sectionName}/${discriminator.key}`, sectionName, child });
        }

        cases.push({
            name: `${sectionName}/type-only`,
            sectionName,
            child: { label: { label: 'Object label' }, type: 'type-value', ...common },
            elementType: 'type-on-element',
        });
        cases.push({
            name: `${sectionName}/bare`,
            sectionName,
            child: {},
        });
        // Falsy discriminators fall through the chain, payloads are dropped.
        cases.push({
            name: `${sectionName}/falsy-discriminators`,
            sectionName,
            child: {
                label: '',
                collapsibleState: TreeItemCollapsibleState.None,
                ...Object.fromEntries(DISCRIMINATORS.map((entry) => [entry.key, ''])),
                activeServer: { payload: 'activeServer' },
                participant: { payload: 'participant' },
                babiaExample: { payload: 'babiaExample' },
                originalAnalysisItem: { payload: 'originalAnalysisItem' },
            },
        });
    }

    cases.push({ name: 'unknownSection/serverItemType', sectionName: 'unknownSection', child: { label: 'x', serverItemType: 'config-option' } });
    return cases;
}

async function captureSnapshot() {
    const fake = createFakeVscode();
    const context = fakeExtensionContext();
    const restoreConsole = silenceConsole();
    const tree = [];
    const transcription = [];

    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            // extension.ts initializes the server settings singleton before the tree.
            requireOut('core/server/serverSettingsManager.js').ServerSettingsManager.getInstance(context);
            const { ModularTreeDataProvider } = requireOut('views/ModularTreeDataProvider.js');
            const provider = new ModularTreeDataProvider(context);

            try {
                const walk = async (element, pathLabels) => {
                    const children = await provider.getChildren(element);
                    for (const child of children) {
                        const label = typeof child.label === 'string' ? child.label : child.label && child.label.label;
                        const itemPath = [...pathLabels, label];
                        const sectionItem = child.itemType === 'section' ? undefined : provider.convertToSectionItem(child);
                        tree.push({ path: itemPath.join(' > '), item: child, sectionItem: sectionItem === undefined ? null : sectionItem });
                        if (child.collapsibleState !== TreeItemCollapsibleState.None && itemPath.length < 6) {
                            await walk(child, itemPath);
                        }
                    }
                };
                await walk(undefined, []);

                for (const entry of buildTranscriptionCases()) {
                    const modularItem = provider.createModularChild(entry.sectionName, entry.child);
                    if (entry.elementType) {
                        modularItem.type = entry.elementType;
                    }
                    const sectionItem = provider.convertToSectionItem(modularItem);
                    transcription.push({
                        case: entry.name,
                        modularItem,
                        sectionItem: sectionItem === modularItem ? '<same element>' : sectionItem,
                    });
                }
            } finally {
                provider.dispose();
            }
        });
    } finally {
        restoreConsole();
    }

    const describe = createNormalizer([
        [projectRoot, '<extension>'],
        [context.globalStoragePath, '<globalStorage>'],
        [context.storagePath, '<workspaceStorage>'],
    ]);
    const snapshot = { tree: describe(tree), transcription: describe(transcription) };
    context.cleanup();
    return snapshot;
}

test('the sidebar tree and the section-item bridge match the committed snapshot', async () => {
    const snapshot = await captureSnapshot();
    // One item per line keeps the golden reviewable in a diff.
    const serialized = [
        '{"tree": [',
        snapshot.tree.map((entry) => JSON.stringify(entry)).join(',\n'),
        '], "transcription": [',
        snapshot.transcription.map((entry) => JSON.stringify(entry)).join(',\n'),
        ']}',
        '',
    ].join('\n');

    if (process.env.CODEXR_WRITE_TREE_SNAPSHOT === '1') {
        fs.writeFileSync(goldenPath, serialized);
    }

    // Sanity: the walk reached every section and the bridge rebuilt every kind of item.
    const roots = snapshot.tree.filter((entry) => !entry.path.includes(' > ')).map((entry) => entry.item.sectionType);
    assert.deepEqual(roots, SECTION_NAMES);
    const rebuiltClasses = new Set(snapshot.tree.map((entry) => entry.sectionItem && entry.sectionItem.$class).filter(Boolean));
    assert.ok(rebuiltClasses.size >= 7, `expected the tree to rebuild most item classes, got ${[...rebuiltClasses].join(', ')}`);

    const golden = fs.readFileSync(goldenPath, 'utf8').replace(/\r\n/g, '\n');
    assert.deepEqual(JSON.parse(serialized), JSON.parse(golden));
});
