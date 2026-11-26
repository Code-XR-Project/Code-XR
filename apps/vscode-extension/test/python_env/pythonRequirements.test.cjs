const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { renderFromManifest, requirementsPath } = require('../tooling/pythonRequirements.cjs');

test('backend/requirements.txt is the pythonPackageManifest pin, byte for byte', () => {
    // The manifest is what users get; requirements.txt is a generated mirror for
    // the backend and the IDE. Editing either one alone must fail here.
    const committed = fs.readFileSync(requirementsPath, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(
        committed,
        renderFromManifest(),
        'backend/requirements.txt is stale: run `npm run python:requirements` from the repository root',
    );
});

test('every requirement is an exact pin', () => {
    const requirements = fs.readFileSync(requirementsPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.replace(/#.*/, '').trim())
        .filter(Boolean);
    // Epic #140: code metrics come from backend/src/tools/code_metrics, not lizard.
    assert.equal(requirements.some((line) => line.startsWith('lizard')), false);
    for (const requirement of requirements) {
        assert.match(requirement, /^[A-Za-z0-9._-]+==\d+(\.\d+)*$/);
    }
});
