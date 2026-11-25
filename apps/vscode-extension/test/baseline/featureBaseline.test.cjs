const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { collectSurface, diffSurface, unauthorizedRemovals, snapshotPath } = require('./featureSurface.cjs');
const { AUTHORIZED_REMOVALS } = require('./authorizedRemovals.cjs');

/**
 * The feature baseline of epic #26 (docs/cleanup/feature-baseline.md): the
 * cleanup may remove nothing a user can see, invoke or rely on, except the
 * authorized removals. The snapshot was taken on 2026-11-25, before the first
 * cleanup commit.
 *
 * When this fails:
 * - an entry is MISSING and it is not an authorized removal: a feature was
 *   lost. Restore it. (A pure rename, e.g. a Python folder, is regenerated with
 *   `node test/baseline/featureSurface.cjs --write --allow "<reason>"`.)
 * - an entry was ADDED: v1.2.1 adds nothing user-visible, so either the change
 *   is wrong or it is internal and the snapshot is regenerated with --write in
 *   the same commit, with the reason in the commit message.
 */

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
let surfacePromise;
const loadSurface = () => {
    surfacePromise = surfacePromise || collectSurface();
    return surfacePromise;
};

test('the feature baseline snapshot is not empty in any section that had content', () => {
    // A collector that silently returns [] would make every check below vacuous.
    for (const section of ['contributedCommands', 'registeredCommands', 'menus', 'views', 'settings',
        'chartTypes', 'analysisModes', 'languages', 'pythonCli', 'pythonEntryPoints', 'persistedState',
        'templateFiles', 'exampleFiles', 'shippedFiles']) {
        assert.ok(Array.isArray(snapshot[section]) && snapshot[section].length > 0, `${section} is empty in the snapshot`);
    }
});

test('no feature of the baseline is lost, except the authorized removals', async () => {
    const surface = await loadSurface();
    const lost = unauthorizedRemovals(diffSurface(snapshot, surface), AUTHORIZED_REMOVALS);
    assert.deepEqual(lost, {}, 'entries vanished that are not authorized removals (test/baseline/authorizedRemovals.cjs)');
});

test('nothing user-visible was added without regenerating the baseline', async () => {
    const surface = await loadSurface();
    const added = {};
    for (const [section, { added: entries }] of Object.entries(diffSurface(snapshot, surface))) {
        if (entries.length > 0) {
            added[section] = entries;
        }
    }
    assert.deepEqual(added, {}, 'regenerate with `node test/baseline/featureSurface.cjs --write` if this is intended');
});

test('every persisted key and every Python entry point still exists', async () => {
    const surface = await loadSurface();
    // Users already have these on disk; a rename silently resets their settings.
    assert.deepEqual(surface.persistedState.filter((entry) => entry.endsWith('MISSING')), []);
    assert.deepEqual(surface.pythonEntryPoints.filter((entry) => entry.endsWith('MISSING')), []);
});

test('the authorized removals register only names entries the baseline had', () => {
    for (const [section, entries] of Object.entries(AUTHORIZED_REMOVALS)) {
        assert.ok(Array.isArray(snapshot[section]), `unknown section ${section}`);
        for (const entry of entries) {
            assert.ok(snapshot[section].includes(entry),
                `${section}: "${entry}" is not in the snapshot, so authorizing it means nothing`);
        }
    }
});

test('the diff reports both directions (canary)', () => {
    const report = diffSurface({ a: ['x', 'y'] }, { a: ['y', 'z'] });
    assert.deepEqual(report, { a: { missing: ['x'], added: ['z'] } });
    assert.deepEqual(unauthorizedRemovals(report, { a: ['x'] }), {});
    assert.deepEqual(unauthorizedRemovals(report, {}), { a: ['x'] });
});
