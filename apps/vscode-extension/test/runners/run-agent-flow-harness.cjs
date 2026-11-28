/**
 * Agent Flow harness runner: serves the extension folder, opens
 * test/manual/agent-flow-harness.html in Playwright Chromium and checks that
 * the scene builds from the sample session (one building per file, a
 * timeline, a playhead that advances while playing, follow-live appends),
 * taking screenshots on the way.
 *
 *   node test/runners/run-agent-flow-harness.cjs            run the scenario
 *   node test/runners/run-agent-flow-harness.cjs --serve    only serve the page
 *
 * Screenshots go to $AGENT_FLOW_SHOT_DIR when set, else
 * output/agent-flow-harness/screenshots.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { launchHarnessChromium, VENDOR } = require('../helpers/harnessBrowser.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const samplePath = path.join(projectRoot, 'test', 'manual', 'agent-flow', 'sample-dataset.json');
const outputRoot = path.join(projectRoot, 'output', 'agent-flow-harness');
const screenshotRoot = process.env.AGENT_FLOW_SHOT_DIR
    ? path.resolve(process.env.AGENT_FLOW_SHOT_DIR)
    : path.join(outputRoot, 'screenshots');

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
};

function createServer() {
    return http.createServer((request, response) => {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        const filePath = path.normalize(path.join(projectRoot, decodeURIComponent(requestUrl.pathname)));
        if (!filePath.startsWith(projectRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('not found');
            return;
        }
        response.writeHead(200, {
            'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
            'cache-control': 'no-store',
        });
        fs.createReadStream(filePath).pipe(response);
    });
}

function listen(server, port = 0) {
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function snapshot(page) {
    return page.evaluate(() => window.CodeXRAgentFlowHarness.snapshot());
}

async function waitFor(page, predicate, arg, timeout = 15000) {
    await page.waitForFunction(predicate, arg, { timeout, polling: 100 });
}

async function shot(page, name) {
    const file = path.join(screenshotRoot, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`[agent-flow-harness] screenshot ${file}`);
}

/** A-Frame's text font comes from its CDN; the harness router aborts it, so answer it from the vendor copy. */
async function routeFonts(page) {
    await page.route(/cdn\.aframe\.io\/fonts\/Roboto-msdf\.(json|png)/, (route) => {
        const name = route.request().url().endsWith('.png') ? 'Roboto-msdf.png' : 'Roboto-msdf.json';
        return route.fulfill({ path: path.join(VENDOR, 'fonts', name) });
    });
}

