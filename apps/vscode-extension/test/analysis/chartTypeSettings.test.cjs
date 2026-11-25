'use strict';

/**
 * Behavioural characterization of the two chart-type settings
 * (ChartTypeFileSetting, ChartTypeDirectorySetting), executed from out/ under
 * the fake vscode with the real chart registry and a recording storage: the
 * tree item each builds, the charts each offers, the quick pick, what a pick
 * writes to storage, and the refusals. Console output is not pinned.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require('../helpers/fakeVscode.cjs');

const FILE = { module: 'code_analysis/views/subsections/analysis_settings/chart_type_file/chartTypeFile.js', className: 'ChartTypeFileSetting' };
const DIRECTORY = { module: 'code_analysis/views/subsections/analysis_settings/chart_type_directory/chartTypeDirectory.js', className: 'ChartTypeDirectorySetting' };

function silenceConsole() {
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const original = methods.map((method) => console[method]);
    methods.forEach((method) => {
        console[method] = () => {};
    });
    return () => methods.forEach((method, index) => {
        console[method] = original[index];
    });
}

/** A storage that records every call and answers getters from `values`. */
function recordingStorage(values) {
    const calls = [];
    const storage = new Proxy({}, {
        get(_target, name) {
            return async (...args) => {
                calls.push(args.length > 0 ? [name, ...args] : [name]);
                return values[name];
            };
        },
    });
    return { storage, calls };
}

async function withSetting(kind, values, body) {
    const fake = createFakeVscode();
    const context = fakeExtensionContext();
    const restoreConsole = silenceConsole();
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            const Setting = requireOut(kind.module)[kind.className];
            const { BabiaChartRegistry } = requireOut('core/charts/chartRegistry.js');
            const setting = new Setting(context);
            const { storage, calls } = recordingStorage(values);
            setting.storage = storage;
            await body({ setting, calls, fake, registry: BabiaChartRegistry.getInstance() });
        });
    } finally {
        restoreConsole();
        context.cleanup();
    }
}

function plainItem(item) {
    return {
        label: item.label,
        collapsibleState: item.collapsibleState,
        command: item.command,
        icon: { id: item.iconPath.id, color: item.iconPath.color.id },
        tooltip: item.tooltip,
        description: item.description,
        contextValue: item.contextValue,
    };
}

const FILE_VALUES = { getAnalysisMode: 'LivePanel', getChartTypeFile: 'boats', getDimensionMappingFile: { x: 'loc' } };
const DIRECTORY_VALUES = { getAnalysisDirectoryMode: 'XRDeep', getDirectoryChartType: 'boats' };

test('file: the tree item names the chart, always says "for XR mode", and reads the mode first', async () => {
    await withSetting(FILE, FILE_VALUES, async ({ setting, calls, registry }) => {
        const name = registry.getChart('boats').name;
        assert.deepEqual(plainItem(await setting.getSettingItem()), {
            label: `Chart Type (File): ${name}`,
            collapsibleState: 0,
            command: { command: 'codeXR.analysis.selectChartTypeFile', title: 'Select Chart Type for File Analysis', arguments: [] },
            icon: { id: 'graph', color: 'charts.purple' },
            tooltip: `Current chart type: ${name} for LivePanel mode. Click to change chart type.`,
            description: `${name} for XR mode`,
            contextValue: 'chartTypeFileSetting',
        });
        assert.deepEqual(calls, [['getAnalysisMode'], ['getChartTypeFile']]);
    });
    await withSetting(FILE, { ...FILE_VALUES, getChartTypeFile: 'nope' }, async ({ setting }) => {
        const item = await setting.getSettingItem();
        assert.equal(item.label, 'Chart Type (File): nope');
        assert.equal(item.description, 'nope for XR mode');
    });
});

test('directory: the tree item names the chart and the mode, and reads the chart first', async () => {
    await withSetting(DIRECTORY, DIRECTORY_VALUES, async ({ setting, calls, registry }) => {
        const name = registry.getChart('boats').name;
        assert.deepEqual(plainItem(await setting.getSettingItem()), {
            label: `Chart Type (Directory): ${name}`,
            collapsibleState: 0,
            command: { command: 'codeXR.analysis.selectChartTypeDirectory', title: 'Select Chart Type for Directory Analysis', arguments: [] },
            icon: { id: 'graph', color: 'charts.purple' },
            tooltip: `Current chart type: ${name} for XRDeep mode. Click to change chart type.`,
            description: 'XRDeep Mode',
            contextValue: 'chartTypeDirectorySetting',
        });
        assert.deepEqual(calls, [['getDirectoryChartType'], ['getAnalysisDirectoryMode']]);
    });
    await withSetting(DIRECTORY, { ...DIRECTORY_VALUES, getDirectoryChartType: 'nope' }, async ({ setting }) => {
        assert.equal((await setting.getSettingItem()).label, 'Chart Type (Directory): Unknown Chart');
    });
});

