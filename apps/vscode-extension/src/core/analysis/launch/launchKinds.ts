/**
 * The launch surfaces, one descriptor each: HOW a page is produced and
 * served for a target. The orchestrator dispatches through this table
 * instead of a nested switch per mode and target type.
 *
 * Every kind runs the same transactional pipeline (launchPipeline.ts): the
 * descriptor only names its launcher per target type. The in-scene analyses a
 * surface offers are declared on the analysis types (analysisTypes.ts).
 */
import { UnifiedAnalysisSession, TargetType } from '../session/analysisSession';
import { LauncherLivePanel } from '../launchers/launcherLivePanel';
import { LauncherXRAnalysis } from '../launchers/launcherXRAnalysis';
import { LauncherVisualizeDOM } from '../launchers/launcherVisualizeDOM';
import { LaunchKindId } from './analysisTypes';
import type { CoreContext } from '../../host/hostPaths';

type Launch = (session: UnifiedAnalysisSession, context: CoreContext) => Promise<void>;

export interface LaunchKind {
    id: LaunchKindId;
    label: string;
    /** The launcher per supported target type; a missing entry is unsupported. */
    launchers: Readonly<Partial<Record<TargetType, Launch>>>;
}

export const LAUNCH_KINDS: Readonly<Record<LaunchKindId, LaunchKind>> = Object.freeze({
    XR: {
        id: 'XR',
        label: 'XR scene',
        launchers: {
            file: (session, context) => LauncherXRAnalysis.launchFileXRAnalysis(session, context),
            directory: (session, context) => LauncherXRAnalysis.launchDirectoryXRAnalysis(session, context),
        },
    },
    LivePanel: {
        id: 'LivePanel',
        label: 'LivePanel',
        launchers: {
            file: (session, context) => LauncherLivePanel.launchFileLivePanelAnalysis(session, context),
            directory: (session, context) => LauncherLivePanel.launchDirectoryLivePanelAnalysis(session, context),
        },
    },
    VisualizeDOM: {
        id: 'VisualizeDOM',
        label: 'DOM visualization',
        launchers: {
            file: (session, context) => LauncherVisualizeDOM.launchVisualizeDOMAnalysis(session, context),
        },
    },
});

/** The launcher for a kind and target type, or an error naming what is unsupported. */
export function resolveLauncher(kindId: string, targetType: TargetType): Launch {
    // Own-property lookup: a mode such as "constructor" must be refused, not
    // resolve to an Object.prototype member.
    const kind = Object.prototype.hasOwnProperty.call(LAUNCH_KINDS, kindId)
        ? (LAUNCH_KINDS as Record<string, LaunchKind>)[kindId]
        : undefined;
    if (!kind) {
        throw new Error(`Unknown analysis mode: ${kindId}`);
    }
    const launch = kind.launchers[targetType];
    if (!launch) {
        throw new Error(`${kind.label} analysis only supports ${Object.keys(kind.launchers).join(' and ')} targets, not ${targetType}`);
    }
    return launch;
}
