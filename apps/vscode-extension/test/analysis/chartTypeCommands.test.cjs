/**
 * Behavioural characterization of the two chart-type commands
 * (code_analysis/commands/subsections/analysis_settings/chart_type_file|
 * chart_type_directory), written before ROADMAP T45 built both from one
 * factory. Their error toasts speak two dialects (the file one interpolates
 * the error itself, the directory one its message) and both are kept
 * verbatim, so they are pinned here side by side.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

const BASE = 'code_analysis/commands/subsections/analysis_settings';
const CASES = [
    {
        module: `${BASE}/chart_type_file/chartTypeFileCommands.js`,
        className: 'ChartTypeFileCommands',
        commandId: 'codeXR.analysis.selectChartTypeFile',
        description: 'Select chart type for file analysis visualization',
        errorToast: 'Failed to select chart type: Error: boom',
        nonErrorToast: 'Failed to select chart type: plain failure',
    },
    {
        module: `${BASE}/chart_type_directory/chartTypeDirectoryCommands.js`,
        className: 'ChartTypeDirectoryCommands',
        commandId: 'codeXR.analysis.selectChartTypeDirectory',
        description: 'Select chart type for directory analysis visualization',
        errorToast: 'Failed to select chart type: boom',
        nonErrorToast: 'Failed to select chart type: plain failure',
    },
];

for (const entry of CASES) {
    test(`${entry.className}: one registration that opens the selection and then refreshes, even after a failure`, async () => {
        const fake = createFakeVscode();
        const context = fakeExtensionContext();
        try {
            await withFakeVscode(fake, async ({ requireOut }) => {
                const Commands = requireOut(entry.module)[entry.className];
                const events = [];
                const setting = {
                    failure: null,
                    async showChartTypeSelection() {
                        events.push('select');
                        if (this.failure) {
                            throw this.failure;
                        }
                    },
                };
                const registrations = Commands.getCommandRegistrations(context, setting, () => events.push('refresh'));
                assert.equal(registrations.length, 1);
                const [registration] = registrations;
                assert.deepEqual(Object.keys(registration), ['commandId', 'callback', 'description']);
                assert.equal(registration.commandId, entry.commandId);
                assert.equal(registration.description, entry.description);

                assert.equal(await registration.callback(), undefined);
                assert.deepEqual(events, ['select', 'refresh']);
                assert.deepEqual(fake.messages, []);

                setting.failure = new Error('boom');
                await registration.callback();
                setting.failure = 'plain failure';
                await registration.callback();
                assert.deepEqual(events, ['select', 'refresh', 'select', 'refresh', 'select', 'refresh']);
                assert.deepEqual(fake.messages, [
                    { kind: 'error', message: entry.errorToast, items: [] },
                    { kind: 'error', message: entry.nonErrorToast, items: [] },
                ]);
            });
        } finally {
            context.cleanup();
        }
    });
}
