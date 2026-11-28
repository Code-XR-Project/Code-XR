const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');

function readProjectFile(...segments) {
    return fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');
}

/**
 * Loads the real compiled `analysisServerCapabilities` module from `out/`
 * (npm test compiles first). Its only dependency is the pure analysis-type
 * descriptor list, so no `vscode` stub is needed: this exercises the shipped
 * resolver, derived from the descriptors, not a re-implementation of it.
 */
function loadCapabilitiesModule() {
    return require(path.join(projectRoot, 'out', 'core', 'server', 'analysisServerCapabilities.js'));
}

// ── Common server-launch capability gating ─────────────────────────────────
//
// Bug: the shared server core (HttpServer) eagerly constructed the XR-only
// feature services (HistoricalComparisonService, ProjectEvolutionService) for
// EVERY session that carried a sessionId. Those services resolve the session in
// their constructor and throw ('historical-comparison-session-unavailable' /
// 'project-evolution-session-unavailable') when it is not an XR session, so the
// whole server launch aborted for LivePanel — while XR, whose sessions satisfy
// the check, launched fine. VisualizeDOM only escaped by not exercising those
// endpoints. The fix routes every mode through ONE launch path and gates the
// optional services behind a single capability table, so LivePanel (and any
// future mode) launches with exactly the features it declares and nothing that
// would throw.

test('resolveAnalysisServerCapabilities grants XR every optional analysis service', () => {
    const { resolveAnalysisServerCapabilities } = loadCapabilitiesModule();

    assert.deepEqual(resolveAnalysisServerCapabilities('XR'), {
        dependencyGraph: true,
        historicalComparison: true,
        projectEvolution: true,
        agentFlow: true,
        drillDown: true,
    });
});

test('resolveAnalysisServerCapabilities grants LivePanel the dependency graph and historical comparison, never project evolution', () => {
    const { resolveAnalysisServerCapabilities } = loadCapabilitiesModule();

    const capabilities = resolveAnalysisServerCapabilities('LivePanel');
    assert.equal(capabilities.dependencyGraph, true, 'LivePanel must keep its dependency-graph summary');
    assert.equal(capabilities.historicalComparison, true, 'LivePanel exposes the historical comparison panel (v1.2.0)');
    assert.equal(capabilities.projectEvolution, false, 'project evolution is XR-only and throws for LivePanel');
    assert.equal(capabilities.agentFlow, false, 'agent flow is XR-only');
    assert.equal(capabilities.drillDown, false, 'drill-down is XR-only');
});

test('resolveAnalysisServerCapabilities grants VisualizeDOM no optional services so its shared launch stays clean', () => {
    const { resolveAnalysisServerCapabilities } = loadCapabilitiesModule();

    assert.deepEqual(resolveAnalysisServerCapabilities('VisualizeDOM'), {
        dependencyGraph: false,
        historicalComparison: false,
        projectEvolution: false,
        agentFlow: false,
        drillDown: false,
    });
});

test('resolveAnalysisServerCapabilities defaults unknown or missing modes to no services, so a new analysis type still launches its server', () => {
    const { resolveAnalysisServerCapabilities } = loadCapabilitiesModule();

    const expected = { dependencyGraph: false, historicalComparison: false, projectEvolution: false, agentFlow: false, drillDown: false };
    assert.deepEqual(resolveAnalysisServerCapabilities('SomeFutureMode'), expected);
    assert.deepEqual(resolveAnalysisServerCapabilities(undefined), expected);
    assert.deepEqual(resolveAnalysisServerCapabilities(''), expected);
});

test('resolveAnalysisServerCapabilities returns an independent object per call (no shared mutable capability state)', () => {
    const { resolveAnalysisServerCapabilities } = loadCapabilitiesModule();

    const first = resolveAnalysisServerCapabilities('LivePanel');
    first.dependencyGraph = false;
    const second = resolveAnalysisServerCapabilities('LivePanel');
    assert.equal(second.dependencyGraph, true, 'a mutated result must not leak into later resolutions');
});

