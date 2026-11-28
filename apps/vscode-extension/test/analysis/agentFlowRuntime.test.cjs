const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const { readAssembledRuntime } = require(path.join(projectRoot, 'test', 'helpers', 'runtimeAssembly.cjs'));
const runtimeSource = readAssembledRuntime('agent-flow', 'agentFlowRuntime.js');
const sample = require(path.join(projectRoot, 'test', 'manual', 'agent-flow', 'sample-dataset.json'));

const clone = (value) => JSON.parse(JSON.stringify(value));

/** The runtime in a bare sandbox: no document, so nothing boots and only the pure API is used. */
function loadPure() {
    const sandbox = { console, Date, Math, JSON, setTimeout() { return 1; }, clearTimeout() {} };
    sandbox.window = sandbox;
    vm.runInNewContext(runtimeSource, sandbox, { filename: 'agentFlowRuntime.js' });
    return sandbox.CodeXRAgentFlowRuntime;
}

/**
 * The runtime booted against stub collaborators: a mode switcher, a room
 * client that records what it is sent and the handlers it is given, and a
 * fetch spy. No DOM entity is ever created on these paths.
 */
function loadWired({ mode = 'single', capabilities = { agentFlow: true } } = {}) {
    const sent = [];
    const handlers = {};
    const entityRuntimes = [];
    const fetches = [];
    const modeOptions = [];
    const changes = [];
    const lifecycles = {};
    const modeState = { mode, transitioning: false, pendingTransitionMode: null };
    const connection = {
        sendMessage(type, payload) { sent.push(JSON.parse(JSON.stringify({ type, payload }))); return true; },
        onMessage(type, handler) { handlers[type] = handler; return () => { delete handlers[type]; }; },
        registerEntityRuntime(runtime) { entityRuntimes.push(runtime); },
        getSessionInfoAsync: async () => ({ capabilities }),
        isOfflineExport: () => false,
    };
    const sandbox = {
        console, Date, Math, JSON,
        setTimeout() { return 1; },
        clearTimeout() {},
        document: {
            readyState: 'complete',
            addEventListener() {},
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
        },
        fetch: async (url) => { fetches.push(url); return { ok: true, json: async () => clone(sample) }; },
        CodeXRCollaborationRuntime: { getClient: () => connection },
        CodeXRAnalysisModeRuntime: {
            getState: () => ({ ...modeState }),
            register(id, lifecycle) { lifecycles[id] = lifecycle; return () => { delete lifecycles[id]; }; },
            registerModeOption(option) { modeOptions.push(option); return () => {}; },
            changeAnalysis(id, context) { changes.push({ id, context }); return Promise.resolve(); },
        },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(runtimeSource, sandbox, { filename: 'agentFlowRuntime.js' });
    return { runtime: sandbox.CodeXRAgentFlowRuntime, sent, handlers, entityRuntimes, fetches, modeOptions, changes, lifecycles, modeState };
}

function fakeScheduler() {
    const timers = [];
    return {
        timers,
        schedule(fn, ms) { const handle = { fn, ms, cancelled: false }; timers.push(handle); return handle; },
        cancel(handle) { handle.cancelled = true; },
        /** Fires the oldest pending timer. */
        fire() {
            const handle = timers.find((timer) => !timer.cancelled && !timer.fired);
            if (!handle) { return null; }
            handle.fired = true;
            handle.fn();
            return handle;
        },
        pending() { return timers.filter((timer) => !timer.cancelled && !timer.fired); },
    };
}

const api = loadPure().__testing;
const dataset = api.normalizeDataset(clone(sample));
const timeline = api.buildTimeline(dataset);
// The sample is regenerated from the real sources, so files are found by path.
const fileIndex = (suffix) => {
    const index = dataset.files.findIndex((file) => file.path === suffix || file.path.endsWith(`/${suffix}`));
    assert.ok(index >= 0, `${suffix} is in the sample`);
    return index;
};
const CREATED = fileIndex('test/analysis/dependencyGraphTooltip.test.cjs');
const EDITED = fileIndex('tooltipsAndSelection.js');
const MODELS = fileIndex('dependencyGraphModels.ts');
const SEARCHED_ONLY = fileIndex('templates/components/common/codexrCommonRuntime.js');
const UNTOUCHED = dataset.files.findIndex((file) => file.lastStep < 0 && file.h > 0.05);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the runtime is a manifest-assembled multi-part runtime that parses and exposes its global', () => {
    assert.doesNotThrow(() => new vm.Script(runtimeSource));
    const runtime = loadPure();
    for (const name of ['applySharedState', 'applyDataset', 'requestSources', 'openSource', 'closeSession', 'play', 'pause', 'seek', 'stepForward', 'stepBack', 'nextTurn', 'previousTurn', 'setSpeed', 'setFollowLive', 'setToggle', 'getState', 'destroy']) {
        assert.equal(typeof runtime[name], 'function', name);
    }
    assert.equal(api.MODE, 'agent-flow');
});