async function runScenario(browser, port) {
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const logs = [];
    fs.mkdirSync(outputRoot, { recursive: true });
    const logFile = path.join(outputRoot, 'browser-console.log');
    fs.writeFileSync(logFile, '', 'utf8');
    const log = (line) => { logs.push(line); fs.appendFileSync(logFile, `${line}\n`, 'utf8'); };
    page.on('console', (message) => log(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => log(`pageerror: ${error.message}\n${error.stack || ''}`));
    await routeFonts(page);
    await page.goto(`http://127.0.0.1:${port}/test/manual/agent-flow-harness.html?bust=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await waitFor(page, () => window.CodeXRAgentFlowRuntime?.getState?.().active === true && window.CodeXRAgentFlowRuntime.getState().sources > 0);
    await page.evaluate(() => window.CodeXRAgentFlowHarness.hideControls());
    await page.evaluate(() => window.CodeXRAgentFlowHarness.camera('overview'));
    await sleep(800);

    // Idle: the table asks for a session; the controller lists them.
    let state = await snapshot(page);
    assert.equal(state.hint, 'Pick an agent session in the controller');
    assert.equal(state.sources, 5);
    assert.deepEqual(state.modeOptions.at(-1), { id: 'agent-flow', disabled: false, color: '#10b981' }, 'enabled once capabilities.agentFlow arrives');
    assert.ok(state.sent.includes('agent-flow-sources-request'), 'activation asks for the sources');
    assert.equal(state.panel, true, 'the controller view is registered');
    await shot(page, '01-idle-hint');

    // Open the sample session through the room protocol.
    await page.evaluate(() => window.CodeXRAgentFlowHarness.openSample());
    await waitFor(page, () => window.CodeXRAgentFlowRuntime.getState().steps > 0);
    await sleep(600);
    state = await snapshot(page);
    assert.ok(state.sent.includes('agent-flow-open'));
    assert.equal(state.files, sample.files.length);
    assert.equal(state.buildings, sample.files.length, 'one instanced building per file');
    assert.equal(state.steps, sample.steps.length);
    assert.equal(state.turns, sample.turns.length);
    assert.equal(state.stepIndex, sample.steps.length - 1, 'a session opens on its end state');
    assert.ok(state.timelineTicks >= sample.steps.length, 'one timeline tick per step');
    assert.equal(state.hint, '');
    assert.equal(state.actors, sample.actors.length, 'one worker lane per actor');
    assert.ok(state.workers.length >= 1, 'the main worker stands on the table');
    assert.ok(state.trailPoints > 2, 'the trail is drawn');

    const lookAtLocal = (point, offset) => page.evaluate(([p, o]) => window.CodeXRAgentFlowHarness.lookAtLocal(p, o), [point, offset]);
    const stepTo = async (index, settleMs) => {
        await page.evaluate((i) => { window.CodeXRAgentFlowRuntime.seek(i - 1); }, index);
        await sleep(300);
        await page.evaluate(() => { window.CodeXRAgentFlowRuntime.stepForward(); });
        await waitFor(page, (i) => window.CodeXRAgentFlowRuntime.getState().stepIndex === i, index, 10000);
        // Software GL runs at a few frames a second: wait for the hop to land.
        await waitFor(page, () => !window.CodeXRAgentFlowRuntime.getState().moving, undefined, 15000);
        await sleep(settleMs);
        return snapshot(page);
    };
    const fileTop = (suffix) => page.evaluate((s) => {
        const view = window.CodeXRAgentFlowRuntime.__testing.getView();
        const index = view.files.findIndex((file) => file.path === s || file.path.endsWith('/' + s));
        return { index, ...view.city.getBuildingTop(index), h: view.city.getHeight(index) };
    }, suffix);

    // (a) Overview mid-session: the main worker and both subagents busy at once.
    state = await stepTo(7, 700);
    const busy = state.workers.filter((worker) => worker.active);
    assert.equal(busy.length, 3, 'three workers active at once');
    await shot(page, '02-overview-three-workers');

    // Playing advances the playhead.
    await page.evaluate(() => { window.CodeXRAgentFlowRuntime.seek(-1); window.CodeXRAgentFlowRuntime.setSpeed(4); window.CodeXRAgentFlowRuntime.play(); });
    // Software WebGL renders a few frames a second at this size: wait on the
    // playhead rather than on the clock.
    await waitFor(page, () => window.CodeXRAgentFlowRuntime.getState().stepIndex >= 2, undefined, 20000);
    state = await snapshot(page);
    assert.equal(state.playing, true, 'still playing mid-session');
    await page.evaluate(() => { window.CodeXRAgentFlowRuntime.pause(); window.CodeXRAgentFlowRuntime.setSpeed(1); });

    // A search: radar ripple and violet beacons on the matches.
    state = await stepTo(24, 500);
    assert.equal(state.workers[0].kind, 'search');
    await shot(page, '03-search-radar');

    // (c) A write: scaffolding, a crane and new orange floors.
    const edited = await fileTop('tooltipsAndSelection.js');
    await lookAtLocal(edited, { x: 0.75, y: 0.75, z: 1.05 });
    state = await stepTo(15, 1400);
    assert.ok(state.scaffolds >= 1, 'scaffolding wraps the written building');
    assert.equal(state.workers[0].kind, 'write');
    await shot(page, '04-write-scaffold');

    // A created file rises from its foundation inside scaffolding.
    const created = await fileTop('test/analysis/dependencyGraphTooltip.test.cjs');
    // The created file stands in the right-hand strip: look from the open side.
    await lookAtLocal({ x: created.x, y: created.y + 0.15, z: created.z }, { x: 0.95, y: 0.55, z: 0.75 });
    state = await stepTo(18, 900);
    assert.ok(state.scaffolds >= 1);
    await shot(page, '05-create-foundation');

    // Permission wait: the worker holds up an amber "!".
    state = await stepTo(19, 700);
    assert.equal(state.workers[0].kind, 'wait');
    await shot(page, '06-permission-wait');

    // (b) The test tower: a failing run, red siren and warning tape.
    await lookAtLocal({ x: -2.78, y: 0.3, z: 1.2 }, { x: 1.0, y: 0.55, z: 1.25 });
    state = await stepTo(20, 1800);
    assert.equal(state.tower, 'failed');
    assert.ok(state.hazards.warning >= 1, 'red tape on the files written in the turn');
    await shot(page, '07-test-tower-failure');
    await page.evaluate(() => window.CodeXRAgentFlowHarness.camera('overview'));
    await sleep(500);
    await shot(page, '08-test-tower-failure-overview');

    // End of session: Heat + Blast radius (unread dependents in amber tape).
    await page.evaluate(() => {
        window.CodeXRAgentFlowHarness.camera('overview');
        window.CodeXRAgentFlowRuntime.seek(1000);
        window.CodeXRAgentFlowRuntime.setToggle('heat', true);
        window.CodeXRAgentFlowRuntime.setToggle('blast', true);
    });
    await sleep(900);
    state = await snapshot(page);
    assert.equal(state.stepIndex, sample.steps.length - 1);
    assert.ok(state.deltaCaps > 0, 'delta caps on the written buildings');
    assert.equal(state.unreadDependents, sample.metrics.unreadDependents, 'unread dependents counted');
    assert.equal(state.hazards.unread, sample.metrics.unreadDependents, 'unread dependents taped');
    assert.equal(state.hazards.blind, sample.metrics.blindWrites, 'blind writes striped');
    await shot(page, '09-heat-blast-end');

    // Turn rings: one stacked ring per turn a file was touched in.
    await page.evaluate(() => {
        window.CodeXRAgentFlowRuntime.setToggle('heat', false);
        window.CodeXRAgentFlowRuntime.setToggle('blast', false);
        window.CodeXRAgentFlowRuntime.setToggle('rings', true);
        window.CodeXRAgentFlowHarness.camera('closeup');
    });
    await sleep(700);
    state = await snapshot(page);
    const expectedRings = sample.files.reduce((sum, file) => sum + file.turns.length, 0);
    assert.equal(state.turnRings, expectedRings);
    await shot(page, '10-turn-rings');
    await page.evaluate(() => window.CodeXRAgentFlowRuntime.setToggle('rings', false));

    // (d) The controller panel.
    await page.evaluate(() => { window.CodeXRAgentFlowRuntime.seek(7); window.CodeXRAgentFlowHarness.camera('panel'); });
    await sleep(700);
    await shot(page, '11-controller-panel');

    // Follow live: a newer revision with three more steps animates them in.
    await page.evaluate(() => { window.CodeXRAgentFlowHarness.camera('overview'); window.CodeXRAgentFlowRuntime.seek(1000); });
    await sleep(300);
    await page.evaluate(() => window.CodeXRAgentFlowHarness.liveAppend());
    await waitFor(page, (count) => window.CodeXRAgentFlowRuntime.getState().stepIndex === count - 1, sample.steps.length + 3, 10000);
    state = await snapshot(page);
    assert.equal(state.steps, sample.steps.length + 3);
    assert.equal(state.live, true);
    assert.equal(state.buildings, sample.files.length, 'same layout: no rebuild');
    await sleep(500);
    await shot(page, '12-live-follow');

    const errors = logs.filter((line) => line.startsWith('pageerror') || (line.startsWith('error') && /AgentFlow|agentFlow/.test(line)));
    assert.deepEqual(errors, [], 'no page errors');
    console.log(`[agent-flow-harness] OK: ${state.buildings} buildings, ${state.steps} steps, screenshots in ${screenshotRoot}`);
}

/**
 * The repository's Playwright may be newer or older than the browsers
 * installed on the machine; when its own build is missing, fall back to the
 * newest headless shell under PLAYWRIGHT_BROWSERS_PATH.
 */
async function launchChromium(chromium) {
    try {
        return await launchHarnessChromium(chromium);
    } catch (error) {
        const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
        if (!/Executable doesn't exist/.test(String(error?.message)) || !browsersRoot || !fs.existsSync(browsersRoot)) {
            throw error;
        }
        const candidates = fs.readdirSync(browsersRoot)
            .filter((name) => /^chromium_headless_shell-\d+$/.test(name))
            .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
            .map((name) => path.join(browsersRoot, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell'))
            .filter((file) => fs.existsSync(file));
        if (!candidates.length) { throw error; }
        console.log(`[agent-flow-harness] using ${candidates[0]}`);
        return launchHarnessChromium(chromium, { executablePath: candidates[0] });
    }
}

async function main() {
    const serveOnly = process.argv.includes('--serve');
    require('../manual/buildAssembledRuntimes.cjs').buildAssembledRuntimes();
    fs.mkdirSync(screenshotRoot, { recursive: true });
    const server = createServer();
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/test/manual/agent-flow-harness.html`;
    try {
        if (serveOnly) {
            console.log(`[agent-flow-harness] serving ${url}`);
            await new Promise((resolve) => { process.on('SIGINT', resolve); process.on('SIGTERM', resolve); });
            return;
        }
        let chromium;
        try {
            ({ chromium } = require('playwright'));
        } catch {
            console.log(`[agent-flow-harness] Playwright is not installed; open ${url} with --serve.`);
            return;
        }
        const browser = await launchChromium(chromium);
        try {
            await runScenario(browser, port);
        } catch (error) {
            const logFile = path.join(outputRoot, 'browser-console.log');
            console.error(`[agent-flow-harness] failed; browser console in ${logFile}`);
            throw error;
        } finally {
            await browser.close();
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
