import {
    CollaborationApplicationMessageContext,
    CollaborationMessage,
    CollaborationRoomServer,
    SharedEntityState,
} from '../collaboration/collaborationRoomServer';
import { AnalysisViewMode, analysisRefreshCoordinator } from '../../../code_analysis/refresh/analysisRefreshCoordinator';
import { defaultControllerView } from '../../../code_analysis/refresh/analysisViewModes';
import { AnalysisFeatureHost } from './analysisFeatureHost';
import { DependencyGraphBridge } from './dependencyGraphBridge';
import { HistoricalComparisonBridge } from './historicalComparisonBridge';
import { ProjectEvolutionBridge } from './projectEvolutionBridge';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('ANALYSIS_MESSAGE_ROUTER');

/** Room access the mode-activation handler needs to probe cached snapshots. */
export interface AnalysisRouterRoomHooks {
    getRoom(): CollaborationRoomServer | null;
    getRoomId(): string;
}

type SnapshotMode = Exclude<AnalysisViewMode, 'selection' | 'single'>;

/**
 * The cached room entity each snapshot-backed mode probes on activation, and
 * what makes it usable: a git result, or the dependency dataset URL.
 */
const SNAPSHOT_PROBE_BY_MODE: Readonly<Record<SnapshotMode, {
    entityKind: string;
    isAvailable(snapshot: SharedEntityState | null | undefined): boolean;
}>> = {
    'historical-compare': { entityKind: 'historical-comparison', isAvailable: (snapshot) => !!snapshot?.result },
    'project-evolution': { entityKind: 'project-evolution', isAvailable: (snapshot) => !!snapshot?.result },
    'dependency-graph': {
        entityKind: 'dependency-graph',
        isAvailable: (snapshot) => typeof snapshot?.datasetUrl === 'string',
    },
};

/**
 * Dispatches collaboration room application messages to their feature
 * bridge. The guard order is part of the contract: analysis-mode and
 * dependency-graph messages are always considered, while historical and
 * project-evolution messages require the historical comparison service
 * to be attached to this server.
 */
export class AnalysisMessageRouter {
    constructor(
        private readonly host: AnalysisFeatureHost,
        private readonly dependencyGraph: DependencyGraphBridge,
        private readonly historicalComparison: HistoricalComparisonBridge,
        private readonly projectEvolution: ProjectEvolutionBridge,
        private readonly room: AnalysisRouterRoomHooks,
    ) {}

    private get historicalComparisonService() {
        return this.host.historicalComparisonService;
    }

    private get projectEvolutionService() {
        return this.host.projectEvolutionService;
    }

    public async handleCollaborationMessage(
        messageContext: CollaborationApplicationMessageContext,
        message: CollaborationMessage,
    ): Promise<boolean> {
        if (message.type === 'analysis-mode-selection') {
            this.host.changeAnalysisViewMode('selection', 'visualization-menu');
            return true;
        }
        if (message.type === 'analysis-mode-activate') {
            return this.handleAnalysisModeActivateMessage(message);
        }
        if (message.type === 'dependency-graph-settings') {
            return this.dependencyGraph.handleDependencyGraphSettingsMessage(messageContext, message);
        }
        if (message.type === 'dependency-file-scope-request') {
            return this.dependencyGraph.handleDependencyFileScopeRequestMessage(messageContext, message);
        }
        if (message.type === 'dependency-graph-start') {
            logger.debug(() => `[Code-XR Fix][Server] dependency-graph-start received (room: ${messageContext.roomId})`);
            return this.dependencyGraph.handleDependencyGraphStartMessage(messageContext, message);
        }
        if (!this.historicalComparisonService) {
            return false;
        }
        if (message.type === 'historical-comparison-references-request') {
            return this.historicalComparison.handleHistoricalComparisonReferencesMessage(messageContext);
        }
        if (message.type === 'historical-comparison-start') {
            return this.historicalComparison.handleHistoricalComparisonStartMessage(messageContext, message);
        }
        if (this.projectEvolutionService && message.type === 'project-evolution-references-request') {
            return this.projectEvolution.handleProjectEvolutionReferencesMessage(messageContext);
        }
        if (this.projectEvolutionService && message.type === 'project-evolution-clear') {
            return this.projectEvolution.handleProjectEvolutionClearMessage(messageContext);
        }
        if (this.projectEvolutionService && message.type === 'project-evolution-apply-frame') {
            return this.projectEvolution.handleProjectEvolutionApplyFrameMessage(messageContext, message);
        }
        if (this.projectEvolutionService && message.type === 'project-evolution-start') {
            return this.projectEvolution.handleProjectEvolutionStartMessage(messageContext, message);
        }
        return false;
    }

    private async handleAnalysisModeActivateMessage(message: CollaborationMessage): Promise<boolean> {
        const mode = String(message.payload?.mode || '');
        if (mode === 'single') {
            await this.host.activateAnalysisViewMode(mode, defaultControllerView(mode));
        } else if (Object.prototype.hasOwnProperty.call(SNAPSHOT_PROBE_BY_MODE, mode)) {
            const probe = SNAPSHOT_PROBE_BY_MODE[mode as SnapshotMode];
            const snapshot = this.room.getRoom()?.getServerEntity(this.room.getRoomId(), probe.entityKind, 'main');
            const available = probe.isAvailable(snapshot);
            analysisRefreshCoordinator.setSnapshotAvailable(this.host.sessionId, mode as SnapshotMode, available);
            const allowsEmptyShell = mode === 'historical-compare'
                || mode === 'project-evolution';
            if (!available && !allowsEmptyShell) {
                this.host.changeAnalysisViewMode('selection', 'visualization-menu');
                return true;
            }
            const controllerView = mode === 'historical-compare' && available
                ? 'historical.mapping'
                : defaultControllerView(mode);
            await this.host.activateAnalysisViewMode(mode as SnapshotMode, controllerView);
        }
        return true;
    }
}
