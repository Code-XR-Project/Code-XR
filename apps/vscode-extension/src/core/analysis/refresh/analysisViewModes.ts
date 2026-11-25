/**
 * The controller view each analysis mode enters with when no view is named.
 *
 * One table for the extension host: the refresh coordinator (live sessions),
 * the export manifest (offline replay) and the collaboration message router
 * all read it. It is derived from the analysis-type descriptors
 * (`core/analysis/launch/analysisTypes.ts`) plus the selection menu. The
 * browser keeps its own copy (`MODE_CONTROLLER_VIEW_BY_ID` in the
 * analysis-mode runtime); `test/analysis/controllerViewMapSync.test.cjs`
 * keeps the two in step.
 *
 * Deliberately pure (its only import is the pure descriptor list):
 * `exportManifest.ts` must stay require()-able from `out/` without a vscode
 * stub, and importing the coordinator module would instantiate its singleton
 * at load time.
 */
import { ANALYSIS_TYPES, SELECTION_MODE } from '../launch/analysisTypes';

export const ANALYSIS_CONTROLLER_VIEW_BY_MODE: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries([
        [SELECTION_MODE.id, SELECTION_MODE.controllerView],
        ...ANALYSIS_TYPES.map((type) => [type.id, type.controllerView]),
    ]),
);

/** The view an unknown mode falls back to: the single-analysis mapping panel. */
export const FALLBACK_CONTROLLER_VIEW = 'single.mapping';

export function defaultControllerView(mode: string): string {
    // Own-property lookup: a mode string such as "constructor" must fall back,
    // not resolve to an Object.prototype member.
    return Object.prototype.hasOwnProperty.call(ANALYSIS_CONTROLLER_VIEW_BY_MODE, mode)
        ? ANALYSIS_CONTROLLER_VIEW_BY_MODE[mode]
        : FALLBACK_CONTROLLER_VIEW;
}
