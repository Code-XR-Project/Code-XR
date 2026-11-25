'use strict';

/**
 * Pins which top-level folders of src/ may import which (story #42). The
 * allowed edges, the documented two-way pairs and the vscode-free floor are
 * data in folderDependencies.json; this file only compares them with the
 * measured import graph (folderDependencies.cjs).
 *
 * A failure here means an import crossed folders in a new direction. Prefer
 * importing the concrete lower-level file instead; if the new direction is
 * right, add it to the data file in the same commit, and if it closes a new
 * two-way pair, that pair needs a written reason too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { measure, readData } = require('./folderDependencies.cjs');

const measured = measure();
const data = readData();

function allowedEdgeKeys() {
    return Object.entries(data.mayImport)
        .flatMap(([from, targets]) => targets.map((to) => `${from}->${to}`))
        .sort();
}

function measuredEdgeKeys() {
    return Object.entries(measured.edges)
        .flatMap(([from, targets]) => Object.keys(targets).map((to) => `${from}->${to}`))
        .sort();
}

test('the measurement reads the code: it finds the source files and both runtime and type-only edges', () => {
    assert.ok(measured.fileCount > 300, `only ${measured.fileCount} src files were read`);
    // A runtime import (feature commands use the command model) ...
    assert.ok(measured.edges.commands?.platform, 'commands -> platform is not seen');
    // ... and an `import type` one (the participant summary in the servers' API).
    assert.ok(
        (measured.edges.servers?.collaboration || []).some((edge) => edge.startsWith('servers/runtime/httpsServerBase.ts ->')),
        'the type-only import in httpsServerBase.ts is not seen',
    );
});

test('every src folder has an entry in folderDependencies.json, and every entry is a src folder', () => {
    assert.deepEqual(Object.keys(data.mayImport).sort(), measured.folders);
});

test('no import crosses folders in a direction folderDependencies.json does not allow', () => {
    const allowed = new Set(allowedEdgeKeys());
    const violations = measuredEdgeKeys()
        .filter((key) => !allowed.has(key))
        .map((key) => {
            const [from, to] = key.split('->');
            return `${key}: ${measured.edges[from][to].slice(0, 3).join('; ')}`;
        });
    assert.deepEqual(violations, [], `new folder edges:\n  ${violations.join('\n  ')}`);
});

test('every allowed direction is still used (remove an entry once its last import is gone)', () => {
    const present = new Set(measuredEdgeKeys());
    assert.deepEqual(allowedEdgeKeys().filter((key) => !present.has(key)), []);
});

test('the two-way folder pairs are exactly the documented ones, each with a reason', () => {
    assert.deepEqual(Object.keys(data.twoWayPairs).sort(), measured.twoWayPairs);
    for (const [pair, reason] of Object.entries(data.twoWayPairs)) {
        assert.ok(typeof reason === 'string' && reason.length > 40, `${pair} has no written reason`);
    }
});

test('the files with no import path to vscode do not drop below the recorded floor', () => {
    assert.ok(
        measured.vscodeFree.length >= data.vscodeFreeFloor,
        `${measured.vscodeFree.length} vscode-free files, floor ${data.vscodeFreeFloor}`,
    );
});