test('normalizeDataset rejects non-datasets and drops step file indexes that point nowhere', () => {
    assert.equal(api.normalizeDataset(null), null);
    assert.equal(api.normalizeDataset({ files: 'x' }), null);
    const broken = api.normalizeDataset({ files: [{ path: 'a.js', loc: 3 }], steps: [{ seq: 0, kind: 'read', files: [0, 7, -1] }] });
    assert.deepEqual(plain(broken.steps[0].files), [0]);
    assert.deepEqual(plain(broken.districts), []);
    assert.deepEqual(plain(broken.blastRadius), []);
});

test('buildTimeline orders the steps, marks turn boundaries, failures and per-step targets', () => {
    assert.equal(timeline.count, 29);
    assert.equal(timeline.turns.length, 3);
    assert.deepEqual(plain(timeline.turnStarts), [0, 14, 24]);
    assert.deepEqual(plain(timeline.turns.map((turn) => [turn.start, turn.end, turn.label])), [[0, 13, 'T1'], [14, 23, 'T2'], [24, 28, 'T3']]);
    assert.deepEqual(
        plain(timeline.turns[1].counts),
        { read: 3, search: 0, write: 4, execute: 2, other: 1, failed: 1 },
    );
    assert.equal(timeline.steps[20].failed, true, 'the failing test run');
    assert.equal(timeline.steps[23].failed, false);
    assert.equal(timeline.steps[0].target.type, 'files', 'a search targets every match');
    assert.equal(timeline.steps[0].target.files.length, 4);
    assert.equal(timeline.steps[20].target.type, 'console', 'commands go to the test tower');
    assert.equal(timeline.steps[15].target.type, 'file');
    assert.equal(timeline.steps[15].target.primary, EDITED);
});

test('stateAt at the end reproduces the builder\'s touch counters and session metrics', () => {
    const end = api.stateAt(dataset, timeline.count - 1, timeline);
    dataset.files.forEach((file, index) => {
        assert.deepEqual(plain(end.files[index].touches), plain(file.touches), file.path);
        assert.deepEqual(plain(end.files[index].turns).sort(), plain(file.turns).sort(), file.path);
    });
    assert.equal(end.footprint, sample.metrics.footprint);
    assert.equal(end.counts.reads, sample.metrics.reads);
    assert.equal(end.counts.writes, sample.metrics.writes);
    assert.equal(end.counts.searches, sample.metrics.searches);
    assert.equal(end.counts.executes, sample.metrics.executes);
    assert.equal(end.counts.failures, sample.metrics.failures);
});

test('stateAt is idempotent: a seek is a recomputation, not an undo log', () => {
    const direct = api.stateAt(dataset, 8, timeline);
    api.stateAt(dataset, 28, timeline);
    api.stateAt(dataset, -1, timeline);
    assert.deepEqual(JSON.parse(JSON.stringify(api.stateAt(dataset, 8, timeline))), JSON.parse(JSON.stringify(direct)));
    // The timeline is optional: stateAt builds it when absent.
    assert.deepEqual(JSON.parse(JSON.stringify(api.stateAt(clone(sample), 8))), JSON.parse(JSON.stringify(direct)));
    const clamped = api.stateAt(dataset, 999, timeline);
    assert.equal(clamped.stepIndex, 28);
    assert.equal(api.stateAt(dataset, -5, timeline).stepIndex, -1);
});

