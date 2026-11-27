'use strict';

// #13 step 7: the launcher's post-launch UI is registered by the application,
// not imported by core/server. These pin the registration contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const out = path.join(__dirname, '..', '..', 'out', 'core', 'server', 'launchNotifier.js');
const { setLaunchNotifier, getLaunchNotifier } = require(out);

test('getLaunchNotifier throws while nothing is registered', () => {
    setLaunchNotifier(null);
    assert.throws(() => getLaunchNotifier(), /No launch notifier registered/);
});

test('the registered notifier is the one returned, and a later call replaces it', () => {
    const first = { warnHttpsOverriddenForPanel() {}, notifyPortChanged() {}, async handleAutoOpening() {} };
    const second = { ...first };
    setLaunchNotifier(first);
    assert.equal(getLaunchNotifier(), first);
    setLaunchNotifier(second);
    assert.equal(getLaunchNotifier(), second);
    setLaunchNotifier(null);
});

test('core/server never imports the launch notifications feature, and activation registers it', () => {
    const src = path.join(__dirname, '..', '..', 'src');
    const launcher = fs.readFileSync(path.join(src, 'core', 'server', 'multiServerLauncher.ts'), 'utf8');
    assert.ok(!launcher.includes('features/active-servers'), 'multiServerLauncher.ts imports a feature again');
    const extension = fs.readFileSync(path.join(src, 'extension.ts'), 'utf8');
    assert.match(extension, /setLaunchNotifier\(launchNotifications\)/);
});

test('closing server panels is a no-op until a closer is registered, then delegates', () => {
    const panels = require(path.join(__dirname, '..', '..', 'out', 'core', 'server', 'serverPanels.js'));
    panels.setServerPanelCloser(null);
    assert.equal(panels.closeServerPanels(['a']), 0);
    const seen = [];
    panels.setServerPanelCloser({ closeServerPanels: (ids) => { seen.push(...ids); return ids.length; } });
    assert.equal(panels.closeServerPanels(['a', 'b']), 2);
    assert.deepEqual(seen, ['a', 'b']);
    panels.setServerPanelCloser(null);
});

test('no core module imports platform/webview or platform/ui', () => {
    const root = path.join(__dirname, '..', '..', 'src', 'core');
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.ts') && /from '[./]*platform\/(webview|ui)\//.test(fs.readFileSync(full, 'utf8'))) {
                offenders.push(path.relative(root, full));
            }
        }
    };
    walk(root);
    assert.deepEqual(offenders, []);
});
