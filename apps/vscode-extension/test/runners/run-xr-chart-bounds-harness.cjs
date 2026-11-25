/**
 * Chart-bounds harness (XR review epic, S3): generates REAL directory scenes
 * with the compiled generator and runtime assets, opens each one in headless
 * Chromium with A-Frame and BabiaXR, and asserts that every chart type ends on
 * the analysis table — axes included — for 3, 30 and 300 files.
 *
 * Opt-in like the other browser harnesses (it needs Playwright's Chromium and
 * the A-Frame/BabiaXR CDNs): `npm run test:xr-chart-bounds-harness`.
 * CODEXR_CHART_BOUNDS_TYPES=bars,pie and CODEXR_CHART_BOUNDS_ROWS=3,300 narrow it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createFakeVscode, fakeExtensionContext, withFakeVscode } = require('../helpers/fakeVscode.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const CHART_TYPES = (process.env.CODEXR_CHART_BOUNDS_TYPES || 'bars,barsmap,cyls,cylsmap,pie,donut,bubbles,boats').split(',');
const ROW_COUNTS = (process.env.CODEXR_CHART_BOUNDS_ROWS || '3,30,300').split(',').map(Number);
const SETTLE_TIMEOUT_MS = 25000;
// The physical tabletop (codexr-analysis-table) and how far a mesh may poke
// past it (float noise, sub-centimetre bevels).
const TABLE = { width: 6.514, depth: 4.118 };
const TOLERANCE_M = 0.02;
const SLICE_ID = 'codexrChartDataSlice__data';

const FIELD_TYPES = {
    fileName: 'text', filePath: 'text', relativePath: 'text', language: 'text',
    totalLines: 'numeric', codeLines: 'numeric', commentLines: 'numeric', blankLines: 'numeric',
    commentRatio: 'numeric', classCount: 'numeric', functionCount: 'numeric', maxComplexity: 'numeric',
    cyclomaticComplexityNumber: 'numeric', fileSizeBytes: 'numeric',
};

const MAPPINGS = {
    boats: { area: 'functionCount', height: 'totalLines', color: 'cyclomaticComplexityNumber' },
    bars: { x_axis: 'fileName', height: 'totalLines' },
    barsmap: { x_axis: 'fileName', z_axis: 'language', height: 'totalLines' },
    cyls: { x_axis: 'fileName', height: 'totalLines', radius: 'cyclomaticComplexityNumber' },
    cylsmap: { x_axis: 'fileName', z_axis: 'language', height: 'totalLines', radius: 'cyclomaticComplexityNumber' },
    pie: { key: 'fileName', size: 'totalLines' },
    donut: { key: 'fileName', size: 'totalLines' },
    bubbles: { x_axis: 'fileName', z_axis: 'language', height: 'totalLines', radius: 'cyclomaticComplexityNumber' },
};

function makeRows(count) {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const languages = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust'];
    const directories = ['src/core', 'src/features/a', 'src/features/b', 'src/platform', 'lib/x/y', 'test'];
    return Array.from({ length: count }, (_, index) => {
        const directory = directories[index % directories.length];
        const fileName = `file_${index}.ts`;
        const totalLines = Math.floor(10 + random() * 2000);
        return {
            fileName, filePath: `/proj/${directory}/${fileName}`, relativePath: `${directory}/${fileName}`,
            language: languages[index % languages.length], totalLines,
            codeLines: Math.floor(totalLines * 0.8), commentLines: Math.floor(totalLines * 0.1),
            blankLines: Math.floor(totalLines * 0.1), commentRatio: 0.1, classCount: Math.floor(random() * 5),
            functionCount: 1 + Math.floor(random() * 60), maxComplexity: 1 + Math.floor(random() * 40),
            cyclomaticComplexityNumber: +(1 + random() * 12).toFixed(2), fileSizeBytes: totalLines * 30,
        };
    });
}

/** Writes the same files the directory parser produces into `outDir`. */
async function generateScene(outDir, chartId, rowCount) {
    fs.mkdirSync(outDir, { recursive: true });
    const rows = makeRows(rowCount);
    await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
        const { TemplateProcessor } = requireOut('core/charts/processing/templateProcessor.js');
        const { DIRECTORY_XR_RUNTIME_ASSETS } = requireOut('core/analysis/parsers/directoryXRParser.js');
        const { readCodeXrRoomTextureContents } = requireOut('core/analysis/scene-assets/codexrRoomComponentAsset.js');
        const context = fakeExtensionContext({ extensionPath: projectRoot });
        requireOut('core/charts/settings/settingsAccessors.js').initializeSettingsAccessors(context);
        const mappings = Object.entries(MAPPINGS[chartId]).map(([dimension, dataField]) => ({ dimension, dataField }));
        const result = await TemplateProcessor.generateXRVisualization(
            chartId, mappings, 'Directory Analysis: proj', 'data.json', context, path.join(outDir, 'index.html'), rows,
            { babiaUiVisibleByDefault: true, xrTargetType: 'directory', fieldTypeMap: FIELD_TYPES },
        );
        assert.ok(result.success, `scene generation failed for ${chartId}: ${result.error}`);
        fs.copyFileSync(path.join(projectRoot, 'templates', 'xr', 'sse', 'live_sse_fileXR.js'), path.join(outDir, 'main.js'));
        for (const [outputName, readContent] of DIRECTORY_XR_RUNTIME_ASSETS) {
            fs.writeFileSync(path.join(outDir, outputName), await readContent(projectRoot));
        }
        for (const asset of await readCodeXrRoomTextureContents(projectRoot)) {
            const target = path.join(outDir, asset.relativeOutputPath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, asset.content);
        }
    });
    fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(rows));
}