test('heights: created files rise from nothing, edited files grow from their pre-session size', () => {
    const created = dataset.files[CREATED];
    const edited = dataset.files[EDITED];
    const before = api.stateAt(dataset, -1, timeline);
    assert.equal(before.files[CREATED].visible, false);
    assert.equal(before.files[CREATED].height, 0);
    assert.ok(before.files[EDITED].height < edited.h, 'tooltipsAndSelection.js was shorter before the edits');
    assert.ok(Math.abs(api.stateAt(dataset, 17, timeline).files[CREATED].height) < 1e-9, 'not yet written at step 17');
    const afterWrite = api.stateAt(dataset, 18, timeline);
    assert.equal(afterWrite.files[CREATED].visible, true);
    assert.ok(Math.abs(afterWrite.files[CREATED].height - created.h) < 1e-6);
    // Step 15 is +14/-3, step 22 is +2/-2: the whole delta lands on step 15.
    assert.ok(Math.abs(api.stateAt(dataset, 15, timeline).files[EDITED].height - edited.h) < 1e-6);
    assert.ok(Math.abs(api.heightForLoc(edited, edited.loc) - edited.h) < 1e-9);
    assert.ok(api.heightForLoc(edited, 1) >= 0.04);
    // An untouched file never moves.
    assert.equal(before.files[UNTOUCHED].height, dataset.files[UNTOUCHED].h);
});

test('heat categories and colours follow what happened so far', () => {
    const end = api.stateAt(dataset, 28, timeline);
    assert.equal(end.files[CREATED].heat, 'created');
    assert.equal(end.files[EDITED].heat, 'written');
    assert.equal(end.files[MODELS].heat, 'read');
    assert.equal(end.files[SEARCHED_ONLY].heat, 'searched');
    assert.equal(end.files[UNTOUCHED].heat, 'untouched');
    assert.equal(api.heatColor(end.files[CREATED], false), api.COLORS.created);
    assert.equal(api.heatColor(end.files[EDITED], false), api.COLORS.write);
    assert.notEqual(api.heatColor(end.files[UNTOUCHED], false), api.heatColor(end.files[UNTOUCHED], true), 'outside files are a different slate');
    assert.equal(api.replayColor(end.files[UNTOUCHED], false, null), api.COLORS.base, 'untouched stays neutral');
    assert.equal(api.replayColor(end.files[MODELS], false, 'read'), api.COLORS.read, 'the focused file glows in its verb colour');
    assert.equal(api.replayColor(end.files[CREATED], false, 'write'), api.COLORS.created);
});

test('actors: workers get lanes, spawn at their delegate step and work in parallel', () => {
    assert.equal(timeline.actors.length, 3);
    assert.deepEqual(plain(timeline.actors.map((lane) => [lane.kind, lane.spawnIndex, lane.firstIndex, lane.lastIndex])),
        [['main', -1, 0, 28], ['subagent', 1, 3, 8], ['subagent', 2, 4, 10]]);
    assert.equal(api.actorColor(0), '#10b981');
    assert.equal(api.actorColor(1), api.ACTOR_PALETTE[0]);
    assert.equal(api.actorColor(6), api.ACTOR_PALETTE[0], 'the palette cycles');
    // A step links to the same actor's neighbours, not the global ones.
    assert.equal(timeline.steps[3].actorNext, 5);
    assert.equal(timeline.steps[5].actorPrev, 3);
    // Mid-session three workers are busy at once.
    const mid = api.workersAt(timeline, 7);
    assert.deepEqual(plain(mid.map((worker) => [worker.present, worker.active, worker.stepIndex])), [[true, true, 6], [true, true, 5], [true, true, 7]]);
    // Before its first step a spawned worker is present but idle; before its spawn it is absent.
    assert.deepEqual(plain(api.workersAt(timeline, 2).map((worker) => [worker.present, worker.active])), [[true, true], [true, false], [true, false]]);
    assert.equal(api.workersAt(timeline, 0)[1].present, false);
    // A finished subagent leaves the table.
    assert.deepEqual(plain(api.workersAt(timeline, 11).map((worker) => worker.present)), [true, false, false]);
    // A dataset from before multi-agent tracing gets one synthesized main actor.
    const legacy = api.normalizeDataset({ session: { agent: 'Codex' }, files: [{ path: 'a.js', loc: 3 }], steps: [{ seq: 0, kind: 'read', files: [0], actor: 4 }] });
    assert.deepEqual(plain(legacy.actors.map((actor) => [actor.label, actor.kind])), [['Codex', 'main']]);
    assert.equal(legacy.steps[0].actor, 0, 'an actor index that points nowhere falls back to the main agent');
});

