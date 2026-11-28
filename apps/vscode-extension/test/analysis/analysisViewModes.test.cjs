/**
 * The host's one table of default controller views per analysis mode
 * (src/core/analysis/refresh/analysisViewModes.ts). The refresh coordinator,
 * the export manifest and the collaboration router all read it; the browser
 * copy is kept in step by controllerViewMapSync.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const {
    ANALYSIS_CONTROLLER_VIEW_BY_MODE,
    FALLBACK_CONTROLLER_VIEW,
    defaultControllerView,
} = require(path.join(projectRoot, 'out', 'core', 'analysis', 'refresh', 'analysisViewModes.js'));

test('every analysis mode has the default controller view 1.2.0 shipped', () => {
    assert.deepEqual({ ...ANALYSIS_CONTROLLER_VIEW_BY_MODE }, {
        selection: 'visualization-menu',
        single: 'single.mapping',
        'dependency-graph': 'dependency.settings',
        'historical-compare': 'historical.selection',
        'project-evolution': 'project-evolution',
        'agent-flow': 'agent-flow',
    });
    for (const [mode, view] of Object.entries(ANALYSIS_CONTROLLER_VIEW_BY_MODE)) {
        assert.equal(defaultControllerView(mode), view);
    }
});

test('an unknown mode, including an Object.prototype member name, falls back to the single-analysis mapping view', () => {
    assert.equal(FALLBACK_CONTROLLER_VIEW, 'single.mapping');
    for (const mode of ['', 'unknown', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        assert.equal(defaultControllerView(mode), 'single.mapping', mode);
    }
});

test('the table cannot be mutated by a caller', () => {
    assert.ok(Object.isFrozen(ANALYSIS_CONTROLLER_VIEW_BY_MODE));
});
