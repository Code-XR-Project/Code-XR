'use strict';

/**
 * What the user sees when an analysis is requested for a target that already
 * has a live session with the same mode, type and depth, observed at the
 * command entry point (AnalysisOrchestrator.orchestrateAnalysis) rather than
 * inside the registry: one status-specific warning, the "Open Active
 * Analyses" action for a finished analysis, the existing session re-announced,
 * and no launch. Run from out/ under the fake vscode.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require('../helpers/fakeVscode.cjs');

async function withOrchestrator(body) {
    const fake = createFakeVscode();
    const context = fakeExtensionContext();
    const workRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-orchestrator-')));
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            const { UnifiedSessionRegistry } = requireOut('core/analysis/session/sessionRegistry.js');
            const registry = UnifiedSessionRegistry.getInstance(context);
            const { AnalysisOrchestrator } = requireOut('core/analysis/analysisOrchestrator.js');
            const fired = [];
            registry.onSessionChanged((session) => fired.push(session.id));
            await body({ registry, AnalysisOrchestrator, fake, context, workRoot, fired });
        });
    } finally {
        context.cleanup();
        fs.rmSync(workRoot, { recursive: true, force: true });
    }
}

const SCENARIOS = [
    {
        status: 'creating',
        answer: undefined,
        message: { kind: 'warning', message: 'Analysis for "dup.ts" is already in progress (creating)...', items: [] },
        commands: [],
    },
    {
        status: 'analyzing',
        answer: undefined,
        message: { kind: 'warning', message: 'Analysis for "dup.ts" is already in progress (analyzing)...', items: [] },
        commands: [],
    },
    {
        status: 'monitoring',
        answer: 'Open Active Analyses',
        message: {
            kind: 'warning',
            message: 'Analysis already complete for "dup.ts". Use Active Analyses panel to view results.',
            items: ['Open Active Analyses'],
        },
        commands: ['workbench.view.extension.codeXRView'],
    },
    {
        status: 'monitoring',
        answer: undefined,
        message: {
            kind: 'warning',
            message: 'Analysis already complete for "dup.ts". Use Active Analyses panel to view results.',
            items: ['Open Active Analyses'],
        },
        commands: [],
    },
    {
        status: 'paused',
        answer: undefined,
        message: { kind: 'warning', message: 'Analysis session for "dup.ts" already exists with status: paused', items: [] },
        commands: [],
    },
];

for (const scenario of SCENARIOS) {
    const label = `${scenario.status}${scenario.answer ? `, answered "${scenario.answer}"` : ''}`;
    test(`orchestrating a duplicate (${label}): one warning, the session re-announced, nothing launched`, async () => {
        await withOrchestrator(async ({ registry, AnalysisOrchestrator, fake, context, workRoot, fired }) => {
            const target = path.join(workRoot, 'dup.ts');
            fs.writeFileSync(target, 'let a = 1;\n');
            const { session: existing } = await registry.createSession({ targetPath: target, analysisMode: 'XR', targetType: 'file', context });
            registry.updateSessionStatus(existing.id, scenario.status);
            fired.length = 0;
            if (scenario.answer) {
                fake.queueAnswer(scenario.answer);
            }

            await AnalysisOrchestrator.orchestrateAnalysis(target, 'XR', 'file', context, false);
            await new Promise((resolve) => setImmediate(resolve));

            assert.deepEqual(fake.messages, [scenario.message]);
            assert.deepEqual(fake.executedCommands.map((entry) => entry.id), scenario.commands);
            assert.deepEqual(fired, [existing.id]);
            assert.equal(registry.getAllSessions().length, 1);
            assert.equal(registry.getSession(existing.id).status, scenario.status);
        });
    });
}
