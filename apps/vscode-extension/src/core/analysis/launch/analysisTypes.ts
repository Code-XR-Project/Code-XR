/**
 * The in-scene analyses, one descriptor each.
 *
 * An analysis type is WHAT the table shows (classic, dependency graph,
 * historical comparison, project evolution, agent flow); a launch kind (launchKinds.ts)
 * is HOW a page is produced and served (XR, LivePanel, VisualizeDOM). Several
 * host tables used to restate these facts independently: which server
 * features each surface attaches (analysisServerCapabilities.ts), the view
 * each mode opens with (analysisViewModes.ts) and which cached room entity
 * makes a mode available (analysisMessageRouter.ts). They are now derived
 * from this list, so adding an analysis type starts with one entry here (see
 * apps/vscode-extension/docs/adding-an-analysis-type.md for the rest of the
 * checklist).
 *
 * Deliberately pure, with zero imports: `analysisViewModes.ts` reads it and
 * must stay require()-able from `out/` without a vscode stub.
 */

/** A launch surface, as `AnalysisMode` names it. */
export type LaunchKindId = 'XR' | 'LivePanel' | 'VisualizeDOM';

/** The server feature an analysis type needs attached (null: none). */
export type AnalysisServerFeature = 'dependencyGraph' | 'historicalComparison' | 'projectEvolution' | 'agentFlow';

export interface AnalysisSnapshotProbe {
    /** The room entity kind that carries this analysis's result. */
    entityKind: string;
    /** Whether a cached entity is enough to show the analysis at once. */
    isAvailable(snapshot: Record<string, unknown> | null | undefined): boolean;
}

export interface AnalysisTypeDescriptor {
    /** Also the coordinator mode and the in-scene runtime id. */
    id: string;
    label: string;
    /** The controller view the analysis opens with when none is named. */
    controllerView: string;
    /** The server feature it needs; null when it needs none (classic). */
    serverFeature: AnalysisServerFeature | null;
    /** The surfaces that serve it. */
    surfaces: ReadonlyArray<LaunchKindId>;
    /** How the router tells, from the room cache, that its result is ready. */
    snapshotProbe?: AnalysisSnapshotProbe;
}

export const ANALYSIS_TYPES: ReadonlyArray<AnalysisTypeDescriptor> = Object.freeze([
    {
        id: 'single',
        label: 'Classic analysis',
        controllerView: 'single.mapping',
        serverFeature: null,
        surfaces: ['XR', 'LivePanel'],
    },
    {
        id: 'dependency-graph',
        label: 'Dependency graph',
        controllerView: 'dependency.settings',
        serverFeature: 'dependencyGraph',
        surfaces: ['XR', 'LivePanel'],
        snapshotProbe: {
            entityKind: 'dependency-graph',
            isAvailable: (snapshot) => typeof snapshot?.datasetUrl === 'string',
        },
    },
    {
        id: 'historical-compare',
        label: 'Historical comparison',
        controllerView: 'historical.selection',
        serverFeature: 'historicalComparison',
        surfaces: ['XR', 'LivePanel'],
        snapshotProbe: {
            entityKind: 'historical-comparison',
            isAvailable: (snapshot) => !!snapshot?.result,
        },
    },
    {
        id: 'project-evolution',
        label: 'Project evolution',
        controllerView: 'project-evolution',
        serverFeature: 'projectEvolution',
        surfaces: ['XR'],
        snapshotProbe: {
            entityKind: 'project-evolution',
            isAvailable: (snapshot) => !!snapshot?.result,
        },
    },
    {
        // An AI coding agent at work, replayed or live on the table (docs/agent-flow/).
        id: 'agent-flow',
        label: 'Agent flow',
        controllerView: 'agent-flow',
        serverFeature: 'agentFlow',
        surfaces: ['XR'],
        snapshotProbe: {
            entityKind: 'agent-flow',
            isAvailable: (snapshot) => typeof snapshot?.datasetUrl === 'string',
        },
    },
]);

/** The menu every surface opens on; not an analysis itself. */
export const SELECTION_MODE = Object.freeze({ id: 'selection', controllerView: 'visualization-menu' });

export function getAnalysisType(id: string): AnalysisTypeDescriptor | undefined {
    return ANALYSIS_TYPES.find((type) => type.id === id);
}

/** The server features a surface must attach for the analyses it serves. */
export function getServerFeaturesForSurface(surface: string | undefined): Set<AnalysisServerFeature> {
    const features = new Set<AnalysisServerFeature>();
    for (const type of ANALYSIS_TYPES) {
        if (type.serverFeature && (type.surfaces as ReadonlyArray<string>).includes(surface ?? '')) {
            features.add(type.serverFeature);
        }
    }
    return features;
}
