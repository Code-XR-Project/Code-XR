/**
 * The controller view each analysis mode enters with when no view is named.
 *
 * One table for the extension host: the refresh coordinator (live sessions),
 * the export manifest (offline replay) and the collaboration message router
 * all read it. The browser keeps its own copy (`MODE_CONTROLLER_VIEW_BY_ID` in
 * the analysis-mode runtime); `test/analysis/controllerViewMapSync.test.cjs`
 * keeps the two in step.
 *
 * Deliberately pure, with zero imports: `exportManifest.ts` must stay
 * require()-able from `out/` without a vscode stub, and importing the
 * coordinator module would instantiate its singleton at load time.
 */
export const ANALYSIS_CONTROLLER_VIEW_BY_MODE: Readonly<Record<string, string>> = Object.freeze({
    selection: 'visualization-menu',
    single: 'single.mapping',
    'dependency-graph': 'dependency.settings',
    'historical-compare': 'historical.selection',
    'project-evolution': 'project-evolution',
});

/** The view an unknown mode falls back to: the single-analysis mapping panel. */
export const FALLBACK_CONTROLLER_VIEW = 'single.mapping';

export function defaultControllerView(mode: string): string {
    // Own-property lookup: a mode string such as "constructor" must fall back,
    // not resolve to an Object.prototype member.
    return Object.prototype.hasOwnProperty.call(ANALYSIS_CONTROLLER_VIEW_BY_MODE, mode)
        ? ANALYSIS_CONTROLLER_VIEW_BY_MODE[mode]
        : FALLBACK_CONTROLLER_VIEW;
}
