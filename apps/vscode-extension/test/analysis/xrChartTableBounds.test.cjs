/**
 * Charts end on the table (XR review epic, S3): the BabiaXR compatibility
 * patches, the anchor clamp, the fresh bounding boxes and the generated
 * scene reading the row slice. The end-to-end check in a real browser is
 * `npm run test:xr-chart-bounds-harness`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const { readAssembledRuntime } = require(path.join(projectRoot, 'test', 'helpers', 'runtimeAssembly.cjs'));
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));
const runtimeSource = readAssembledRuntime('analysis-table', 'analysisTableRuntime.js');
const mappingUiSource = readAssembledRuntime('xr-chart-mapping-ui', 'xrChartMappingUiRuntime.js');

// The shape of BabiaXR 1.3.4's private Axis class: with `anim` on, the line
// end goes through an `animation__<axis>axis` attribute, which A-Frame 1.7.1
// never applies to `line.end`. One class per sandbox: the runtime patches its
// prototype, as it does the real bundle's.
function makeFakeBabiaAxisClass() {
    return class FakeBabiaAxis {
        constructor(el, axis, anim) {
            this.el = el;
            this.axis = axis;
            this.anim = anim;
        }

        updateLine(length) {
            const end = { x: 0, y: 0, z: 0 };
            end[this.axis] = length;
            if (this.anim) {
                this.el.attributes[`animation__${this.axis}axis`] = { property: `line__${this.axis}axis.end`, to: end };
            } else {
                this.el.attributes[`line__${this.axis}axis`] = { end };
            }
        }
    };
}

function babiaComponent(axis, FakeBabiaAxis) {
    function Component(el) {
        this.el = el;
        this.data = { animation: true };
    }
    Component.prototype.init = function () {
        this.axis = new FakeBabiaAxis(this.el, axis, this.data.animation);
    };
    return { Component };
}

function loadSandbox() {
    const timers = [];
    const queryJsonUpdates = [];
    const FakeBabiaAxis = makeFakeBabiaAxisClass();
    function QueryJson() {}
    QueryJson.prototype.update = function () {
        queryJsonUpdates.push(Object.assign({}, this.data));
    };
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, table() {} },
        setTimeout(callback, delay) {
            timers.push({ callback, delay });
            return timers.length;
        },
        clearTimeout(id) {
            if (timers[id - 1]) {
                timers[id - 1].cleared = true;
            }
        },
        AFRAME: {
            components: {
                'babia-axis-x': babiaComponent('x', FakeBabiaAxis),
                'babia-axis-y': babiaComponent('y', FakeBabiaAxis),
                'babia-axis-z': babiaComponent('z', FakeBabiaAxis),
                'babia-queryjson': { Component: QueryJson },
            },
            registerComponent(name, definition) {
                this.components[name] = definition;
            },
        },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(runtimeSource, sandbox, { filename: 'analysisTableRuntime.js' });
    return {
        sandbox,
        timers,
        queryJsonUpdates,
        QueryJson,
        testing: sandbox.CodeXRAnalysisTableRuntime.__testing,
    };
}

function boundsInfo(min, max) {
    return {
        bounds: { min, max },
        size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
        center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    };
}

const TABLE_DATA = {
    anchorX: 0,
    anchorY: 1,
    anchorZ: -18,
    targetWidth: 5.614,
    targetDepth: 3.218,
    tableTopPadding: 0.9,
    tableEdgeMargin: 0.18,
    tableTopSurfaceOffsetY: -0.08,
};

test('Babia axis lines are written directly, so an axis shrinks with its data', () => {
    const { sandbox } = loadSandbox();
    for (const name of ['babia-axis-x', 'babia-axis-y', 'babia-axis-z']) {
        const { Component } = sandbox.AFRAME.components[name];
        const axisName = name.slice(-1);
        const el = { attributes: {}, parentNode: null };
        const instance = new Component(el);
        instance.init();
        instance.axis.updateLine(50);
        instance.axis.updateLine(25);
        assert.deepEqual(el.attributes[`line__${axisName}axis`].end[axisName], 25, name);
        assert.equal(el.attributes[`animation__${axisName}axis`], undefined, `${name} still animates its line`);
        // The flag is restored: labels keep Babia's fade.
        assert.equal(instance.axis.anim, true);
    }
});

test('installing the Babia compatibility twice does not wrap twice', () => {
    const { sandbox, testing } = loadSandbox();
    const initBefore = sandbox.AFRAME.components['babia-axis-x'].Component.prototype.init;
    assert.equal(testing.installBabiaAxisLineCompat(sandbox.AFRAME).length, 0);
    assert.equal(sandbox.AFRAME.components['babia-axis-x'].Component.prototype.init, initBefore);
    assert.equal(testing.installBabiaQueryJsonCompat(sandbox.AFRAME), false);
});

test('a resized axis asks its chart containment for one re-fit after the burst', () => {
    const { sandbox, timers, testing } = loadSandbox();
    const reasons = [];
    const chart = { components: { 'codexr-chart-containment': { requestRenormalize: (reason) => reasons.push(reason) } }, parentNode: null };
    const axisEl = { attributes: {}, parentNode: chart };
    const instance = new sandbox.AFRAME.components['babia-axis-x'].Component(axisEl);
    instance.init();
    instance.axis.updateLine(40);
    instance.axis.updateLine(20);
    const live = timers.filter((timer) => !timer.cleared);
    assert.equal(live.length, 1, 'updates in one burst coalesce');
    assert.ok(live[0].delay > 280, 'the re-fit lands after requestRenormalize\'s debounce window');
    live[0].callback();
    assert.deepEqual(reasons, ['babia-axis-resized']);
    // An axis outside any chart has nobody to tell.
    assert.equal(testing.notifyContainmentOfAxisResize({ parentNode: null }), false);
});

test('an empty babia-queryjson waits instead of fetching the page itself', () => {
    const { QueryJson, queryJsonUpdates } = loadSandbox();
    const empty = new QueryJson();
    empty.data = { url: '', data: '' };
    empty.update({});
    assert.deepEqual(queryJsonUpdates, []);
    const filled = new QueryJson();
    filled.data = { url: '', data: '[{"a":1}]' };
    filled.update({});
    const fromUrl = new QueryJson();
    fromUrl.data = { url: 'data.json', data: '' };
    fromUrl.update({});
    assert.equal(queryJsonUpdates.length, 2);
});

test('the anchor keeps the axes on the table when centring the bars would push them off', () => {
    const { testing } = loadSandbox();
    // Three bars centred at x = 0, with an axis running 2.4 m to the right of
    // them: centring the bars alone leaves the axis 0.33 m past the edge.
    const primary = boundsInfo({ x: -1, y: 0.92, z: -18.5 }, { x: 1, y: 1.6, z: -17.5 });
    const containment = boundsInfo({ x: -1, y: 0.92, z: -18.5 }, { x: 4.4, y: 1.6, z: -17.5 });
    const measurements = { full: containment, primary, containment, content: primary, peakHeight: 0.6 };
    const offset = testing.computeAnchorOffset(measurements, TABLE_DATA);
    const limit = 6.514 - 0.36; // usable top: table + padding minus the edge margins
    const shiftedMax = containment.bounds.max.x + offset.deltaX;
    const shiftedMin = containment.bounds.min.x + offset.deltaX;
    assert.ok(shiftedMax <= TABLE_DATA.anchorX + limit / 2 + 1e-9, `axis ends at ${shiftedMax}`);
    assert.ok(shiftedMin >= TABLE_DATA.anchorX - limit / 2 - 1e-9, `axis starts at ${shiftedMin}`);
    assert.equal(offset.deltaZ, TABLE_DATA.anchorZ - primary.center.z, 'z was already inside: plain centring');

    const overhangBefore = testing.computeContainmentOverhang(measurements, TABLE_DATA);
    assert.ok(overhangBefore.x > 1, 'unplaced chart reports its overhang');
});

test('a span wider than the usable top is centred, and an inside span is left alone', () => {
    const { testing } = loadSandbox();
    assert.equal(testing.keepSpanInsideRegion(0.5, -1, 1, 0, 4), 0.5);
    assert.equal(testing.keepSpanInsideRegion(1.5, -1, 1, 0, 4), 1);
    assert.equal(testing.keepSpanInsideRegion(-1.5, -1, 1, 0, 4), -1);
    assert.equal(testing.keepSpanInsideRegion(3, -2, 8, 0, 4), -3);
    assert.ok(Number.isNaN(testing.keepSpanInsideRegion(Number.NaN, -1, 1, 0, 4)));
});

test('bounding boxes are recomputed when a line rewrites its positions in place', () => {
    const { testing } = loadSandbox();
    let computed = 0;
    const position = { version: 0, count: 2 };
    const geometry = {
        attributes: { position },
        boundingBox: null,
        computeBoundingBox() {
            computed += 1;
            this.boundingBox = { maxX: position.version === 0 ? 50 : 25 };
        },
    };
    testing.refreshGeometryBoundingBox(geometry);
    testing.refreshGeometryBoundingBox(geometry);
    assert.equal(computed, 1, 'an unchanged geometry keeps its cached box');
    assert.equal(geometry.boundingBox.maxX, 50);
    position.version += 1; // needsUpdate = true after an in-place rewrite
    testing.refreshGeometryBoundingBox(geometry);
    assert.equal(computed, 2);
    assert.equal(geometry.boundingBox.maxX, 25);
    geometry.attributes.position = { version: 1, count: 4 }; // replaced attribute
    testing.refreshGeometryBoundingBox(geometry);
    assert.equal(computed, 3);
});

test('generated row-budgeted charts read the slice from their first build; boats keeps its tree', async () => {
    await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
        const { chartTemplates, CHART_DATA_SLICE_ENTITY_ID } = requireOut('core/charts/templateCharts.js');
        const { CHART_PRESENTATION_PROFILES } = requireOut('core/charts/chartPresentation.js');
        // Pinned against the runtime that fills the slice.
        assert.match(mappingUiSource, /var CHART_DATA_SLICE_PREFIX = 'codexrChartDataSlice__';/);
        assert.equal(CHART_DATA_SLICE_ENTITY_ID, 'codexrChartDataSlice__data');
        for (const chart of chartTemplates) {
            const budgeted = !!CHART_PRESENTATION_PROFILES[chart.id]?.rowBudget;
            if (budgeted) {
                assert.match(chart.htmlTemplate, /<a-entity id="codexrChartDataSlice__data" babia-queryjson=""><\/a-entity>/, chart.id);
                assert.match(chart.htmlTemplate, /="from: codexrChartDataSlice__data;/, chart.id);
                assert.doesNotMatch(chart.htmlTemplate, /from: data;/, chart.id);
            } else {
                assert.doesNotMatch(chart.htmlTemplate, /codexrChartDataSlice__/, chart.id);
            }
        }
    });
});
