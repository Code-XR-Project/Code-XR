const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// XR epic, story S1 (audit PANELS-1, PANELS-2): panels must be readable
// wherever they stand. A-Frame 1.7.1 keeps `sortTransparentObjects: false`, so
// transparent surfaces are drawn in DOM order, not by distance. Two rules
// follow, checked here over every runtime that ships in a generated scene:
//   1. no material skips the depth test (a surface that does is painted over
//      by anything drawn after it, however far away);
//   2. the backing of every panel is opaque (a translucent backing lets the
//      panels behind it read through).

const componentsRoot = path.resolve(__dirname, '..', '..', 'templates', 'components');

function listRuntimeFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return listRuntimeFiles(full);
        }
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

test('no scene runtime disables the depth test on a material', () => {
    const offenders = listRuntimeFiles(componentsRoot).flatMap((file) => fs.readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /depthTest\s*:\s*false/.test(line) && !/^\s*\/\//.test(line))
        .map(({ index }) => `${path.relative(componentsRoot, file)}:${index + 1}`));
    assert.deepEqual(offenders, []);
});

const PANEL_BACKINGS = [
    // [file, a unique snippet that identifies the backing's declaration]
    ['common/codexrCommonRuntime.js', "material: 'color: #0e1626; shader: flat; side: double'"],
    ['codexr/virtual-screen/virtualScreenRuntime/visibilityAndLayout.js', "material: 'color: #0F172A; shader: flat;',\n        position: '0 0 -0.01',"],
    ['codexr/virtual-screen/codexrMultiScreenManagerRuntime.js', "this.panelPlane.setAttribute('material', 'shader: flat;');"],
    ['codexr/guide-screen/guideScreenRuntime/guideScreen.js', "material: 'color: #0b1220; shader: flat; side: double'"],
    ['codexr/xr-chart-mapping-ui/xrChartMappingUiRuntime/panelUi.js', "refs.panelBackground = createEntity('a-plane', {\n      color: '#0A1628',\n      width: 6.2,"],
    ['codexr/historical-comparison/historicalComparisonRuntime/selectionPanel.js', "material: 'color: #0e1526; shader: flat'"],
    ['codexr/project-evolution/projectEvolutionRuntime/overlayAndPanel.js', "material: 'color: #111827; shader: flat'"],
    ['codexr/dependency-graph/dependencyGraphRuntime/componentCore.js', "material: 'color: #0b1220; shader: flat; side: double'"],
];

test('every panel backing is opaque', () => {
    for (const [file, snippet] of PANEL_BACKINGS) {
        // Windows checkouts use CRLF; the multi-line snippets are written with LF.
        const source = fs.readFileSync(path.join(componentsRoot, file), 'utf8').replace(/\r\n/g, '\n');
        assert.ok(source.includes(snippet), `${file}: opaque backing not found`);
    }
});

test('the virtual-screen status line wraps inside the frame', () => {
    const source = fs.readFileSync(path.join(componentsRoot,
        'codexr/virtual-screen/virtualScreenRuntime/visibilityAndLayout.js'), 'utf8');
    assert.match(source, /refs\.status\.setAttribute\('width', String\(Math\.max\(1, width - 0\.3\)\)\)/);
});
