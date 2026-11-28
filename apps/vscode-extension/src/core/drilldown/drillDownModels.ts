/**
 * Drill-down (#333): jumping from the analysis on the XR table to the analysis
 * of one of its files or folders, in place, on the same server. Zero imports,
 * so the IDE and the tests can load it anywhere.
 */

/** What the table can be drilled into. */
export type DrillTargetKind = 'directory' | 'file';

/**
 * A place in the project: a folder or a file, relative to the boundary root
 * (forward slashes, '' for the root itself, which is always a directory).
 */
export interface DrillTarget {
    readonly kind: DrillTargetKind;
    readonly relativePath: string;
}

/** One link of the breadcrumb bar. */
export interface DrillCrumb {
    readonly kind: DrillTargetKind;
    readonly relativePath: string;
    /** What the crumb says: the folder or file name, the root's own name for ''. */
    readonly label: string;
    /** The crumb is the session's own analysis (the "home" of the history). */
    readonly home: boolean;
}

export type DrillStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The corner controller's schema for a target of the other kind than the
 * session's (a file drilled from a folder analysis): the same keys the mapping
 * UI reads from its embedded config (templateProcessor's MappingUiSchema).
 */
export interface DrillControllerSchema {
    readonly chartId: string;
    readonly targetType: DrillTargetKind;
    readonly dimensions: readonly unknown[];
    readonly availableCharts: readonly unknown[];
    readonly dimensionsByChart: Readonly<Record<string, unknown>>;
    readonly defaultMappingsByChart: Readonly<Record<string, unknown>>;
}

/** The `drill-down` server entity: everything the scene needs to draw the bar and the chart. */
export interface DrillDownEntity {
    readonly entityKind: 'drill-down';
    readonly entityId: 'main';
    readonly mode: 'drill-down';
    readonly status: DrillStatus;
    /** Bumps on every change, so a stale snapshot is recognisable. */
    readonly revision: number;
    /** What is on the table (the home target while the classic analysis is shown). */
    readonly target: DrillTarget;
    /** Absolute path of the target, in the scene's spelling (forward slashes, no drive). */
    readonly targetPath: string;
    /** The session's own target, its absolute path and its breadcrumb. */
    readonly homeKind: DrillTargetKind;
    readonly homeRelativePath: string;
    readonly homePath: string;
    readonly homeCrumbs: readonly DrillCrumb[];
    /** True while the table shows the session's own analysis. */
    readonly atHome: boolean;
    /** What is being analysed while status is 'loading'. */
    readonly pending: DrillTarget | null;
    readonly crumbs: readonly DrillCrumb[];
    readonly canBack: boolean;
    readonly canForward: boolean;
    /** Name of the boundary root, for the first crumb. */
    readonly rootLabel: string;
    /** The boundary root in the scene's spelling, to tell which picks are inside. */
    readonly rootPath: string;
    /** The dataset of the current target, served by this server; null at home. */
    readonly datasetUrl: string | null;
    /** Babia chart id the drilled view is drawn with ('boats' by default). */
    readonly chartId: string;
    /** Dimension → field mapping for that chart and target kind. */
    readonly mapping: Readonly<Record<string, string>>;
    /**
     * The controller's charts and fields when the target's kind differs from
     * the session's; null when the session's own controller fits (home, same kind).
     */
    readonly controllerSchema: DrillControllerSchema | null;
    /** Path field the boats tree splits ('filePath' for folders, 'treePath' for files). */
    readonly treeField: string;
    /** Rows in the current dataset. */
    readonly rowCount: number;
    /** Files sent to Python for this view, and files whose cached result (same hash) was reused. */
    readonly analyzedCount: number;
    readonly reusedCount: number;
    /** Where the data came from: entirely from the cache, or partly from a fresh Python run. */
    readonly source: 'home' | 'cache' | 'analysis' | null;
    /** Error or progress text for the bar. */
    readonly message: string;
    /** When the pending analysis started (ms since epoch), for the elapsed counter. */
    readonly startedAt: number | null;
}

/** Room messages the bridge answers (drillDownBridge.ts). */
export const DRILL_DOWN_MESSAGES = Object.freeze({
    open: 'drilldown-open',
    back: 'drilldown-back',
    forward: 'drilldown-forward',
    goto: 'drilldown-goto',
    home: 'drilldown-home',
    state: 'drilldown-state-request',
    error: 'drilldown-error',
});

/** The browser runtime id and coordinator mode of the drilled view. */
export const DRILL_DOWN_MODE = 'drill-down';
