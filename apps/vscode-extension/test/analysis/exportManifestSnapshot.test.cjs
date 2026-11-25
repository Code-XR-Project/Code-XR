const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    EXPORT_MANIFEST_FILE_NAME,
    buildExportManifest,
    relativizeExportArtifacts,
} = require('../../out/code_analysis/export/exportManifest.js');

// Characterization of buildExportManifest (ROADMAP W4-T19, CX-01): one
// whole-manifest snapshot per scenario, compared as serialized JSON so the
// key order and the entity order are pinned too (the runtimes iterate
// `entities` in order). Covers what exportManifest.test.cjs leaves open: the
// reasons for a server without the advanced modes, the legacy no-selection
// fallback, the replay-only reasons, the exported-source count, dropped git
// data, a kept controller view, and malformed or incomplete artifacts.
// `exportedAt` is the only normalized field.

const XR_CAPABILITIES = { dependencyGraph: true, historicalComparison: true, projectEvolution: true };

function selectedModes(overrides = {}) {
    const historicalComparison = overrides.historicalComparison ?? true;
    const projectEvolution = overrides.projectEvolution ?? true;
    return {
        cancelled: false,
        normal: true,
        dependencyGraph: overrides.dependencyGraph ?? true,
        historicalComparison,
        projectEvolution,
        gitTimeline: historicalComparison || projectEvolution,
    };
}

const temps = [];
function makeTempFolder() {
    const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-export-phases-')));
    temps.push(folder);
    return folder;
}