test('both offer every registered chart; the directory list is filtered by its mode list', async () => {
    await withSetting(FILE, FILE_VALUES, async ({ setting, registry }) => {
        const expected = registry.getAllCharts().map((chart) => ({
            id: chart.id, name: chart.name, description: chart.description, category: chart.category, supportsMode: ['XR', 'LivePanel'],
        }));
        assert.ok(expected.length > 0);
        assert.deepEqual(await setting.getAvailableChartTypes('XR'), expected);
        assert.deepEqual(await setting.getAvailableChartTypes('anything'), expected);
        assert.equal(await setting.getCurrentAnalysisMode(), 'LivePanel');
        assert.equal(await setting.getCurrentChartType(), 'boats');
    });
    await withSetting(DIRECTORY, DIRECTORY_VALUES, async ({ setting, registry }) => {
        const modes = ['XR', 'XRDeep', 'LivePanel', 'LivePanelDeep'];
        const expected = registry.getAllCharts().map((chart) => ({
            id: chart.id, name: chart.name, description: chart.description, category: chart.category, supportsMode: modes,
        }));
        for (const mode of modes) {
            assert.deepEqual(await setting.getAvailableChartTypes(mode), expected);
        }
        assert.deepEqual(await setting.getAvailableChartTypes('VisualizeDOM'), []);
        assert.equal(await setting.getCurrentChartType(), 'boats');
    });
});

test('file: setChartType validates, reads the old mappings, saves the chart, then clears the mappings', async () => {
    await withSetting(FILE, FILE_VALUES, async ({ setting, calls }) => {
        await setting.setChartType('bars');
        assert.deepEqual(calls, [['getDimensionMappingFile'], ['setChartTypeFile', 'bars'], ['setDimensionMappingFile', {}]]);
    });
    await withSetting(FILE, FILE_VALUES, async ({ setting, calls }) => {
        await assert.rejects(setting.setChartType('nope'), { message: 'Invalid chart type: nope' });
        assert.deepEqual(calls, []);
    });
});

test('directory: setChartType saves without validation, then clears the mappings', async () => {
    await withSetting(DIRECTORY, DIRECTORY_VALUES, async ({ setting, calls }) => {
        await setting.setChartType('nope');
        assert.deepEqual(calls, [['setDirectoryChartType', 'nope'], ['setDimensionMappingDirectory', {}]]);
    });
});

const PICKS = [
    {
        kind: FILE, values: FILE_VALUES, mode: 'LivePanel', supports: 'XR, LivePanel',
        placeHolder: 'Select a chart type for file analysis visualization',
        title: 'Chart Type Selection for LivePanel Analysis',
        writes: (id) => [['getDimensionMappingFile'], ['setChartTypeFile', id], ['setDimensionMappingFile', {}]],
        confirmation: (name) => `Chart type set to: ${name} for LivePanel mode`,
        modeRead: ['getAnalysisMode'],
    },
    {
        kind: DIRECTORY, values: DIRECTORY_VALUES, mode: 'XRDeep', supports: 'XR, XRDeep, LivePanel, LivePanelDeep',
        placeHolder: 'Select a chart type for directory analysis visualization',
        title: 'Chart Type Selection for XRDeep Directory Analysis',
        writes: (id) => [['setDirectoryChartType', id], ['setDimensionMappingDirectory', {}]],
        confirmation: (name) => `Chart type set to: ${name} for XRDeep directory analysis`,
        modeRead: ['getAnalysisDirectoryMode'],
    },
];

for (const pick of PICKS) {
    test(`${pick.kind.className}: the quick pick, a pick, a dismissal, an empty registry and a failing save`, async () => {
        await withSetting(pick.kind, pick.values, async ({ setting, calls, fake, registry }) => {
            const charts = registry.getAllCharts();
            const chosen = charts[1];
            fake.queueAnswer(undefined);
            await setting.showChartTypeSelection();
            assert.equal(fake.dialogs.length, 1);
            const { items, options } = fake.dialogs[0].options;
            assert.deepEqual(items.map(({ label, description, detail }) => ({ label, description, detail })), charts.map((chart) => ({
                label: chart.name, description: chart.description, detail: `Category: ${chart.category} | Supports: ${pick.supports}`,
            })));
            assert.deepEqual(options, { placeHolder: pick.placeHolder, title: pick.title, canPickMany: false });
            assert.deepEqual(calls, [pick.modeRead]);
            assert.deepEqual(fake.messages, []);

            calls.length = 0;
            fake.queueAnswer(items[1]);
            await setting.showChartTypeSelection();
            assert.deepEqual(calls, [pick.modeRead, ...pick.writes(chosen.id)]);
            assert.deepEqual(fake.messages, [{ kind: 'info', message: pick.confirmation(chosen.name), items: [] }]);
        });

        await withSetting(pick.kind, pick.values, async ({ setting, calls, fake }) => {
            setting.chartRegistry = { getAllCharts: () => [], getChart: () => undefined, hasChart: () => false };
            await setting.showChartTypeSelection();
            assert.deepEqual(fake.dialogs, []);
            assert.deepEqual(fake.messages, [{ kind: 'error', message: 'No chart templates available', items: [] }]);
            assert.deepEqual(calls, [pick.modeRead]);
        });

        await withSetting(pick.kind, pick.values, async ({ setting, fake }) => {
            setting.storage = new Proxy({}, {
                get: (_target, name) => async () => {
                    if (String(name).startsWith('set')) {
                        throw new Error('disk full');
                    }
                    return pick.values[name];
                },
            });
            fake.queueAnswer({ label: 'x', chart: { id: 'bars', name: 'Bars' } });
            await setting.showChartTypeSelection();
            assert.deepEqual(fake.messages, [{ kind: 'error', message: 'Failed to select chart type: disk full', items: [] }]);
        });
    });
}
