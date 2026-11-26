'use strict';

// #13 step 3: HostEmitter replaces vscode.EventEmitter in the core. These pin
// the vscode.Event contract the feature layer subscribes with.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { measure } = require('../tooling/folderDependencies.cjs');

const out = path.join(__dirname, '..', '..', 'out', 'core', 'host', 'hostEmitter.js');
const { HostEmitter } = require(out);

function newEmitter() {
    const errors = [];
    return { emitter: new HostEmitter((error) => errors.push(error)), errors };
}

test('listeners run synchronously, in subscription order, with thisArgs', () => {
    const { emitter } = newEmitter();
    const calls = [];
    const owner = { name: 'owner' };
    emitter.event((value) => calls.push(['first', value]));
    emitter.event(function (value) { calls.push([this.name, value]); }, owner);
    emitter.fire(1);
    assert.deepEqual(calls, [['first', 1], ['owner', 1]]);
});

test('a throwing listener is reported and does not stop the others', () => {
    const { emitter, errors } = newEmitter();
    const seen = [];
    const boom = new Error('boom');
    emitter.event(() => { throw boom; });
    emitter.event((value) => seen.push(value));
    emitter.fire('x');
    assert.deepEqual(seen, ['x']);
    assert.deepEqual(errors, [boom]);
});

test('dispose() of a subscription stops it, and it is pushed into disposables', () => {
    const { emitter } = newEmitter();
    const seen = [];
    const bag = [];
    const subscription = emitter.event((value) => seen.push(value), undefined, bag);
    assert.equal(bag.length, 1);
    assert.equal(bag[0], subscription);
    emitter.fire(1);
    subscription.dispose();
    emitter.fire(2);
    assert.deepEqual(seen, [1]);
});

test('nothing is delivered after the emitter is disposed, even to new subscribers', () => {
    const { emitter } = newEmitter();
    const seen = [];
    emitter.event((value) => seen.push(value));
    emitter.dispose();
    emitter.fire(1);
    const late = emitter.event((value) => seen.push(value));
    emitter.fire(2);
    late.dispose();
    assert.deepEqual(seen, []);
});

// The modules #13 step 3 moved off vscode (the other two still fire VS Code
// commands or take an ExtensionContext, which steps 7 and 9 remove).
const MIGRATED = [
    'core/host/hostEmitter.ts',
    'core/collaboration/collaborationProfileManager.ts',
];

test('the modules migrated in #13 step 3 never reach vscode', () => {
    const free = new Set(measure().vscodeFree);
    for (const file of MIGRATED) {
        assert.ok(free.has(file), `${file} reaches vscode`);
    }
});

test('no core module builds a vscode.EventEmitter any more', () => {
    const fs = require('node:fs');
    const root = path.join(__dirname, '..', '..', 'src', 'core');
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes('new vscode.EventEmitter')) {
                offenders.push(path.relative(root, full));
            }
        }
    };
    walk(root);
    assert.deepEqual(offenders, []);
});