function serve(directory) {
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
    const server = http.createServer((request, response) => {
        const { pathname } = new URL(request.url, 'http://localhost');
        if (pathname === '/events') {
            // Live reload stays connected and silent.
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            response.write(': ready\n\n');
            return;
        }
        const filePath = path.join(directory, decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
        if (!filePath.startsWith(directory) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            response.writeHead(404);
            response.end();
            return;
        }
        response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(response);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => { server.closeAllConnections(); return new Promise((done) => server.close(done)); },
    })));
}

// World-space bounds of every visible non-text mesh under #chart (text labels
// are camera-facing billboards and legitimately overhang), the containment
// status, and which producer the Babia component reads.
function probeChart(table) {
    const el = document.querySelector('#chart');
    const THREE = window.AFRAME.THREE;
    const containment = el && el.components['codexr-chart-containment'];
    if (!el || !containment) {
        return null;
    }
    el.object3D.updateMatrixWorld(true);
    const isText = (object) => {
        for (let node = object; node && node !== el.object3D; node = node.parent) {
            if (node.el && (node.el.tagName === 'A-TEXT' || node.el.hasAttribute('text') || node.el.hasAttribute('troika-text'))) {
                return true;
            }
        }
        return false;
    };
    const box = new THREE.Box3();
    let meshes = 0;
    el.object3D.traverseVisible((object) => {
        if (!object.geometry || isText(object)) {
            return;
        }
        object.geometry.computeBoundingBox();
        const bounds = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
        if (Number.isFinite(bounds.min.x) && Number.isFinite(bounds.max.x)) {
            box.union(bounds);
            meshes += 1;
        }
    });
    const data = containment.data;
    const overhang = (min, max, center, size) => Math.max(0, (center - size / 2) - min, max - (center + size / 2));
    const component = Object.keys(el.components).find((name) => name.startsWith('babia-'));
    const status = containment.getChartStatus();
    return {
        meshes,
        from: component ? (el.getAttribute(component) || {}).from : null,
        offTableX: meshes ? overhang(box.min.x, box.max.x, data.anchorX, table.width) : 0,
        offTableZ: meshes ? overhang(box.min.z, box.max.z, data.anchorZ, table.depth) : 0,
        width: meshes ? box.max.x - box.min.x : 0,
        stabilized: !!(status && status.stabilized),
        reason: status && status.reason,
    };
}

async function checkScene(browser, chartId, rowCount, workRoot) {
    const directory = path.join(workRoot, `${chartId}-${rowCount}`);
    await generateScene(directory, chartId, rowCount);
    const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
    const budgeted = chartId !== 'boats';
    if (budgeted) {
        // CHARTS-6: the generated chart reads the row slice from its first build.
        assert.match(html, new RegExp(`id="${SLICE_ID}"`), `${chartId}: slice entity missing`);
        assert.match(html, new RegExp(`from: ${SLICE_ID};`), `${chartId}: chart does not read the slice`);
    }
    const server = await serve(directory);
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message || error)));
    try {
        await page.goto(server.url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('a-scene')?.hasLoaded, null, { timeout: 60000 });
        const started = Date.now();
        let probe = null;
        const sources = new Set();
        while (Date.now() - started < SETTLE_TIMEOUT_MS) {
            probe = await page.evaluate(probeChart, TABLE);
            if (probe && probe.from) {
                sources.add(probe.from);
            }
            if (probe && probe.meshes > 0 && probe.stabilized && Date.now() - started > 3000) {
                break;
            }
            await page.waitForTimeout(250);
        }
        const label = `${chartId} with ${rowCount} files`;
        assert.ok(probe && probe.meshes > 0, `${label}: nothing rendered`);
        assert.ok(probe.stabilized, `${label}: never stabilized (last reason ${probe.reason})`);
        assert.ok(probe.offTableX <= TOLERANCE_M && probe.offTableZ <= TOLERANCE_M,
            `${label}: ends off the table by x=${probe.offTableX.toFixed(3)} m, z=${probe.offTableZ.toFixed(3)} m`);
        if (budgeted) {
            assert.deepEqual([...sources], [SLICE_ID], `${label}: chart read ${[...sources].join(', ')}`);
        }
        assert.deepEqual(pageErrors, [], `${label}: page errors`);
        console.log(`[chart-bounds] ${label}: ok (width ${probe.width.toFixed(2)} m, settled in ${Date.now() - started} ms)`);
    } finally {
        await page.close();
        await server.close();
    }
}

async function main() {
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch {
        console.log('[chart-bounds] Playwright is not installed; skipped.');
        return;
    }
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-chart-bounds-'));
    const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
    try {
        for (const chartId of CHART_TYPES) {
            for (const rowCount of ROW_COUNTS) {
                await checkScene(browser, chartId, rowCount, workRoot);
            }
        }
    } finally {
        await browser.close();
        fs.rmSync(workRoot, { recursive: true, force: true });
    }
    console.log('[chart-bounds] Chart bounds harness passed.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
