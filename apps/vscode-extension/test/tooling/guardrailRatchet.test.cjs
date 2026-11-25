const test = require('node:test');
const assert = require('node:assert/strict');

const { measure, readBaseline, compareRatcheted, rekeyBaseline, describeChange, moduleOf } = require('./measureGuardrails.cjs');

const bulletList = (changes) => changes.map((change) => `  - ${describeChange(change)}`).join('\n');

test('no cleanup metric got worse than the committed baseline', () => {
    // console.* calls, console-only catch blocks, any-escapes, suppressions,
    // oversized files and functions, cyclomatic complexity, modules unreachable
    // from the entry point, unreachable commands: v1.2.1 exists to bring these
    // down, so none of them may quietly grow back.
    const { worse } = compareRatcheted(measure().ratcheted, readBaseline().ratcheted);

    assert.equal(
        worse.length,
        0,
        `These metrics are worse than test/tooling/guardrail-baseline.json:\n${bulletList(worse)}\n`
        + 'Fix the regression. If it is deliberate (a new lint rule raising the warning ceiling), record it with:\n'
        + '  node test/tooling/measureGuardrails.cjs --write --allow-regression "<reason>"',
    );
});

test('the committed baseline is the current measurement', () => {
    // The ratchet is tight on purpose: a metric that IMPROVED must be written
    // down too. That makes the baseline diff the recorded before/after of every
    // cleanup commit, and stops a later regression from hiding inside slack.
    const { worse, moved } = compareRatcheted(measure().ratcheted, readBaseline().ratcheted);

    assert.equal(
        moved.length,
        0,
        `These metrics moved but the baseline was not regenerated:\n${bulletList(moved)}\n`
        + 'Run `npm run guardrails:update` and commit test/tooling/guardrail-baseline.json in the same commit.',
    );
    assert.equal(worse.length, 0, 'see the previous test');
});

test('the comparison tells a regression from an improvement', () => {
    const baseline = {
        'console.total': 10,
        'console.byModule': { servers: 6, views: 4 },
        'size.filesOver500': ['src/a.ts', 'src/b.ts'],
        'eslint.maxWarnings': null,
        'commands.internalByKind': { 'pending-removal': 2, 'tree-item': 5 },
    };

    assert.deepEqual(compareRatcheted(baseline, baseline), { worse: [], moved: [] });

    const regressed = compareRatcheted({
        ...baseline,
        'console.total': 11,
        'console.byModule': { servers: 6, views: 4, utils: 1 },
        'size.filesOver500': ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        'commands.internalByKind': { 'pending-removal': 3, 'tree-item': 5 },
    }, baseline);
    assert.deepEqual(regressed.worse.map((change) => change.metric), [
        'commands.internalByKind.pending-removal',
        'console.byModule.utils',
        'console.total',
        'size.filesOver500',
    ]);
    assert.equal(regressed.worse.find((change) => change.metric === 'size.filesOver500').detail, 'new: src/c.ts');
    assert.deepEqual(regressed.moved, []);

    const improved = compareRatcheted({
        ...baseline,
        'console.total': 4,
        'console.byModule': { servers: 4 },
        'size.filesOver500': ['src/a.ts'],
        'eslint.maxWarnings': 120,
        'commands.internalByKind': { 'pending-removal': 0, 'tree-item': 6 },
    }, baseline);
    assert.deepEqual(improved.worse, []);
    assert.deepEqual(improved.moved.map((change) => change.metric), [
        'commands.internalByKind.pending-removal',
        'commands.internalByKind.tree-item',
        'console.byModule.servers',
        'console.byModule.views',
        'console.total',
        'eslint.maxWarnings',
        'size.filesOver500',
    ]);

    // A lint ceiling may only come down once it exists, and may not disappear.
    assert.deepEqual(compareRatcheted({ 'eslint.maxWarnings': 130 }, { 'eslint.maxWarnings': 120 }).worse.length, 1);
    assert.deepEqual(compareRatcheted({ 'eslint.maxWarnings': null }, { 'eslint.maxWarnings': 120 }).worse.length, 1);
});

test('modules are the first folder under src/, or the first two under core/ and features/', () => {
    assert.equal(moduleOf('src/extension.ts'), '(root)');
    assert.equal(moduleOf('src/platform/logging/logger.ts'), 'platform');
    assert.equal(moduleOf('src/core/server/http/httpRespond.ts'), 'core/server');
    assert.equal(moduleOf('src/features/analysis/views/analysisItems.ts'), 'features/analysis');
    assert.equal(moduleOf('src/core/extensionContext.ts'), 'core');
});

test('--renamed re-keys the baseline through a move map, so a pure move reports no change', () => {
    const onDisk = new Set(['src/features/x/views/big.ts', 'src/core/server/a.ts', 'src/old/still.ts']);
    const exists = (file) => onDisk.has(file);
    const moves = {
        'src/old/big.ts': 'src/features/x/views/big.ts',
        'src/old/a.ts': 'src/core/server/a.ts',
        'src/old/still.ts': 'src/core/server/still.ts', // later batch: not moved yet
    };
    const committed = {
        ratcheted: {
            'any.byModule': { old: 5 },
            'console.byModule': { old: 1 },
            'size.filesOver500': ['src/old/big.ts', 'src/old/still.ts'],
            'reachability.unreachable': [],
        },
        informational: {
            'any.byFile': { 'src/old/big.ts': 2, 'src/old/a.ts': 1, 'src/old/still.ts': 2 },
            'console.byFile': { 'src/old/a.ts': 1 },
        },
        waivers: [],
    };
    const measured = {
        'any.byModule': { 'core/server': 1, 'features/x': 2, old: 2 },
        'console.byModule': { 'core/server': 1 },
        'size.filesOver500': ['src/features/x/views/big.ts', 'src/old/still.ts'],
        'reachability.unreachable': [],
    };
    const rekeyed = rekeyBaseline(committed, moves, measured, exists);
    assert.deepEqual(compareRatcheted(measured, rekeyed.ratcheted), { worse: [], moved: [] });
    // Without the map the same move looks like a regression.
    assert.ok(compareRatcheted(measured, committed.ratcheted).worse.length > 0);
    // A count that really changed is still caught after re-keying.
    const worse = compareRatcheted({ ...measured, 'any.byModule': { 'core/server': 2, 'features/x': 2, old: 2 } }, rekeyed.ratcheted).worse;
    assert.deepEqual(worse.map((change) => change.metric), ['any.byModule.core/server']);
    // A baseline recorded before the per-file counts existed accepts a pure regrouping only.
    const legacy = { ratcheted: { 'console.byModule': { core: 2 }, 'any.byModule': {} }, informational: {}, waivers: [] };
    assert.deepEqual(rekeyBaseline(legacy, {}, { 'console.byModule': { 'core/logging': 2 }, 'any.byModule': {} }, exists).ratcheted['console.byModule'], { 'core/logging': 2 });
    assert.deepEqual(rekeyBaseline(legacy, {}, { 'console.byModule': { 'core/logging': 3 }, 'any.byModule': {} }, exists).ratcheted['console.byModule'], { core: 2 });
});
