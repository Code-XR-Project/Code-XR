/**
 * #178: "Reveal in XR scene". The scene side (analysis-table runtime,
 * sceneReveal.js) finds the file's element in the chart or the dependency
 * graph and marks it; the dependency graph pins the file's card, or the
 * folder card that holds it. The server side is test/servers/sceneReveal.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const { readAssembledRuntime } = require(path.join(projectRoot, 'test', 'helpers', 'runtimeAssembly.cjs'));
const tableSource = readAssembledRuntime('analysis-table', 'analysisTableRuntime.js');
const graphSource = readAssembledRuntime('dependency-graph', 'dependencyGraphRuntime.js');

class FakeElement {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.attributes = {};
        this.parentNode = null;
        this.events = [];
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    removeChild(child) { this.children = this.children.filter((entry) => entry !== child); child.parentNode = null; return child; }
    dispatchEvent(event) { this.events.push(event.type); return true; }
    querySelectorAll() {
        const all = [];
        const walk = (node) => node.children.forEach((child) => { all.push(child); walk(child); });
        walk(this);
        return all;
    }
}

// Enough of THREE for the marker: a world box read off `object3D.box`.
class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
}
class Box3 {
    setFromObject(object) { this.min = object.box?.min; this.max = object.box?.max; return this; }
    isEmpty() { return !this.min; }
    getCenter(target) { Object.assign(target, { x: (this.min.x + this.max.x) / 2, y: (this.min.y + this.max.y) / 2, z: (this.min.z + this.max.z) / 2 }); return target; }
    getSize(target) { Object.assign(target, { x: this.max.x - this.min.x, y: this.max.y - this.min.y, z: this.max.z - this.min.z }); return target; }
}

function loadScene({ hostname = 'localhost', mode = 'single', client } = {}) {
    const scene = new FakeElement('a-scene');
    const chart = new FakeElement('a-entity');
    let graph = null;
    const timers = [];
    const document = {
        createElement: (tag) => new FakeElement(tag),
        getElementById: (id) => (id === 'chart' ? chart : null),
        querySelector: (selector) => (selector === 'a-scene' ? scene : selector === '[codexr-dependency-graph]' ? graph : null),
    };
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, table() {} },
        document,
        location: { hostname },
        CustomEvent: class { constructor(type) { this.type = type; } },
        setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
        clearTimeout(id) { if (timers[id - 1]) { timers[id - 1].cleared = true; } },
        AFRAME: { components: {}, registerComponent(name, definition) { this.components[name] = definition; }, THREE: { Box3, Vector3 } },
        CodeXRAnalysisModeRuntime: { getState: () => ({ mode }) },
        CodeXRCollaborationRuntime: client ? { getClient: () => client } : undefined,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(tableSource, sandbox, { filename: 'analysisTableRuntime.js' });
    return { sandbox, scene, chart, timers, setGraph(value) { graph = value; } };
}

function bar(chart, { label, raw, box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 1 } } }) {
    const element = new FakeElement('a-entity');
    if (label) { element.setAttribute('babia-name', label); }
    if (raw) { element.babiaRawData = raw; }
    element.object3D = { box };
    chart.appendChild(element);
    return element;
}

test('#178 the chart element of a file: exact relative path first, then a bare file name', () => {
    const { sandbox, chart } = loadScene();
    const { chartElementForPath, normalizeRevealPath } = sandbox.CodeXRSceneReveal.__testing;
    assert.equal(normalizeRevealPath('.\\src\\a.py'), 'src/a.py');
    assert.equal(normalizeRevealPath('/src/a.py'), 'src/a.py');
    const byName = bar(chart, { label: 'a.py' });
    const exact = bar(chart, { raw: { relativePath: 'src/a.py', fileName: 'a.py' } });
    const labelled = bar(chart, { label: 'lib/b.py' });
    assert.equal(chartElementForPath('src/a.py'), exact);
    assert.equal(chartElementForPath('lib/b.py'), labelled);
    assert.equal(chartElementForPath('other/a.py'), byName, 'a chart row with only the name');
    assert.equal(chartElementForPath('src/missing.py'), null);
});

test('#178 revealing a file marks it over the chart, shows its legend, and clears after a while', () => {
    const { sandbox, scene, chart, timers } = loadScene();
    const element = bar(chart, { raw: { relativePath: 'src/a.py' }, box: { min: { x: 1, y: 0, z: 1 }, max: { x: 2, y: 3, z: 2 } } });
    assert.equal(sandbox.CodeXRSceneReveal.reveal('src\\a.py'), true);
    const marker = scene.children.find((child) => child.attributes['data-codexr-role'] === 'reveal-marker');
    assert.ok(marker, 'the marker hangs from the scene');
    const [x, y, z] = marker.attributes.position.split(' ').map(Number);
    assert.equal(x, 1.5);
    assert.equal(z, 1.5);
    assert.ok(y > 3, 'above the element');
    assert.deepEqual(element.events, ['mouseenter']);

    // A second reveal replaces the first marker.
    assert.equal(sandbox.CodeXRSceneReveal.reveal('src/a.py'), true);
    assert.equal(scene.children.length, 1);
    assert.deepEqual(element.events, ['mouseenter', 'mouseleave', 'mouseenter']);

    const pending = timers.filter((timer) => !timer.cleared && timer.delay === 8000);
    assert.equal(pending.length, 1);
    pending[0].callback();
    assert.equal(scene.children.length, 0);
    assert.equal(element.events.at(-1), 'mouseleave');

    assert.equal(sandbox.CodeXRSceneReveal.reveal('src/none.py'), false);
    assert.equal(sandbox.CodeXRSceneReveal.reveal(''), false);
});

test('#178 the comparison and evolution modes show no single file: nothing is marked', () => {
    for (const mode of ['historical-compare', 'project-evolution', 'selection']) {
        const { sandbox, scene, chart } = loadScene({ mode });
        bar(chart, { raw: { relativePath: 'src/a.py' } });
        assert.equal(sandbox.CodeXRSceneReveal.reveal('src/a.py'), false, mode);
        assert.equal(scene.children.length, 0);
    }
});

test('#178 in the dependency graph the graph component finds the node', () => {
    const { sandbox, scene, setGraph } = loadScene({ mode: 'dependency-graph' });
    const node = new FakeElement('a-entity');
    node.object3D = { box: { min: { x: 0, y: 0, z: 0 }, max: { x: 0.2, y: 0.2, z: 0.2 } } };
    const asked = [];
    setGraph({ components: { 'codexr-dependency-graph': { revealFile: (relativePath) => { asked.push(relativePath); return relativePath === 'src/a.ts' ? node : null; } } } });
    assert.equal(sandbox.CodeXRSceneReveal.reveal('src/a.ts'), true);
    assert.equal(sandbox.CodeXRSceneReveal.reveal('src/b.ts'), false);
    assert.deepEqual(asked, ['src/a.ts', 'src/b.ts']);
    assert.equal(scene.children.length, 1);
});

test('#178 only a page on this machine listens for reveal-in-scene', () => {
    const listeners = {};
    const client = { onMessage(type, listener) { listeners[type] = listener; } };
    const local = loadScene({ client });
    const element = bar(local.chart, { raw: { relativePath: 'src/a.py' } });
    assert.equal(typeof listeners['reveal-in-scene'], 'function');
    listeners['reveal-in-scene']({ type: 'reveal-in-scene', payload: { path: 'src/a.py' } });
    assert.deepEqual(element.events, ['mouseenter']);

    const remoteListeners = {};
    loadScene({ hostname: 'abc.trycloudflare.com', client: { onMessage(type, listener) { remoteListeners[type] = listener; } } });
    assert.deepEqual(remoteListeners, {});
});

// The component definition is registered on DOMContentLoaded (autoInit).
function loadGraphDefinition() {
    const components = {};
    let onReady = null;
    const context = {
        AFRAME: { components, registerComponent(name, definition) { components[name] = definition; } },
        console: { log() {}, warn() {}, error() {} },
        setTimeout() { return 0; },
        clearTimeout() {},
        document: { readyState: 'loading', addEventListener(_type, listener) { onReady = listener; }, querySelector: () => null, getElementById: () => null },
    };
    context.window = context;
    vm.runInNewContext(graphSource, context);
    try { onReady?.(); } catch { /* mounting needs a real scene; the definition is registered first */ }
    return components['codexr-dependency-graph'];
}

