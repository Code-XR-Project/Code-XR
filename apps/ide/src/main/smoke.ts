import type { BrowserWindow } from 'electron';
import { APP_ORIGIN, originOf } from './security.ts';

/**
 * `--codexr-smoke`: start the IDE hidden, probe the security baseline from
 * inside the real renderer, print one result line and exit. Run by
 * `npm run ide:smoke` and by CI on Windows, macOS and Linux, so "it opens a
 * window on all three" is checked rather than claimed.
 */
export const SMOKE_FLAG = '--codexr-smoke';
export const SMOKE_RESULT_PREFIX = 'CODEXR_SMOKE_RESULT ';

export interface SmokeProbe {
    readonly title: string;
    readonly apiType: string;
    readonly apiFrozen: boolean;
    readonly apiKeys: readonly string[];
    readonly requireType: string;
    readonly processType: string;
    readonly evalBlocked: boolean;
    readonly windowOpenBlocked: boolean;
    readonly welcomeRendered: boolean;
    readonly infoName: string | null;
    readonly infoError: string | null;
    /** #14: names in the explorer's first level for the folder opened with --folder=. */
    readonly explorerItems: readonly string[];
    readonly readFileKind: string | null;
    readonly traversalRefused: boolean;
}

export interface SmokeResult {
    readonly ok: boolean;
    readonly failures: readonly string[];
    readonly probe: SmokeProbe | null;
    readonly navigationBlocked: boolean;
    readonly platform: string;
}

// Runs in the renderer's main world. Plain JS on purpose: it is sent as a string.
const RENDERER_PROBE = `(async () => {
    const until = Date.now() + 10000;
    while (!document.querySelector('[data-testid="welcome"][data-ready="true"]') && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 50));
    }
    let evalBlocked = false;
    try { eval('1'); } catch { evalBlocked = true; }
    let infoName = null, infoError = null;
    try { infoName = (await window.codexr.app.getInfo()).name; } catch (e) { infoError = String(e); }
    const treeUntil = Date.now() + 10000;
    while (!document.querySelector('[data-testid="explorer-tree"] [role="treeitem"]') && Date.now() < treeUntil) {
        await new Promise((r) => setTimeout(r, 50));
    }
    const explorerItems = [...document.querySelectorAll('[data-testid="explorer-tree"] > li > [role="treeitem"]')].map((row) => row.textContent);
    let readFileKind = null;
    try { readFileKind = (await window.codexr.workspace.readFile('package.json')).kind; } catch { readFileKind = null; }
    let traversalRefused = false;
    try { await window.codexr.workspace.readFile('../package.json'); } catch { traversalRefused = true; }
    return {
        title: document.title,
        apiType: typeof window.codexr,
        apiFrozen: Object.isFrozen(window.codexr) && Object.isFrozen(window.codexr.app) && Object.isFrozen(window.codexr.workspace),
        apiKeys: Object.keys(window.codexr || {}),
        requireType: typeof window.require,
        processType: typeof window.process,
        evalBlocked,
        windowOpenBlocked: window.open('https://example.com/') === null,
        welcomeRendered: !!document.querySelector('[data-testid="welcome"][data-ready="true"]'),
        infoName,
        infoError,
        explorerItems,
        readFileKind,
        traversalRefused,
    };
})()`;

/** Pure: turns what was observed into a verdict. */
export function evaluateSmoke(probe: SmokeProbe | null, navigationBlocked: boolean, platform: string): SmokeResult {
    const failures: string[] = [];
    if (!probe) {
        failures.push('renderer probe did not run');
    } else {
        if (probe.title !== 'Code-XR') { failures.push(`unexpected title "${probe.title}"`); }
        if (probe.apiType !== 'object') { failures.push('window.codexr is missing'); }
        if (!probe.apiFrozen) { failures.push('window.codexr is not frozen'); }
        if (probe.requireType !== 'undefined') { failures.push('require is reachable from the renderer'); }
        if (probe.processType !== 'undefined') { failures.push('process is reachable from the renderer'); }
        if (!probe.evalBlocked) { failures.push('eval is not blocked by the CSP'); }
        if (!probe.windowOpenBlocked) { failures.push('window.open is not blocked'); }
        if (!probe.welcomeRendered) { failures.push('the welcome view did not render'); }
        if (probe.infoName !== 'Code-XR IDE') { failures.push(`IPC app.getInfo failed: ${probe.infoError ?? probe.infoName}`); }
        if (!probe.explorerItems.includes('src') || !probe.explorerItems.includes('package.json')) {
            failures.push(`the explorer did not list the smoke folder (got ${JSON.stringify(probe.explorerItems)})`);
        }
        if (probe.readFileKind !== 'text') { failures.push(`workspace.readFile failed (got ${String(probe.readFileKind)})`); }
        if (!probe.traversalRefused) { failures.push('workspace.readFile followed a path out of the folder'); }
    }
    if (!navigationBlocked) { failures.push('navigation to an external URL was not blocked'); }
    return { ok: failures.length === 0, failures, probe, navigationBlocked, platform };
}

export async function runSmoke(win: BrowserWindow, expectedOrigins: ReadonlySet<string>): Promise<SmokeResult> {
    const contents = win.webContents;
    let probe: SmokeProbe | null = null;
    try {
        probe = (await contents.executeJavaScript(RENDERER_PROBE)) as SmokeProbe;
    } catch {
        probe = null;
    }

    // Try to leave the app from inside the page, then check where it is.
    await contents.executeJavaScript(`location.href = 'https://example.com/'; true`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const origin = originOf(contents.getURL());
    const navigationBlocked = origin !== null && (expectedOrigins.has(origin) || origin === APP_ORIGIN);

    return evaluateSmoke(probe, navigationBlocked, process.platform);
}
