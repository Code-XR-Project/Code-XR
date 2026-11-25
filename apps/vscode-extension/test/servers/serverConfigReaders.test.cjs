/**
 * Behavioural characterization of the two readers of the server
 * configuration, written before ROADMAP T52 kept only one:
 *   - the private getServerConfig() behind the Servers tree's option rows
 *     (features/servers/views/serverItems.ts);
 *   - the exported getServerConfig() of features/servers/views/configurationItems.ts,
 *     used by the configuration click handlers.
 * Both answer ServerSettingsManager's legacy config, read at call time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

test('both server-config readers answer the legacy config of the settings manager, read at call time', async () => {
    const fake = createFakeVscode();
    await withFakeVscode(fake, async ({ requireOut }) => {
        const { ServerSettingsManager } = requireOut('core/server/serverSettingsManager.js');
        const { ServerItemFactory } = requireOut('features/servers/views/serverItems.js');
        const configurationItems = requireOut('features/servers/views/configurationItems.js');

        let config = { httpMode: 'HTTP', port: 4100, autoOpen: true, openMode: 'browser', remoteAccessEnabled: false };
        const originalGetInstance = ServerSettingsManager.getInstance;
        ServerSettingsManager.getInstance = () => ({ getLegacyConfig: () => config });
        try {
            assert.equal(configurationItems.getServerConfig(), config);
            const labels = ServerItemFactory.createConfigurationOptions().map((item) => item.label);
            assert.deepEqual(labels.slice(0, 5), [
                'HTTP Mode: HTTP',
                'Default Port: 4100',
                'Auto-Open: Enabled',
                'Open Mode: browser',
                'Cross-network connections: Disabled',
            ]);

            config = { httpMode: 'HTTPS', port: 4200, autoOpen: false, openMode: 'vscode', remoteAccessEnabled: true };
            assert.equal(configurationItems.getServerConfig(), config);
            const next = ServerItemFactory.createConfigurationOptions().map((item) => item.label);
            assert.deepEqual(next.slice(0, 5), [
                'HTTP Mode: HTTPS',
                'Default Port: 4200',
                'Auto-Open: Disabled',
                'Open Mode: vscode',
                'Cross-network connections: Enabled',
            ]);
        } finally {
            ServerSettingsManager.getInstance = originalGetInstance;
        }
    });
});