function writeJson(folder, relative, payload) {
    const filePath = path.join(folder, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

/** The same destination copy exportManifest.test.cjs builds: all three modes have artifacts. */
function buildFullFixture() {
    const folder = makeTempFolder();
    fs.writeFileSync(path.join(folder, 'xrChartMappingUiRuntime.js'), '// stale copy', 'utf8');
    writeJson(folder, 'dependencies/dependency-graph-2.json', { revision: 2, nodes: [] });
    writeJson(folder, 'dependencies/dependency-graph-3.json', { revision: 3, sourceRevision: 41, nodes: [] });
    writeJson(folder, 'comparison/revision-1.json', {
        revision: 1,
        left: { source: { label: 'v1.0.0' }, url: '/comparison/revision-1-left.json' },
        right: { source: { label: 'Working copy' }, url: '/comparison/revision-1-right.json' },
        generatedAt: '2026-07-29T00:00:00.000Z',
    });
    writeJson(folder, 'comparison/revision-2.json', {
        revision: 2,
        left: { source: { label: 'origin/main' }, url: '/comparison/revision-2-left.json' },
        right: { source: { label: 'Working copy' }, url: '/comparison/revision-2-right.json' },
        generatedAt: '2026-07-29T01:00:00.000Z',
    });
    writeJson(folder, 'evolution/revision-4/manifest.json', {
        revision: 4,
        manifestUrl: '/evolution/revision-4/manifest.json',
        frames: [{ index: 0, url: '/evolution/revision-4/data1.json' }],
    });
    return folder;
}

async function relativized(folder) {
    await relativizeExportArtifacts(folder);
    return folder;
}

const NO_CAPABILITIES = { dependencyGraph: false, historicalComparison: false, projectEvolution: false };
const TARGET = { name: 'demo', type: 'directory', analysisMode: 'XR' };

const gitDataOf = (overrides = {}) => ({
    references: {
        targetRelativePath: '',
        workingTreeDirty: false,
        activeBranch: 'main',
        pageSize: 5,
        sources: [
            { id: 'working-copy', kind: 'workingCopy', label: 'Working copy', payloadUrl: './git-revisions/working-copy.json', itemCount: 3 },
            { id: 'commit:abc', kind: 'gitRef', commitSha: 'abc123', label: 'abc', payloadUrl: './git-revisions/abc123.json', itemCount: 3 },
            { id: 'commit:def', kind: 'gitRef', commitSha: 'def456', label: 'def', payloadUrl: './git-revisions/def456.json', itemCount: 2 },
        ],
    },
    timelineSourceIds: ['commit:def', 'commit:abc', 'working-copy'],
    suggestedSourceIds: ['commit:abc', 'working-copy'],
    maxFrames: 24,
    analyzedRevisionCount: 3,
    ...overrides,
});

/** Artifacts the happy-path fixture lacks: unreadable, label-less and manifest-less entries. */
function buildEdgeFixture() {
    const folder = makeTempFolder();
    writeJson(folder, 'dependencies/dependency-graph-7.json', { revision: 7, nodes: [] });
    fs.writeFileSync(path.join(folder, 'dependencies', 'dependency-graph-8.json.bak'), '{}', 'utf8');
    fs.mkdirSync(path.join(folder, 'comparison'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'comparison', 'revision-5.json'), '{ not json', 'utf8');
    writeJson(folder, 'comparison/revision-3.json', { revision: 3 });
    writeJson(folder, 'comparison/revision-3-left.json', { ignored: true });
    writeJson(folder, 'evolution/revision-2/manifest.json', { revision: 2, frames: [] });
    fs.mkdirSync(path.join(folder, 'evolution', 'revision-9'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'evolution', 'revision-x'), { recursive: true });
    return folder;
}

const SCENARIOS = {
    'everything selected, the captured view and its controller view kept': async () => buildExportManifest(await relativized(buildFullFixture()), {
        target: TARGET,
        serverCapabilities: XR_CAPABILITIES,
        selectedModes: selectedModes(),
        viewState: { mode: 'historical-compare', controllerView: 'historical-compare.custom' },
    }),
    'a server without the advanced modes: every reason names it, the view falls back': async () => buildExportManifest(await relativized(buildFullFixture()), {
        target: { name: 'panel', type: 'file', analysisMode: 'LivePanel' },
        serverCapabilities: NO_CAPABILITIES,
        selectedModes: selectedModes(),
        viewState: { mode: 'dependency-graph', controllerView: 'dependency-graph.layout' },
    }),
    'legacy caller: no selection, so the server capabilities decide what is selected': async () => buildExportManifest(await relativized(buildFullFixture()), {
        target: TARGET,
        serverCapabilities: { dependencyGraph: false, historicalComparison: true, projectEvolution: true },
        viewState: { mode: 'project-evolution' },
    }),
    'replay only: artifacts without git data, a selection view kept': async () => buildExportManifest(await relativized(buildFullFixture()), {
        target: TARGET,
        serverCapabilities: XR_CAPABILITIES,
        selectedModes: selectedModes({ dependencyGraph: false }),
        gitDataSelected: true,
        viewState: { mode: 'selection' },
    }),
    'git data with an exported source count and a partial run without a skip list': async () => buildExportManifest(makeTempFolder(), {
        target: TARGET,
        serverCapabilities: XR_CAPABILITIES,
        selectedModes: selectedModes(),
        gitData: gitDataOf({
            partial: true,
            timelineSelection: { kind: 'latest', requestedCommitCount: 30, selectedCommitCount: 2, exportedCommitCount: 2, exportedSourceCount: 3 },
        }),
        gitDataSelected: true,
        viewState: { mode: 'project-evolution', controllerView: 'project-evolution.playback' },
    }),
    'git data with fewer than two timeline sources is dropped and the failure reason shown': async () => buildExportManifest(makeTempFolder(), {
        target: TARGET,
        serverCapabilities: XR_CAPABILITIES,
        selectedModes: selectedModes({ projectEvolution: false }),
        gitData: gitDataOf({ timelineSourceIds: ['working-copy'] }),
        gitDataSelected: true,
        gitDataFailureReason: 'Only one revision could be analysed.',
        viewState: { mode: 'historical-compare' },
    }),
    'dependency graph only: git data is not exported, the failure reason wins': async () => buildExportManifest(makeTempFolder(), {
        target: TARGET,
        serverCapabilities: XR_CAPABILITIES,
        selectedModes: selectedModes({ historicalComparison: false, projectEvolution: false }),
        gitData: gitDataOf(),
        gitDataSelected: false,
        dependencyGraphFailureReason: 'ignored: no dataset either way',
    }),
    'git data selected but absent: the default missing-data reason': async () => buildExportManifest(makeTempFolder(), {
        target: TARGET,
        serverCapabilities: XR_CAPABILITIES,
        selectedModes: selectedModes({ dependencyGraph: false }),
        gitDataSelected: true,
    }),
    'edge artifacts: unreadable and label-less comparisons, newest evolution without a manifest': async () => buildExportManifest(buildEdgeFixture(), {
        target: TARGET,
        serverCapabilities: XR_CAPABILITIES,
        selectedModes: selectedModes(),
        viewState: { mode: 'project-evolution', controllerView: 'project-evolution.playback' },
    }),
};

// Generated from the unchanged code (ca3eb871 + T01-T18), then reviewed.
const GOLDEN = {
    "everything selected, the captured view and its controller view kept": {
        "schemaVersion": 3,
        "kind": "codexr-export",
        "exportedAt": "<exportedAt>",
        "target": {
            "name": "demo",
            "type": "directory",
            "analysisMode": "XR"
        },
        "selectedModes": {
            "normal": true,
            "dependencyGraph": true,
            "historicalComparison": true,
            "projectEvolution": true
        },
        "capabilities": {
            "dependencyGraph": true,
            "dependencyGraphReason": "",
            "historicalComparison": true,
            "historicalComparisonReason": "Replay only: new comparisons need the live CodeXR session.",
            "projectEvolution": true,
            "projectEvolutionReason": "Replay only: generating a new movie needs the live CodeXR session."
        },
        "entities": [
            {
                "entityKind": "dependency-graph",
                "entityId": "main",
                "mode": "dependency-graph",
                "status": "ready",
                "message": "Exported dependency graph.",
                "datasetUrl": "./dependencies/dependency-graph-3.json",
                "revision": 3,
                "sourceRevision": 41
            },
            {
                "entityKind": "historical-comparison",
                "entityId": "main",
                "mode": "historical-compare",
                "resultUrl": "./comparison/revision-2.json"
            },
            {
                "entityKind": "project-evolution",
                "entityId": "main",
                "mode": "project-evolution",
                "resultUrl": "./evolution/revision-4/manifest.json"
            },
            {
                "entityKind": "analysis-view",
                "entityId": "main",
                "mode": "historical-compare",
                "controllerView": "historical-compare.custom",
                "status": "ready",
                "hasUsableSnapshot": true
            }
        ],
        "historicalComparison": {
            "comparisons": [
                {
                    "revision": 2,
                    "url": "./comparison/revision-2.json",
                    "leftLabel": "origin/main",
                    "rightLabel": "Working copy",
                    "generatedAt": "2026-07-29T01:00:00.000Z"
                },
                {
                    "revision": 1,
                    "url": "./comparison/revision-1.json",
                    "leftLabel": "v1.0.0",
                    "rightLabel": "Working copy",
                    "generatedAt": "2026-07-29T00:00:00.000Z"
                }
            ]
        }
    },
    "a server without the advanced modes: every reason names it, the view falls back": {
        "schemaVersion": 3,
        "kind": "codexr-export",
        "exportedAt": "<exportedAt>",
        "target": {
            "name": "panel",
            "type": "file",
            "analysisMode": "LivePanel"
        },
        "selectedModes": {
            "normal": true,
            "dependencyGraph": true,
            "historicalComparison": true,
            "projectEvolution": true
        },
        "capabilities": {
            "dependencyGraph": false,
            "dependencyGraphReason": "This analysis mode has no dependency graph.",
            "historicalComparison": false,
            "historicalComparisonReason": "No comparison was computed before export.",
            "projectEvolution": false,
            "projectEvolutionReason": "No evolution movie was generated before export."
        },
        "entities": [
            {
                "entityKind": "analysis-view",
                "entityId": "main",
                "mode": "single",
                "controllerView": "single.mapping",
                "status": "ready",
                "hasUsableSnapshot": true
            }
        ],
        "historicalComparison": {
            "comparisons": [
                {
                    "revision": 2,
                    "url": "./comparison/revision-2.json",
                    "leftLabel": "origin/main",
                    "rightLabel": "Working copy",
                    "generatedAt": "2026-07-29T01:00:00.000Z"
                },
                {
                    "revision": 1,
                    "url": "./comparison/revision-1.json",
                    "leftLabel": "v1.0.0",
                    "rightLabel": "Working copy",
                    "generatedAt": "2026-07-29T00:00:00.000Z"
                }
            ]
        }
    },
    "legacy caller: no selection, so the server capabilities decide what is selected": {
        "schemaVersion": 3,
        "kind": "codexr-export",
        "exportedAt": "<exportedAt>",
        "target": {
            "name": "demo",
            "type": "directory",
            "analysisMode": "XR"
        },
        "selectedModes": {
            "normal": true,
            "dependencyGraph": false,
            "historicalComparison": true,
            "projectEvolution": true
        },
        "capabilities": {
            "dependencyGraph": false,
            "dependencyGraphReason": "Not selected for this export.",
            "historicalComparison": true,
            "historicalComparisonReason": "Replay only: new comparisons need the live CodeXR session.",
            "projectEvolution": true,
            "projectEvolutionReason": "Replay only: generating a new movie needs the live CodeXR session."
        },
        "entities": [
            {
                "entityKind": "historical-comparison",
                "entityId": "main",
                "mode": "historical-compare",
                "resultUrl": "./comparison/revision-2.json"
            },
            {
                "entityKind": "project-evolution",
                "entityId": "main",
                "mode": "project-evolution",
                "resultUrl": "./evolution/revision-4/manifest.json"
            },
            {
                "entityKind": "analysis-view",
                "entityId": "main",
                "mode": "project-evolution",
                "controllerView": "project-evolution",
                "status": "ready",
                "hasUsableSnapshot": true
            }
        ],
        "historicalComparison": {
            "comparisons": [
                {
                    "revision": 2,
                    "url": "./comparison/revision-2.json",
                    "leftLabel": "origin/main",
                    "rightLabel": "Working copy",
                    "generatedAt": "2026-07-29T01:00:00.000Z"
                },
                {
                    "revision": 1,
                    "url": "./comparison/revision-1.json",
                    "leftLabel": "v1.0.0",
                    "rightLabel": "Working copy",
                    "generatedAt": "2026-07-29T00:00:00.000Z"
                }
            ]
        }
    },
    "replay only: artifacts without git data, a selection view kept": {
        "schemaVersion": 3,
        "kind": "codexr-export",
        "exportedAt": "<exportedAt>",
        "target": {
            "name": "demo",
            "type": "directory",
            "analysisMode": "XR"
        },
        "selectedModes": {
            "normal": true,
            "dependencyGraph": false,
            "historicalComparison": true,
            "projectEvolution": true
        },
        "capabilities": {
            "dependencyGraph": false,
            "dependencyGraphReason": "Not selected for this export.",
            "historicalComparison": true,
            "historicalComparisonReason": "Replay only: new comparisons need the live CodeXR session.",
            "projectEvolution": true,
            "projectEvolutionReason": "Replay only: generating a new movie needs the live CodeXR session."
        },
        "entities": [
            {
                "entityKind": "historical-comparison",
                "entityId": "main",
                "mode": "historical-compare",
                "resultUrl": "./comparison/revision-2.json"
            },
            {
                "entityKind": "project-evolution",
                "entityId": "main",
                "mode": "project-evolution",
                "resultUrl": "./evolution/revision-4/manifest.json"
            },
            {
                "entityKind": "analysis-view",
                "entityId": "main",
                "mode": "selection",
                "controllerView": "visualization-menu",
                "status": "ready",
                "hasUsableSnapshot": true
            }
        ],
        "historicalComparison": {
            "comparisons": [
                {
                    "revision": 2,
                    "url": "./comparison/revision-2.json",
                    "leftLabel": "origin/main",
                    "rightLabel": "Working copy",
                    "generatedAt": "2026-07-29T01:00:00.000Z"
                },
                {
                    "revision": 1,
                    "url": "./comparison/revision-1.json",
                    "leftLabel": "v1.0.0",
                    "rightLabel": "Working copy",
                    "generatedAt": "2026-07-29T00:00:00.000Z"
                }
            ]
        }
    },
    "git data with an exported source count and a partial run without a skip list": {
        "schemaVersion": 3,
        "kind": "codexr-export",
        "exportedAt": "<exportedAt>",
        "target": {
            "name": "demo",
            "type": "directory",
            "analysisMode": "XR"
        },
        "selectedModes": {
            "normal": true,
            "dependencyGraph": true,
            "historicalComparison": true,
            "projectEvolution": true
        },
        "capabilities": {
            "dependencyGraph": false,
            "dependencyGraphReason": "No dependency dataset was generated before export.",
            "historicalComparison": true,
            "historicalComparisonReason": "Offline comparisons: pick any two of the 3 exported sources. Partial export: 0 revision source(s) could not be prepared.",
            "projectEvolution": true,
            "projectEvolutionReason": "Offline movies from the 3 exported sources (Auto, Range or Manual). Partial export: 0 revision source(s) could not be prepared."
        },
        "entities": [
            {
                "entityKind": "analysis-view",
                "entityId": "main",
                "mode": "project-evolution",
                "controllerView": "project-evolution.playback",
                "status": "ready",
                "hasUsableSnapshot": true
            }
        ],
        "historicalComparison": {
            "comparisons": []
        },
        "gitData": {
            "references": {
                "targetRelativePath": "",
                "workingTreeDirty": false,
                "activeBranch": "main",
                "pageSize": 5,
                "sources": [
                    {
                        "id": "working-copy",
                        "kind": "workingCopy",
                        "label": "Working copy",
                        "payloadUrl": "./git-revisions/working-copy.json",
                        "itemCount": 3
                    },
                    {
                        "id": "commit:abc",
                        "kind": "gitRef",
                        "commitSha": "abc123",
                        "label": "abc",
                        "payloadUrl": "./git-revisions/abc123.json",
                        "itemCount": 3
                    },
                    {
                        "id": "commit:def",
                        "kind": "gitRef",
                        "commitSha": "def456",
                        "label": "def",
                        "payloadUrl": "./git-revisions/def456.json",
                        "itemCount": 2
                    }
                ]
            },
            "timelineSourceIds": [
                "commit:def",
                "commit:abc",
                "working-copy"
            ],
            "suggestedSourceIds": [
                "commit:abc",
                "working-copy"
            ],
            "maxFrames": 24,
            "analyzedRevisionCount": 3,
            "partial": true,
            "timelineSelection": {
                "kind": "latest",
                "requestedCommitCount": 30,
                "selectedCommitCount": 2,
                "exportedCommitCount": 2,
                "exportedSourceCount": 3
            }
        }
    },
    "git data with fewer than two timeline sources is dropped and the failure reason shown": {
        "schemaVersion": 3,
        "kind": "codexr-export",
        "exportedAt": "<exportedAt>",
        "target": {
            "name": "demo",
            "type": "directory",
            "analysisMode": "XR"
        },
        "selectedModes": {
            "normal": true,
            "dependencyGraph": true,
            "historicalComparison": true,
            "projectEvolution": false
        },
        "capabilities": {
            "dependencyGraph": false,
            "dependencyGraphReason": "No dependency dataset was generated before export.",
            "historicalComparison": false,
            "historicalComparisonReason": "No comparison was computed before export. Only one revision could be analysed.",
            "projectEvolution": false,
            "projectEvolutionReason": "Not selected for this export."
        },
        "entities": [
            {
                "entityKind": "analysis-view",
                "entityId": "main",
                "mode": "single",
                "controllerView": "single.mapping",
                "status": "ready",
                "hasUsableSnapshot": true
            }
        ],
        "historicalComparison": {
            "comparisons": []
        }
    },
    "dependency graph only: git data is not exported, the failure reason wins": {
        "schemaVersion": 3,
        "kind": "codexr-export",
        "exportedAt": "<exportedAt>",
        "target": {
            "name": "demo",
            "type": "directory",
            "analysisMode": "XR"
        },
        "selectedModes": {
            "normal": true,
            "dependencyGraph": true,
            "historicalComparison": false,
            "projectEvolution": false
        },
        "capabilities": {
            "dependencyGraph": false,
            "dependencyGraphReason": "ignored: no dataset either way",
            "historicalComparison": false,
            "historicalComparisonReason": "Not selected for this export.",
            "projectEvolution": false,
            "projectEvolutionReason": "Not selected for this export."
        },
        "entities": [],
        "historicalComparison": {
            "comparisons": []
        }
    },
    "git data selected but absent: the default missing-data reason": {
        "schemaVersion": 3,
        "kind": "codexr-export",
        "exportedAt": "<exportedAt>",
        "target": {
            "name": "demo",
            "type": "directory",
            "analysisMode": "XR"
        },
        "selectedModes": {
            "normal": true,
            "dependencyGraph": false,
            "historicalComparison": true,
            "projectEvolution": true
        },
        "capabilities": {
            "dependencyGraph": false,
            "dependencyGraphReason": "Not selected for this export.",
            "historicalComparison": false,
            "historicalComparisonReason": "No comparison was computed before export. The git timeline analysis produced no usable data.",
            "projectEvolution": false,
            "projectEvolutionReason": "No evolution movie was generated before export. The git timeline analysis produced no usable data."
        },
        "entities": [],
        "historicalComparison": {
            "comparisons": []
        }
    },
    "edge artifacts: unreadable and label-less comparisons, newest evolution without a manifest": {
        "schemaVersion": 3,
        "kind": "codexr-export",
        "exportedAt": "<exportedAt>",
        "target": {
            "name": "demo",
            "type": "directory",
            "analysisMode": "XR"
        },
        "selectedModes": {
            "normal": true,
            "dependencyGraph": true,
            "historicalComparison": true,
            "projectEvolution": true
        },
        "capabilities": {
            "dependencyGraph": true,
            "dependencyGraphReason": "",
            "historicalComparison": true,
            "historicalComparisonReason": "Replay only: new comparisons need the live CodeXR session.",
            "projectEvolution": false,
            "projectEvolutionReason": "No evolution movie was generated before export."
        },
        "entities": [
            {
                "entityKind": "dependency-graph",
                "entityId": "main",
                "mode": "dependency-graph",
                "status": "ready",
                "message": "Exported dependency graph.",
                "datasetUrl": "./dependencies/dependency-graph-7.json",
                "revision": 7
            },
            {
                "entityKind": "historical-comparison",
                "entityId": "main",
                "mode": "historical-compare",
                "resultUrl": "./comparison/revision-3.json"
            },
            {
                "entityKind": "analysis-view",
                "entityId": "main",
                "mode": "single",
                "controllerView": "single.mapping",
                "status": "ready",
                "hasUsableSnapshot": true
            }
        ],
        "historicalComparison": {
            "comparisons": [
                {
                    "revision": 3,
                    "url": "./comparison/revision-3.json",
                    "leftLabel": "",
                    "rightLabel": "",
                    "generatedAt": ""
                }
            ]
        }
    }
};

test.after(() => {
    for (const folder of temps) {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

for (const [name, run] of Object.entries(SCENARIOS)) {
    test(`manifest snapshot: ${name}`, async () => {
        const manifest = await run();
        assert.match(manifest.exportedAt, /^\d{4}-\d\d-\d\dT/);
        assert.equal(JSON.stringify({ ...manifest, exportedAt: '<exportedAt>' }), JSON.stringify(GOLDEN[name]));
    });
}

test('the manifest on disk is the returned manifest, pretty-printed', async () => {
    const folder = await relativized(buildFullFixture());
    const manifest = await buildExportManifest(folder, {
        target: TARGET,
        serverCapabilities: XR_CAPABILITIES,
        selectedModes: selectedModes(),
    });
    assert.equal(fs.readFileSync(path.join(folder, EXPORT_MANIFEST_FILE_NAME), 'utf8'), JSON.stringify(manifest, null, 2));
});

test('relativizeExportArtifacts: the edge rows of both rewriters (W4-T27 characterization)', async () => {
    const folder = makeTempFolder();
    writeJson(folder, 'comparison/revision-1.json', {
        left: { url: '/comparison/a-left.json' },
        right: { url: '//cdn.example/right.json' },
        generatedAt: 'x',
    });
    writeJson(folder, 'comparison/revision-2.json', { left: null, right: 'not an object', other: '/kept' });
    writeJson(folder, 'comparison/revision-3-left.json', { url: '/never/touched' });
    fs.writeFileSync(path.join(folder, 'comparison', 'revision-4.json'), '{ broken', 'utf8');
    writeJson(folder, 'evolution/revision-1/manifest.json', {
        manifestUrl: './already/relative.json',
        bridgeUrl: 42,
        frames: [null, { url: '/evolution/revision-1/data1.json' }, { label: 'no url' }, 'text'],
    });
    writeJson(folder, 'evolution/revision-2/manifest.json', { frames: 'not a list', bridgeUrl: '/b.json' });
    writeJson(folder, 'evolution/revision-3/manifest.json', { manifestUrl: 'relative.json' });
    fs.mkdirSync(path.join(folder, 'evolution', 'revision-4'), { recursive: true });
    writeJson(folder, 'evolution/notes/manifest.json', { manifestUrl: '/never/touched' });

    const raw = (relative) => fs.readFileSync(path.join(folder, relative), 'utf8');
    const untouched = [
        'comparison/revision-2.json',
        'comparison/revision-3-left.json',
        'evolution/revision-3/manifest.json',
        'evolution/notes/manifest.json',
    ];
    const before = Object.fromEntries(untouched.map((relative) => [relative, raw(relative)]));

    assert.equal(await relativizeExportArtifacts(folder), 3);
    assert.deepEqual(JSON.parse(raw('comparison/revision-1.json')), {
        left: { url: './comparison/a-left.json' },
        right: { url: '//cdn.example/right.json' },
        generatedAt: 'x',
    });
    assert.deepEqual(JSON.parse(raw('evolution/revision-1/manifest.json')), {
        manifestUrl: './already/relative.json',
        bridgeUrl: 42,
        frames: [null, { url: './evolution/revision-1/data1.json' }, { label: 'no url' }, 'text'],
    });
    assert.deepEqual(JSON.parse(raw('evolution/revision-2/manifest.json')), { frames: 'not a list', bridgeUrl: './b.json' });
    // Rewritten files are re-serialized with two-space indentation; the rest keep their bytes.
    assert.equal(raw('comparison/revision-1.json'), JSON.stringify(JSON.parse(raw('comparison/revision-1.json')), null, 2));
    for (const relative of untouched) {
        assert.equal(raw(relative), before[relative], relative);
    }
    assert.equal(raw('comparison/revision-4.json'), '{ broken');
    assert.equal(await relativizeExportArtifacts(folder), 0);
    assert.equal(await relativizeExportArtifacts(makeTempFolder()), 0);
});