test('site marks: blind writes, deletions by step and plate height', () => {
    // The created test file is not blind; nothing else in the sample is written unread except what the builder counted.
    const blind = timeline.steps.flatMap((step) => step.blind);
    assert.equal(new Set(blind).size, sample.metrics.blindWrites);
    assert.ok(!blind.includes(CREATED), 'creating a file is not a blind write');
    const end = api.stateAt(dataset, timeline.count - 1, timeline);
    blind.forEach((fileIndex) => assert.equal(end.files[fileIndex].blind, true));
    const removal = api.normalizeDataset({
        files: [{ path: 'a.js', loc: 3 }, { path: 'src/b.js', loc: 9 }],
        steps: [{ seq: 0, kind: 'read', files: [0] }, { seq: 1, kind: 'execute', files: [], deleted: ['src/b.js'] }],
    });
    const removalLine = api.buildTimeline(removal);
    assert.deepEqual(plain(removalLine.steps[1].deletes), [1]);
    assert.equal(api.stateAt(removal, 0, removalLine).files[1].deleted, false);
    assert.equal(api.stateAt(removal, 1, removalLine).files[1].deleted, true);
    assert.equal(api.stepVerb(removalLine.steps[1]), 'Delete');
    assert.ok(Math.abs(api.plateHeightOf(dataset.districts) - 0.014) < 1e-9, 'the babia layout plate height is read from the districts');
    assert.equal(api.plateHeightOf([], undefined), 0.006, 'older datasets keep the thin terraces');
});

test('a deleted file turns into a ghost after its last step', () => {
    const deleted = api.normalizeDataset({
        files: [{ path: 'old.js', loc: 40, h: 0.3, deleted: true, lastStep: 1, firstStep: 0 }],
        steps: [{ seq: 0, kind: 'read', files: [0] }, { seq: 1, kind: 'write', files: [0] }],
    });
    const line = api.buildTimeline(deleted);
    assert.equal(api.stateAt(deleted, 0, line).files[0].deleted, false);
    const after = api.stateAt(deleted, 1, line);
    assert.equal(after.files[0].deleted, true);
    assert.equal(after.files[MODELS].heat, 'deleted');
});

test('files outside the analysis are detected from the district chain', () => {
    const outside = dataset.files.filter((file) => api.isOutsideFile(file, dataset.districts)).map((file) => file.path);
    assert.deepEqual(outside.sort(), ['CHANGELOG.md', 'test/analysis/dependencyGraphTooltip.test.cjs']);
});

test('colour encodings: verb hues, turn ramp, delta caps, district tones', () => {
    assert.equal(api.kindColor('read'), '#22d3ee');
    assert.equal(api.kindColor('search'), '#a78bfa');
    assert.equal(api.kindColor('write'), '#fb923c');
    assert.equal(api.kindColor('execute'), '#34d399');
    assert.equal(api.kindColor('execute', true), '#f43f5e');
    assert.equal(api.turnColor(0, 3), '#38bdf8');
    assert.equal(api.turnColor(2, 3), '#facc15');
    assert.notEqual(api.turnColor(1, 3), api.turnColor(0, 3));
    assert.equal(api.mixHex('#000000', '#ffffff', 0.5), '#808080');
    const small = api.deltaCapStyle(5, 50);
    const big = api.deltaCapStyle(50, 50);
    const shrink = api.deltaCapStyle(-20, 50);
    assert.ok(big.thickness > small.thickness);
    assert.equal(big.color, api.COLORS.deltaUp);
    assert.equal(shrink.color, api.COLORS.deltaDown);
    assert.equal(shrink.sign, -1);
    assert.notEqual(api.districtTone(1), api.districtTone(3));
});

