/**
 * Behavioural characterization of the Load Profile and Delete Profile
 * commands (src/code_analysis/commands/subsections/analysis_settings/
 * profile_configuration/profileConfigurationCommands.ts), written before
 * ROADMAP T37 folded their byte-identical profile-listing block into one
 * helper. No test exercised the file before this suite.
 *
 * It runs the compiled commands from out/ under the fake vscode, with a
 * temporary globalStorage directory and AnalysisConfigurationStorage
 * replaced by a recorder. Listing order is whatever readdir returns, so
 * items are compared after sorting by label (platform-agnostic).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

const COMMANDS_MODULE = 'code_analysis/commands/subsections/analysis_settings/profile_configuration/profileConfigurationCommands.js';
const STORAGE_MODULE = 'code_analysis/configuration/analysisConfigurationStorage.js';

async function withProfileCommands(body) {
    const fake = createFakeVscode();
    const context = fakeExtensionContext();
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            const { AnalysisConfigurationStorage } = requireOut(STORAGE_MODULE);
            const updates = [];
            const originalGetInstance = AnalysisConfigurationStorage.getInstance;
            AnalysisConfigurationStorage.getInstance = () => ({
                async updateConfiguration(configuration) {
                    updates.push(configuration);
                },
                async loadConfiguration() {
                    return { chartType: 'boats' };
                },
            });
            try {
                const { ProfileConfigurationCommands } = requireOut(COMMANDS_MODULE);
                let refreshes = 0;
                const registrations = ProfileConfigurationCommands.getCommandRegistrations(context, {}, () => {
                    refreshes += 1;
                });
                const run = async (commandId) => {
                    const registration = registrations.find((entry) => entry.commandId === commandId);
                    assert.ok(registration, commandId);
                    await registration.callback();
                };
                const profilesDir = path.join(context.globalStorageUri.fsPath, 'analysis_settings');
                await body({ fake, run, profilesDir, updates, refreshes: () => refreshes });
            } finally {
                AnalysisConfigurationStorage.getInstance = originalGetInstance;
            }
        });
    } finally {
        context.cleanup();
    }
}

function writeProfiles(profilesDir) {
    fs.mkdirSync(profilesDir, { recursive: true });
    const savedAt = '2026-01-02T03:04:05.000Z';
    fs.writeFileSync(path.join(profilesDir, 'Alpha.json'), JSON.stringify({
        name: 'Alpha',
        savedAt,
        version: '1.0',
        configuration: { chartType: 'bars' },
    }));
    fs.writeFileSync(path.join(profilesDir, 'nameless.json'), JSON.stringify({ savedAt, configuration: {} }));
    fs.writeFileSync(path.join(profilesDir, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(profilesDir, 'notes.txt'), 'ignored');
    return {
        alpha: {
            label: 'Alpha',
            description: `Saved: ${new Date(savedAt).toLocaleString()}`,
            detail: 'Version: 1.0',
            profilePath: path.join(profilesDir, 'Alpha.json'),
        },
        nameless: {
            label: 'nameless',
            description: `Saved: ${new Date(savedAt).toLocaleString()}`,
            detail: 'Version: Unknown',
            profilePath: path.join(profilesDir, 'nameless.json'),
        },
        broken: {
            label: 'broken',
            description: 'Invalid profile data',
            detail: 'This profile may be corrupted',
            profilePath: path.join(profilesDir, 'broken.json'),
        },
    };
}

const byLabel = (left, right) => left.label.localeCompare(right.label);

for (const [commandId, noun] of [['codeXR.analysis.loadProfile', 'load'], ['codeXR.analysis.deleteProfile', 'delete']]) {
    test(`${noun} profile: no directory and an empty directory both report "No saved profiles found"`, async () => {
        await withProfileCommands(async ({ fake, run, profilesDir, refreshes }) => {
            await run(commandId);
            fs.mkdirSync(profilesDir, { recursive: true });
            fs.writeFileSync(path.join(profilesDir, 'readme.txt'), 'not a profile');
            await run(commandId);
            assert.deepEqual(fake.messages, [
                { kind: 'info', message: 'No saved profiles found', items: [] },
                { kind: 'info', message: 'No saved profiles found', items: [] },
            ]);
            assert.deepEqual(fake.dialogs, []);
            assert.equal(refreshes(), 2);
        });
    });

    test(`${noun} profile: the quick pick lists every .json, named, nameless and corrupt, and cancelling does nothing`, async () => {
        await withProfileCommands(async ({ fake, run, profilesDir, updates }) => {
            const expected = writeProfiles(profilesDir);
            await run(commandId);
            assert.equal(fake.dialogs.length, 1);
            const { items, options } = fake.dialogs[0].options;
            assert.deepEqual([...items].sort(byLabel), [expected.alpha, expected.broken, expected.nameless]);
            assert.deepEqual(options, noun === 'load'
                ? { placeHolder: 'Select a configuration profile to load', title: 'Load Configuration Profile' }
                : { placeHolder: 'Select a configuration profile to delete', title: 'Delete Configuration Profile' });
            assert.deepEqual(fake.messages, []);
            assert.deepEqual(updates, []);
            assert.equal(fs.readdirSync(profilesDir).length, 4);
        });
    });
}

test('load profile: picking and confirming replaces the configuration with the profile\'s', async () => {
    await withProfileCommands(async ({ fake, run, profilesDir, updates }) => {
        const expected = writeProfiles(profilesDir);
        fake.queueAnswer(expected.alpha);
        fake.queueAnswer('Cancel');
        await run('codeXR.analysis.loadProfile');
        assert.deepEqual(updates, []);

        fake.queueAnswer(expected.alpha);
        fake.queueAnswer('Load Profile');
        await run('codeXR.analysis.loadProfile');
        assert.deepEqual(updates, [{ chartType: 'bars' }]);
        assert.deepEqual(fake.messages, [
            {
                kind: 'warning',
                message: 'This will replace your current configuration with "Alpha". Are you sure?',
                items: ['Load Profile', 'Cancel'],
            },
            {
                kind: 'warning',
                message: 'This will replace your current configuration with "Alpha". Are you sure?',
                items: ['Load Profile', 'Cancel'],
            },
            { kind: 'info', message: 'Configuration profile "Alpha" loaded successfully', items: [] },
        ]);
    });
});

test('load profile: a corrupt profile picked and confirmed fails with an error toast', async () => {
    await withProfileCommands(async ({ fake, run, profilesDir, updates }) => {
        const expected = writeProfiles(profilesDir);
        fake.queueAnswer(expected.broken);
        fake.queueAnswer('Load Profile');
        await run('codeXR.analysis.loadProfile');
        assert.deepEqual(updates, []);
        assert.equal(fake.messages.length, 2);
        assert.equal(fake.messages[1].kind, 'error');
        assert.match(fake.messages[1].message, /^Failed to load profile: /);
    });
});

test('delete profile: picking and confirming removes the file; cancelling keeps it', async () => {
    await withProfileCommands(async ({ fake, run, profilesDir }) => {
        const expected = writeProfiles(profilesDir);
        fake.queueAnswer(expected.nameless);
        fake.queueAnswer('Cancel');
        await run('codeXR.analysis.deleteProfile');
        assert.equal(fs.existsSync(expected.nameless.profilePath), true);

        fake.queueAnswer(expected.nameless);
        fake.queueAnswer('Delete Profile');
        await run('codeXR.analysis.deleteProfile');
        assert.equal(fs.existsSync(expected.nameless.profilePath), false);
        assert.deepEqual(fake.messages, [
            {
                kind: 'warning',
                message: 'Are you sure you want to delete the profile "nameless"? This action cannot be undone.',
                items: ['Delete Profile', 'Cancel'],
            },
            {
                kind: 'warning',
                message: 'Are you sure you want to delete the profile "nameless"? This action cannot be undone.',
                items: ['Delete Profile', 'Cancel'],
            },
            { kind: 'info', message: 'Configuration profile "nameless" deleted successfully', items: [] },
        ]);
    });
});
