/**
 * Analysis-server capability resolution.
 *
 * Single source of truth for which optional, session-bound analysis services the
 * shared HTTP/HTTPS server should attach for a given analysis mode.
 *
 * Every analysis type — XR, LivePanel, VisualizeDOM, and any mode added later —
 * shares ONE launch path (`MultiServerLauncher` → `HttpServer`). The server core
 * (static file serving, SSE live-reload, collaboration) is identical for all of
 * them. The only per-mode difference is which feature services get wired in, and
 * that decision lives here and nowhere else.
 *
 * Some feature services are XR-only: their constructors resolve the session and
 * throw (`historical-comparison-session-unavailable`, etc.) if it is not an XR
 * session. Attaching them for a non-XR mode aborts the whole launch. Gating their
 * construction through this table is what lets the shared launch path succeed for
 * every mode.
 *
 * The table is DERIVED from the analysis-type descriptors
 * (`core/analysis/launch/analysisTypes.ts`): a surface attaches the feature of
 * every analysis type it serves. To add an analysis type, add its descriptor
 * there; to serve an existing one on another surface, list the surface in it.
 */
import { getServerFeaturesForSurface } from '../analysis/launch/analysisTypes';

export interface AnalysisServerCapabilities {
    /** Dependency-graph summary/refresh endpoints (XR + LivePanel). */
    dependencyGraph: boolean;
    /** Historical-comparison endpoints + live refresh (XR + LivePanel). */
    historicalComparison: boolean;
    /** Project-evolution endpoints (XR only). */
    projectEvolution: boolean;
    /** Agent Flow: agent session sources and the live trace dataset (XR only). */
    agentFlow: boolean;
}

/**
 * Resolve the feature services the shared server should attach for a mode.
 *
 * Unknown or undefined modes get no optional services: the server still launches
 * (static files + SSE + collaboration) but exposes no analysis feature endpoints,
 * which is the safe default for a brand-new mode until its capabilities are
 * declared in the analysis-type descriptors.
 */
export function resolveAnalysisServerCapabilities(
    analysisMode: string | undefined,
): AnalysisServerCapabilities {
    // A fresh object per call, so a caller can never mutate shared state.
    const features = getServerFeaturesForSurface(analysisMode);
    return {
        dependencyGraph: features.has('dependencyGraph'),
        historicalComparison: features.has('historicalComparison'),
        projectEvolution: features.has('projectEvolution'),
        agentFlow: features.has('agentFlow'),
    };
}