test('#178 the dependency graph pins the file card, or the deepest folder card holding the file', () => {
    const definition = loadGraphDefinition();
    assert.equal(typeof definition?.revealFile, 'function');
    const pinned = [];
    const make = (data) => ({ el: { id: data.id }, data });
    const self = {
        nodes: {
            'f:main': make({ id: 'f:main', kind: 'file', relativePath: 'main.ts' }),
            'scope:directory:src': make({ id: 'scope:directory:src', kind: 'group', relativePath: 'src' }),
            'scope:directory:src/deep': make({ id: 'scope:directory:src/deep', kind: 'group', relativePath: 'src/deep' }),
            'external:react': make({ id: 'external:react', kind: 'external', relativePath: 'react', external: true }),
        },
        isPinned: (selection) => pinned.includes(selection.id),
        togglePinnedSelection(selection) { pinned.push(selection.id); },
    };
    assert.equal(definition.revealFile.call(self, 'main.ts').id, 'f:main');
    assert.equal(definition.revealFile.call(self, 'src/deep/x/a.ts').id, 'scope:directory:src/deep');
    assert.equal(definition.revealFile.call(self, 'src/b.ts').id, 'scope:directory:src');
    assert.equal(definition.revealFile.call(self, 'srcx/b.ts'), null, 'a folder name prefix is not a folder');
    assert.equal(definition.revealFile.call(self, 'react'), null);
    assert.equal(definition.revealFile.call(self, 'main.ts').id, 'f:main');
    assert.deepEqual(pinned, ['f:main', 'scope:directory:src/deep', 'scope:directory:src'], 'a pinned card is never unpinned');
});