test('the analysis host resolves capabilities from the session mode and gates every optional service behind them', () => {
    const httpServer = readProjectFile('src', 'core', 'server', 'analysis', 'analysisFeatureHost.ts');

    // Uses the single shared capability resolver, keyed off the real session mode.
    assert.match(httpServer, /import \{ resolveAnalysisServerCapabilities \} from '\.\.\/analysisServerCapabilities';/);
    assert.match(httpServer, /UnifiedSessionRegistry[\s\S]*\.getSession\(this\.config\.analysisSessionId\)/);
    assert.match(httpServer, /const capabilities = resolveAnalysisServerCapabilities\(session\?\.analysisMode\);/);

    // Each optional service is constructed only when its capability is granted.
    assert.match(httpServer, /if \(capabilities\.dependencyGraph\) \{[\s\S]*new DependencyGraphService\(/);
    assert.match(httpServer, /if \(capabilities\.historicalComparison\) \{[\s\S]*new HistoricalComparisonService\(/);
    assert.match(httpServer, /if \(capabilities\.projectEvolution\) \{[\s\S]*new ProjectEvolutionService\(/);
});

test('the analysis host no longer constructs the XR-only feature services unconditionally', () => {
    const httpServer = readProjectFile('src', 'core', 'server', 'analysis', 'analysisFeatureHost.ts');

    // The historical/project-evolution services must never be reachable without
    // first passing their capability gate — otherwise a non-XR launch throws.
    const historicalIndex = httpServer.indexOf('new HistoricalComparisonService(');
    const projectEvolutionIndex = httpServer.indexOf('new ProjectEvolutionService(');
    assert.ok(historicalIndex > -1 && projectEvolutionIndex > -1, 'both XR-only services should still exist');

    const historicalGate = httpServer.lastIndexOf('if (capabilities.historicalComparison)', historicalIndex);
    const projectEvolutionGate = httpServer.lastIndexOf('if (capabilities.projectEvolution)', projectEvolutionIndex);
    assert.ok(historicalGate > -1 && historicalGate < historicalIndex, 'HistoricalComparisonService must be behind its capability gate');
    assert.ok(projectEvolutionGate > -1 && projectEvolutionGate < projectEvolutionIndex, 'ProjectEvolutionService must be behind its capability gate');
});

test('The XR-only services still throw for non-XR sessions, so gating their construction is load-bearing, not cosmetic', () => {
    const historical = readProjectFile('src', 'core', 'history', 'historicalComparisonService.ts');
    const projectEvolution = readProjectFile('src', 'core', 'history', 'projectEvolutionService.ts');

    // Constructors resolve the session eagerly (this is what aborted the launch).
    assert.match(historical, /const session = this\.getSession\(\)[\s\S]*new GitRepositoryService\(session\.targetPath/);
    assert.match(projectEvolution, /const session = this\.getSession\(\)[\s\S]*new GitRepositoryService\([\s\S]*session\.targetPath/);

    // getSession() rejects anything that is not an XR session.
    assert.match(historical, /session\.analysisMode !== 'XR'[\s\S]*throw new Error\('historical-comparison-session-unavailable'\)/);
    assert.match(projectEvolution, /session\.analysisMode !== 'XR'[\s\S]*throw new Error\('project-evolution-session-unavailable'\)/);
});

test('DependencyGraphService is safe to attach for LivePanel: it never throws in its constructor and reports availability instead', () => {
    const dependency = readProjectFile('src', 'core', 'dependencies', 'dependencyGraphService.ts');

    // No eager getSession() in the constructor (contrast with the XR-only services).
    const constructorBlock = dependency.slice(
        dependency.indexOf('public constructor('),
        dependency.indexOf('public getAvailability('),
    );
    assert.equal(constructorBlock.includes('getSession('), false, 'the dependency-graph constructor must not resolve the session');

    // Availability is a graceful gate covering both XR and LivePanel.
    assert.match(dependency, /analysisMode !== 'XR' && session\.analysisMode !== 'LivePanel'/);
});