test('playback: play advances one step per interval, waits for the hop, stops at the end', () => {
    const clock = fakeScheduler();
    const positions = [];
    let count = 3;
    const playback = api.createPlayback({
        schedule: clock.schedule, cancel: clock.cancel,
        getCount: () => count, getTurnStarts: () => [0, 2],
        onPosition: (index, info) => positions.push([index, info.animate, info.reason]),
    });
    playback.reset(-1);
    assert.equal(playback.play(), true);
    clock.fire();
    assert.deepEqual(plain(positions.at(-1)), [0, true, 'play']);
    assert.equal(clock.pending()[0].ms, 900, 'base 900 ms at 1x');
    playback.hopStarted();
    clock.fire();
    assert.equal(positions.length, 1, 'a busy hop holds the next step');
    playback.hopFinished();
    assert.deepEqual(positions.at(-1), [1, true, 'play']);
    playback.setSpeed(2);
    assert.equal(clock.pending()[0].ms, 450, 'speed rescales the interval');
    clock.fire();
    assert.deepEqual(positions.at(-1), [2, true, 'play']);
    clock.fire();
    assert.equal(playback.getState().playing, false, 'a finished replay stops at the last step');
    // Play at the end starts over from before the first step.
    playback.play();
    assert.deepEqual(positions.at(-1), [-1, false, 'restart']);
    count = 0;
    playback.reset(-1);
    assert.equal(playback.play(), false, 'nothing to play without steps');
});

test('playback: seeking, stepping and turn jumps never animate backwards', () => {
    const clock = fakeScheduler();
    const positions = [];
    const playback = api.createPlayback({
        schedule: clock.schedule, cancel: clock.cancel,
        getCount: () => timeline.count, getTurnStarts: () => timeline.turnStarts,
        onPosition: (index, info) => positions.push([index, info.animate]),
    });
    playback.reset(-1);
    playback.play();
    playback.seek(20);
    assert.equal(playback.getState().playing, false, 'a seek pauses');
    assert.deepEqual(positions.at(-1), [20, false]);
    playback.stepForward();
    assert.deepEqual(positions.at(-1), [21, true], 'only a forward single step animates');
    playback.stepBack();
    assert.deepEqual(positions.at(-1), [20, false]);
    playback.nextTurn();
    assert.equal(playback.getState().index, 24);
    playback.nextTurn();
    assert.equal(playback.getState().index, 28, 'past the last turn: the end');
    playback.previousTurn();
    assert.equal(playback.getState().index, 24);
    playback.previousTurn();
    assert.equal(playback.getState().index, 14);
    playback.seek(0);
    playback.previousTurn();
    assert.equal(playback.getState().index, -1);
    assert.equal(playback.seek(500), 28, 'clamped');
    assert.equal(playback.setSpeed(-3), 1, 'an invalid speed falls back to 1x');
});

test('playback: follow live waits at the end and animates appended steps', () => {
    const clock = fakeScheduler();
    const positions = [];
    let count = 2;
    const playback = api.createPlayback({
        schedule: clock.schedule, cancel: clock.cancel,
        getCount: () => count, onPosition: (index, info) => positions.push([index, info.animate]),
    });
    playback.setLive(true);
    playback.reset(1);
    playback.play();
    clock.fire();
    assert.equal(playback.getState().playing, true, 'a live session keeps playing at the end');
    count = 4;
    assert.equal(playback.datasetGrew(2), true);
    clock.fire();
    clock.fire();
    assert.deepEqual(positions.slice(-2), [[2, true], [3, true]]);
    playback.setFollowLive(false);
    assert.equal(playback.datasetGrew(4), false, 'follow off: the playhead stays put');
});

test('planLiveUpdate: rebuild on a new layout, animate new steps only when following at the end', () => {
    const first = api.planLiveUpdate(null, dataset, -1, { followLive: true });
    assert.deepEqual(plain(first), { rebuild: true, index: 28, animateFrom: null });
    const grown = clone(sample);
    grown.session.live = true;
    grown.steps.push({ ...grown.steps[3], seq: 29 }, { ...grown.steps[5], seq: 30 });
    const next = api.normalizeDataset(grown);
    assert.deepEqual(plain(api.planLiveUpdate(dataset, next, 28, { followLive: true })), { rebuild: false, index: 28, animateFrom: 29 });
    assert.deepEqual(plain(api.planLiveUpdate(dataset, next, 7, { followLive: true })), { rebuild: false, index: 7, animateFrom: null });
    assert.equal(api.planLiveUpdate(dataset, next, 28, { followLive: false }).animateFrom, null);
    const moved = clone(grown);
    moved.files.push({ ...moved.files[0], path: 'src/new.ts', index: moved.files.length });
    assert.equal(api.planLiveUpdate(dataset, api.normalizeDataset(moved), 28, { followLive: true }).rebuild, true);
    assert.equal(api.layoutSignature(dataset), api.layoutSignature(api.normalizeDataset(clone(sample))));
    const empty = api.normalizeDataset({ ...clone(sample), steps: [] });
    assert.equal(api.planLiveUpdate(null, empty, -1, {}).index, -1);
});

