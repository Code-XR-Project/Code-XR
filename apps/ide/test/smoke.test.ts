import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSmoke, type SmokeProbe, type TerminalProbe } from '../src/main/smoke.ts';

const healthy: SmokeProbe = {
    title: 'Code-XR',
    apiType: 'object',
    apiFrozen: true,
    apiKeys: ['app'],
    requireType: 'undefined',
    processType: 'undefined',
    evalBlocked: true,
    windowOpenBlocked: true,
    welcomeRendered: true,
    infoName: 'Code-XR IDE',
    infoError: null,
    explorerItems: ['scripts', 'src', 'test', 'package.json'],
    readFileKind: 'text',
    traversalRefused: true,
    gitStatusState: 'ok',
    trust: { before: 'unknown', shieldShown: true, restrictedGit: 'restricted', tasksRefused: true, debugRefused: true, after: 'trusted' },
    gitTraversalRefused: true,
    editorOpened: true,
    fileIconsShown: 9,
    fileIconsBroken: [],
    palette: { opened: true, hasSave: true, lineOffered: true, focusReturned: true },
    quickOpenFound: true,
    searchFound: true,
    editorStatus: 'Ln 1, Col 1 | Spaces: 2 | UTF-8 | LF | JSON',
    layout: { zen: true, resized: true, saved: true, sideBarToggled: true },
    tabs: { previewReplaced: true, kept: true, cycled: true, sessionSaved: true, closedAll: true },
    settings: { listed: true, applied: true, reset: true },
    keybindings: { opened: true, recorded: true, works: true, reset: true },
    theme: { previewed: true, reverted: true, stored: true },
    output: { shown: true, hasLines: true, switched: true, closed: true },
    problems: { shown: true, statusCounts: true },
    cspViolations: [],
};

const terminal: TerminalProbe = {
    opened: true,
    profile: 'bash',
    echoed: true,
    screen: ['$ echo codexr-smoke', 'codexr-smoke', '$'],
    status: 'Code-XR IDE 0.1.0',
    cspViolations: [],
    find: { opened: true, count: '1 of 2', closed: true },
    link: { hinted: true, opened: true, editorKept: true },
};

describe('evaluateSmoke', () => {
    it('fails when F1 does not open the command palette (#18)', () => {
        const result = evaluateSmoke({ ...healthy, palette: { ...healthy.palette, opened: false } }, true, 'linux', terminal);
        assert.equal(result.ok, false);
        assert.match(result.failures.join('\n'), /command palette/);
    });

    it('passes a healthy probe', () => {
        const result = evaluateSmoke(healthy, true, 'linux', terminal);
        assert.deepEqual(result.failures, []);
        assert.equal(result.ok, true);
    });

    const breakages: Array<[string, Partial<SmokeProbe>, RegExp]> = [
        ['Node reachable', { requireType: 'function' }, /require/],
        ['process reachable', { processType: 'object' }, /process/],
        ['no bridge', { apiType: 'undefined' }, /window\.codexr/],
        ['eval allowed', { evalBlocked: false }, /eval/],
        ['window.open allowed', { windowOpenBlocked: false }, /window\.open/],
        ['IPC broken', { infoName: null, infoError: 'Error: Refused.' }, /Refused/],
        ['blank page', { welcomeRendered: false }, /welcome/],
        ['empty explorer', { explorerItems: [] }, /explorer/],
        ['unreadable file', { readFileKind: null }, /readFile failed/],
        ['traversal allowed', { traversalRefused: false }, /out of the folder/],
        ['Source Control silent', { gitStatusState: null }, /git\.status did not answer/],
        ['Git ran in an untrusted folder (#177)', { trust: { before: 'unknown', shieldShown: true, restrictedGit: 'ok', tasksRefused: true, debugRefused: true, after: 'trusted' } }, /workspace trust did not gate Git/],
        ['a task ran in an untrusted folder (#176)', { trust: { before: 'unknown', shieldShown: true, restrictedGit: 'restricted', tasksRefused: false, debugRefused: true, after: 'trusted' } }, /workspace trust did not gate Git, tasks or debugging/],
        ['a debug session started in an untrusted folder (#180)', { trust: { before: 'unknown', shieldShown: true, restrictedGit: 'restricted', tasksRefused: true, debugRefused: false, after: 'trusted' } }, /did not gate Git, tasks or debugging/],
        ['trust not taken (#177)', { trust: { error: 'boom' } }, /workspace trust did not gate Git/],
        ['Source Control traversal allowed', { gitTraversalRefused: false }, /git\.headContent followed/],
        ['no editor', { editorOpened: false }, /Monaco/],
        ['no file icons', { fileIconsShown: 0 }, /no file icon/],
        ['broken file icons', { fileIconsBroken: ['python'] }, /did not load: python/],
        ['CSP violated', { cspViolations: ['style-src inline'] }, /CSP violations/],
    ];
    for (const [name, change, message] of breakages) {
        it(`fails when ${name}`, () => {
            const result = evaluateSmoke({ ...healthy, ...change }, true, 'linux', terminal);
            assert.equal(result.ok, false);
            assert.ok(result.failures.some((f) => message.test(f)), result.failures.join('; '));
        });
    }

    it('fails when navigation escaped the app', () => {
        assert.equal(evaluateSmoke(healthy, false, 'win32', terminal).ok, false);
    });

    it('fails when the renderer never answered', () => {
        assert.equal(evaluateSmoke(null, true, 'darwin', terminal).ok, false);
    });

    // #137
    const terminalBreakages: Array<[string, Partial<TerminalProbe> | null, RegExp]> = [
        ['the terminal probe never ran', null, /terminal probe did not run/],
        ['no terminal opened', { opened: false, status: 'Could not start a terminal: boom' }, /did not open a terminal.*boom/],
        ['echo printed nothing', { echoed: false }, /did not print the output of echo/],
        ['the terminal violated the CSP', { cspViolations: ['script-src inline'] }, /CSP violations in the terminal/],
        // #286
        ['Ctrl+F did not open the terminal find widget', { find: { opened: false, count: '', closed: false } }, /did not find in the terminal/],
        ['the find widget counted nothing', { find: { opened: true, count: 'No results', closed: true } }, /did not find in the terminal/],
        ['a file link did not open', { link: { hinted: true, opened: false, editorKept: false } }, /file link in the terminal did not open/],
        ['the terminal took Ctrl+F from the editor', { link: { hinted: true, opened: true, editorKept: false } }, /in the editor did not open the editor's find/],
    ];
    for (const [name, change, message] of terminalBreakages) {
        it(`fails when ${name}`, () => {
            const result = evaluateSmoke(healthy, true, 'linux', change ? { ...terminal, ...change } : null);
            assert.equal(result.ok, false);
            assert.ok(result.failures.some((f) => message.test(f)), result.failures.join('; '));
        });
    }
});
