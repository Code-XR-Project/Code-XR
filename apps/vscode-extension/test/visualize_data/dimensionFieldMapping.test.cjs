const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, fakeExtensionContext, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

// Characterization of VisualizationLauncher.handleDimensionFieldMapping
// (ROADMAP W4-T18, hotspots-ts/CPLX-21): the quick-pick items it offers
// (with the "already used in another dimension" marks), the duplicate
// confirmation, what it maps, and every early exit. Runs the real launcher
// from out/ under the fake vscode, with a stub state manager.

const FIELDS = [
    { name: 'lines', type: 'number', isNumeric: true, sampleValues: [1, 2, 3, 4], valueCount: 4 },
    { name: 'name', type: 'string', isNumeric: false, sampleValues: [], valueCount: 2 },
    { name: 'size', type: 'number', isNumeric: true, sampleValues: [7], valueCount: 1 },
];

const CHART = {
    id: 'bars',
    name: 'Bars',
    dimensions: [
        { name: 'height', label: 'Height', required: true, dataType: 'numeric' },
        { name: 'x', label: 'X', required: true, dataType: 'any' },
        { name: 'label', label: 'Label', required: false, dataType: 'text' },
    ],
};

async function map(dimensionName, { state, pick, confirm }) {
    const log = [];
    const fake = createFakeVscode({
        overrides: {
            window: {
                showQuickPick: async (items, options) => {
                    log.push(['pick', items.map((item) => [item.label, item.description, item.detail]), options]);
                    return pick ? items.find((item) => item.field.name === pick) : undefined;
                },
                showWarningMessage: async (message, ...actions) => {
                    log.push(['warn', message, ...actions]);
                    return confirm;
                },
                showErrorMessage: async (message) => { log.push(['error', message]); },
                showInformationMessage: async (message) => { log.push(['info', message]); },
            },
            commands: { executeCommand: async (id) => { log.push(['command', id]); } },
        },
    });
    const context = fakeExtensionContext();
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            const { VisualizationLauncher } = requireOut('visualize_data/views/interactions/visualizationLauncher.js');
            const launcher = Object.create(VisualizationLauncher.prototype);
            launcher.context = context;
            launcher.stateManager = {
                getState: () => state,
                updateSingleDimensionMapping: (dimension, field) => log.push(['mapped', dimension, field]),
            };
            await launcher.handleDimensionFieldMapping(dimensionName);
        });
    } finally {
        context.cleanup();
    }
    return log;
}

const ready = (dimensionMappings = []) => ({
    selectedChart: CHART,
    jsonAnalysis: { success: true, fields: FIELDS },
    dimensionMappings,
});

test('offers the fields of the dimension type, marking those used by another dimension only', async () => {
    const log = await map('x', { state: ready([{ dimension: 'height', dataField: 'lines' }, { dimension: 'x', dataField: 'name' }]) });
    assert.deepEqual(log, [[
        'pick',
        [
            ['lines (warning)', 'number (numeric) (already used in another dimension)', '4 values • Samples: 1, 2, 3'],
            // used by this very dimension: no mark
            ['name', 'string', '2 values'],
            ['size', 'number (numeric)', '1 values • Samples: 7'],
        ],
        { placeHolder: 'Select field for x (any value)', title: 'Map Dimension: x', matchOnDescription: true, matchOnDetail: true },
    ]]);
});

test('a numeric dimension only offers numeric fields', async () => {
    const log = await map('height', { state: ready() });
    assert.deepEqual(log[0][1].map(([label]) => label), ['lines', 'size']);
    assert.equal(log[0][2].placeHolder, 'Select field for height (numeric only)');
});

test('picking a free field maps it, refreshes the tree and confirms', async () => {
    const log = await map('height', { state: ready([{ dimension: 'x', dataField: 'name' }]), pick: 'size' });
    assert.deepEqual(log.slice(1), [
        ['mapped', 'height', 'size'],
        ['command', 'codexr.servers.refresh'],
        ['info', 'Mapped height to field: size'],
    ]);
});

test('picking a field used elsewhere asks first, naming the first dimension that uses it', async () => {
    const state = ready([{ dimension: 'label', dataField: 'lines' }, { dimension: 'x', dataField: 'lines' }]);
    const accepted = await map('height', { state, pick: 'lines', confirm: 'Yes, Continue' });
    assert.deepEqual(accepted.slice(1), [
        ['warn', "Field 'lines' is already used for dimension 'label'. Continue?", 'Yes, Continue', 'Cancel'],
        ['mapped', 'height', 'lines'],
        ['command', 'codexr.servers.refresh'],
        ['info', 'Mapped height to field: lines'],
    ]);
    for (const confirm of ['Cancel', undefined]) {
        const declined = await map('height', { state, pick: 'lines', confirm });
        assert.deepEqual(declined.slice(1), [['warn', "Field 'lines' is already used for dimension 'label'. Continue?", 'Yes, Continue', 'Cancel']]);
    }
    // re-picking the field this dimension already has is not a duplicate
    const same = await map('x', { state: ready([{ dimension: 'x', dataField: 'lines' }]), pick: 'lines' });
    assert.deepEqual(same.slice(1).map(([kind]) => kind), ['mapped', 'command', 'info']);
});

test('early exits: nothing selected, unknown dimension, no fields, dismissed pick', async () => {
    assert.deepEqual(await map('x', { state: { ...ready(), selectedChart: undefined } }), [['warn', 'Please select a chart type and JSON file first']]);
    assert.deepEqual(await map('x', { state: { ...ready(), jsonAnalysis: undefined } }), [['warn', 'Please select a chart type and JSON file first']]);
    assert.deepEqual(await map('depth', { state: ready() }), [['error', "Dimension 'depth' not found in chart"]]);
    assert.deepEqual(
        await map('height', { state: { ...ready(), jsonAnalysis: { success: true, fields: [FIELDS[1]] } } }),
        [['warn', "No numeric fields available for dimension 'height'"]],
    );
    assert.deepEqual(await map('x', { state: { ...ready(), jsonAnalysis: { success: false, fields: FIELDS } } }), [['warn', "No fields available for dimension 'x'"]]);
    const dismissed = await map('x', { state: ready() });
    assert.equal(dismissed.length, 1);
});

test('a failure inside is reported, not thrown', async () => {
    const log = await map('x', { state: { ...ready(), dimensionMappings: null } });
    assert.equal(log.length, 1);
    assert.equal(log[0][0], 'error');
    assert.match(log[0][1], /^Failed to map dimension field: Cannot read properties of null/);
});