test('panel text: metric rows, step line and verbs are plain ASCII', () => {
    const rows = api.metricsModel(dataset);
    assert.equal(rows.length, 10);
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
    assert.equal(byLabel.Footprint, '13 files');
    assert.equal(byLabel['Read / write / search / run'], '13 / 6 / 4 / 3');
    assert.equal(byLabel['Read/write ratio'], '2.17');
    assert.equal(byLabel['Revisit rate'], '23%');
    assert.equal(byLabel['Unread dependents'], '1');
    assert.equal(byLabel['Delta code lines'], '+87');
    assert.equal(byLabel['Delta complexity'], '+10');
    rows.forEach((row) => assert.match(row.label + row.value, /^[\x20-\x7e]*$/));
    assert.equal(api.stepLine(timeline, 15), 'Turn 2: Edit tooltipsAndSelection.js');
    assert.equal(api.stepLine(timeline, 20), 'Turn 2: npm run test:unit -- dependencyGraphTooltip (failed)');
    assert.equal(api.stepLine(timeline, -1), 'Before the first step');
    assert.equal(api.stepVerb(timeline.steps[15], dataset.files[EDITED]), 'Edit +14 -3');
    assert.equal(api.stepVerb(timeline.steps[18], dataset.files[CREATED]), 'Create +58 -0');
    assert.equal(api.stepVerb(timeline.steps[0]), 'Grep: 4 matches');
    assert.equal(api.stepVerb(timeline.steps[20]), 'Run (exit 1)');
    assert.equal(api.stepVerb(timeline.steps[19]), 'Permission granted');
    assert.equal(api.stepVerb(timeline.steps[1]), 'Delegate');
});

test('source picker: live first, newest first, paged; relative times', () => {
    const sources = [
        { id: 'a', updatedAt: 1000, live: false },
        { id: 'b', updatedAt: 3000, live: false },
        { id: 'c', updatedAt: 2000, live: true },
        { id: 'd', updatedAt: 500, live: false },
        { id: 'e', updatedAt: 100, live: false },
    ];
    const first = api.sourcesPage(sources, 0, 4);
    assert.deepEqual(plain(first.items.map((source) => source.id)), ['c', 'b', 'a', 'd']);
    assert.equal(first.pages, 2);
    assert.deepEqual(plain(api.sourcesPage(sources, 9, 4).items.map((source) => source.id)), ['e'], 'page clamped');
    assert.equal(api.relativeTime(1000, 1000 + 10 * 1000), 'just now');
    assert.equal(api.relativeTime(1000, 1000 + 5 * 60 * 1000), '5 min ago');
    assert.equal(api.relativeTime(1000, 1000 + 3 * 3600 * 1000), '3 h ago');
});

test('edge cases: a session with no steps, and a 900-file city stays cheap to seek', () => {
    const empty = api.normalizeDataset({ ...clone(sample), steps: [], turns: [] });
    const emptyLine = api.buildTimeline(empty);
    assert.equal(emptyLine.count, 0);
    assert.equal(api.stateAt(empty, 0, emptyLine).stepIndex, -1);
    assert.equal(api.stepLine(emptyLine, -1), 'No steps yet');

    const files = [];
    for (let index = 0; index < 900; index += 1) {
        files.push({ index, path: `pkg${index % 30}/file${index}.ts`, dir: `pkg${index % 30}`, loc: 10 + index, x: (index % 30) * 0.15 - 2.2, z: Math.floor(index / 30) * 0.07 - 1.1, w: 0.1, d: 0.05, h: 0.3 });
    }
    const steps = [];
    for (let seq = 0; seq < 1500; seq += 1) {
        steps.push({ seq, turn: Math.floor(seq / 100), kind: ['read', 'search', 'write', 'execute'][seq % 4], status: 'done', files: seq % 4 === 3 ? [] : [seq % 900, (seq * 7) % 900] });
    }
    const big = api.normalizeDataset({ files, steps, districts: [] });
    const started = Date.now();
    const line = api.buildTimeline(big);
    for (let index = 0; index < 20; index += 1) { api.stateAt(big, (index * 97) % 1500, line); }
    assert.ok(Date.now() - started < 1500, 'twenty seeks over 900 files x 1500 steps');
    assert.equal(line.turns.length, 15);
});

test('only buildings, the timeline strip and panel buttons carry the raycaster class', () => {
    const classes = runtimeSource.match(/class: RAYCAST_CLASS[^,\n]*/g) || [];
    assert.deepEqual(classes, [
        'class: RAYCAST_CLASS',
        "class: RAYCAST_CLASS + ' codexr-agent-flow-timeline'",
        "class: RAYCAST_CLASS + ' codexr-agent-flow-button'",
    ]);
    assert.match(runtimeSource, /raycastClass: ''/, 'the hover tooltip never swallows the pointer');
});

test('registration: mode option gated on capabilities.agentFlow, lifecycle and entity runtime registered', async () => {
    const disabled = loadWired({ capabilities: { agentFlow: false, agentFlowReason: 'Agent flow needs a folder or project analysis.' } });
    await new Promise((resolve) => setImmediate(resolve));
    const option = disabled.modeOptions.at(-1);
    assert.equal(option.id, 'agent-flow');
    assert.equal(option.color, '#10b981');
    assert.equal(option.disabled, true);
    assert.equal(option.disabledReason, 'Agent flow needs a folder or project analysis.');
    option.onSelect();
    assert.equal(disabled.sent.length, 0, 'a disabled mode sends nothing');

    const wired = loadWired();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof wired.lifecycles['agent-flow'].activate, 'function');
    assert.equal(typeof wired.lifecycles['agent-flow'].deactivate, 'function');
    assert.equal(wired.entityRuntimes[0].entityKind, 'agent-flow');
    assert.equal(wired.entityRuntimes[0].entityId, 'main');
    assert.equal(typeof wired.handlers['agent-flow-sources'], 'function');
    assert.equal(typeof wired.handlers['agent-flow-error'], 'function');
    wired.modeOptions.at(-1).onSelect();
    assert.deepEqual(wired.sent.at(-1), { type: 'analysis-mode-activate', payload: { mode: 'agent-flow' } });
    assert.equal(wired.changes.at(-1).id, 'agent-flow');
});

test('room protocol: sources request, open, close and the sources answer', async () => {
    const wired = loadWired();
    const runtime = wired.runtime;
    runtime.requestSources();
    assert.deepEqual(wired.sent.at(-1), { type: 'agent-flow-sources-request', payload: {} });
    runtime.openSource('claude-code:abc');
    assert.deepEqual(wired.sent.at(-1), { type: 'agent-flow-open', payload: { sourceId: 'claude-code:abc' } });
    runtime.closeSession();
    assert.deepEqual(wired.sent.at(-1), { type: 'agent-flow-close', payload: {} });
    wired.handlers['agent-flow-sources']({ type: 'agent-flow-sources', payload: { sources: [{ id: 'x', agent: 'Codex', label: 'Fix', updatedAt: 1, live: true }, { id: 'y' }], activeSourceId: 'y' } });
    assert.equal(runtime.getState().sources, 2);
    assert.equal(runtime.__testing.state.activeSourceId, 'y');
    wired.handlers['agent-flow-error']({ payload: { message: 'Only the host can open agent sessions.' } });
    assert.equal(runtime.getState().status, 'Only the host can open agent sessions.');
});

test('passive entity contract: a ready entity never fetches nor changes the mode while another mode is showing', async () => {
    const wired = loadWired({ mode: 'dependency-graph' });
    const sentBefore = wired.sent.length;
    const applied = await wired.entityRuntimes[0].applySharedState({
        entityKind: 'agent-flow', entityId: 'main', status: 'ready', revision: 3,
        datasetUrl: '/agent-flow/agent-flow-3.json', sourceId: 'claude-code:abc', live: true,
    });
    assert.equal(applied, false);
    assert.deepEqual(wired.fetches, []);
    assert.equal(wired.changes.length, 0);
    assert.equal(wired.sent.slice(sentBefore).some((message) => message.type === 'analysis-mode-activate'), false);
    const stored = wired.runtime.getState().entity;
    assert.equal(stored.status, 'ready');
    assert.equal(stored.revision, 3);
    assert.equal(stored.datasetUrl, '/agent-flow/agent-flow-3.json');
    assert.deepEqual(plain(wired.runtime.__testing.normalizeEntity({ status: 'weird' })), {
        status: 'idle', revision: 0, datasetUrl: null, sourceId: null, live: false, message: '',
    });
});
