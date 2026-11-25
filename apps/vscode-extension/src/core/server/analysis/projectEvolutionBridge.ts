import {
    CollaborationApplicationMessageContext,
    CollaborationMessage,
} from '../collaboration/collaborationRoomServer';
import { GitAnalysisSourceError } from '../../history/gitAnalysisEligibility';
import { ProjectEvolutionRequest } from '../../history/historicalComparisonModels';
import { analysisRefreshCoordinator } from '../../../code_analysis/refresh/analysisRefreshCoordinator';
import { SessionWatcherManager } from '../../../code_analysis/engine/watchers/sessionWatcherManager';
import { AnalysisFeatureHost } from './analysisFeatureHost';
import {
    broadcastFilteredGitReferences,
    describeBridgeError,
    replyWithReferences,
} from './analysisBridgeReplies';

/**
 * Project-evolution feature bridge: the collaboration-room messages that list
 * references, generate the chronological movie, apply frames and clear it.
 */
export class ProjectEvolutionBridge {
    constructor(private readonly host: AnalysisFeatureHost) {}

    /** The service lives on the host; null when the mode has no evolution. */
    private get projectEvolutionService() {
        return this.host.projectEvolutionService;
    }

    public async handleProjectEvolutionReferencesMessage(
        messageContext: CollaborationApplicationMessageContext,
    ): Promise<boolean> {
        if (!this.projectEvolutionService) {
            return false;
        }
        const service = this.projectEvolutionService;
        await replyWithReferences(messageContext, {
            load: () => service.getReferences(),
            referencesType: 'project-evolution-references',
            errorType: 'project-evolution-error',
        });
        return true;
    }

    public async handleProjectEvolutionClearMessage(
        messageContext: CollaborationApplicationMessageContext,
    ): Promise<boolean> {
        if (!this.projectEvolutionService) {
            return false;
        }
        const viewAtStart = this.host.getAnalysisViewState();
        try {
            await this.projectEvolutionService.clearGeneratedMovie();
            messageContext.removeSharedEntity('project-evolution', 'main');
            if (this.host.hasSession) {
                analysisRefreshCoordinator.setSnapshotAvailable(
                    this.host.sessionId,
                    'project-evolution',
                    false,
                );
                if (viewAtStart?.mode === 'project-evolution') {
                    this.host.updateAnalysisViewIfCurrent(
                        'project-evolution',
                        viewAtStart.viewRevision,
                        'project-evolution',
                    );
                }
            }
            messageContext.broadcast({
                type: 'project-evolution-cleared',
                payload: {
                    message: 'Project evolution movie cleared.',
                },
            });
        } catch (error) {
            messageContext.broadcast({
                type: 'project-evolution-error',
                payload: {
                    code: error instanceof Error ? error.message : 'project-evolution-clear-failed',
                    message: error instanceof Error ? error.message : String(error),
                },
            });
        }
        return true;
    }

    public async handleProjectEvolutionApplyFrameMessage(
        messageContext: CollaborationApplicationMessageContext,
        message: CollaborationMessage,
    ): Promise<boolean> {
        if (!this.projectEvolutionService) {
            return false;
        }
        const viewAtStart = this.host.getAnalysisViewState();
        if (viewAtStart?.mode !== 'project-evolution') {
            return true;
        }
        try {
            const payload = message.payload || {};
            const revision = Number(payload.revision);
            const frameIndex = Number(payload.frameIndex);
            const requestId = typeof payload.requestId === 'string'
                ? payload.requestId
                : undefined;
            const result = await this.projectEvolutionService.applyFrameToBridge(revision, frameIndex);
            const currentView = this.host.getAnalysisViewState();
            if (
                currentView?.mode !== 'project-evolution'
                || currentView.viewRevision !== viewAtStart.viewRevision
            ) {
                return true;
            }
            messageContext.broadcast({
                type: 'project-evolution-frame-applied',
                payload: {
                    ...result,
                    requestId,
                },
            });
        } catch (error) {
            messageContext.broadcast({
                type: 'project-evolution-error',
                payload: {
                    code: error instanceof Error ? error.message : 'project-evolution-apply-frame-failed',
                    message: error instanceof Error ? error.message : String(error),
                },
            });
        }
        return true;
    }

    public handleProjectEvolutionStartMessage(
        messageContext: CollaborationApplicationMessageContext,
        message: CollaborationMessage,
    ): boolean {
        if (!this.projectEvolutionService) {
            return false;
        }
        if (this.projectEvolutionService.isBusy()) {
            messageContext.send({
                type: 'project-evolution-error',
                payload: {
                    code: 'project-evolution-busy',
                    message: 'Another project evolution analysis is already running.',
                },
            });
            return true;
        }
        const payload = message.payload || {};
        const request: ProjectEvolutionRequest = {
            mode: payload.mode === 'range' || payload.mode === 'manual'
                ? payload.mode
                : 'auto',
            startSourceId: typeof payload.startSourceId === 'string'
                ? payload.startSourceId
                : undefined,
            endSourceId: typeof payload.endSourceId === 'string'
                ? payload.endSourceId
                : undefined,
            sourceIds: Array.isArray(payload.sourceIds)
                ? payload.sourceIds.map((value: unknown) => String(value)).filter(Boolean)
                : undefined,
            maxFrames: Number.isFinite(Number(payload.maxFrames))
                ? Number(payload.maxFrames)
                : undefined,
        };
        analysisRefreshCoordinator.setRefreshEnabled(
            this.host.sessionId,
            'project-evolution',
            false,
        );
        const currentView = this.host.getAnalysisViewState();
        if (currentView?.mode !== 'project-evolution') {
            this.host.changeAnalysisViewMode('project-evolution', 'project-evolution');
        }
        const operationView = currentView?.mode === 'project-evolution'
            ? currentView
            : this.host.getAnalysisViewState();
        const operationViewRevision = operationView?.viewRevision;
        void (async () => {
            try {
                await SessionWatcherManager.reconcileSession(
                    this.host.sessionId,
                );
                const result = await this.projectEvolutionService!.generate(request, (progress) => {
                    messageContext.broadcast({
                        type: 'project-evolution-progress',
                        payload: progress,
                    });
                });
                messageContext.upsertSharedEntity({
                    entityKind: 'project-evolution',
                    entityId: 'main',
                    mode: 'project-evolution',
                    result,
                });
                analysisRefreshCoordinator.setSnapshotAvailable(
                    this.host.sessionId,
                    'project-evolution',
                    true,
                );
                if (operationViewRevision !== undefined) {
                    this.host.updateAnalysisViewIfCurrent(
                        'project-evolution',
                        operationViewRevision,
                        'project-evolution',
                    );
                }
            } catch (error) {
                if (error instanceof Error && error.message === 'project-evolution-cleared') {
                    return;
                }
                if (error instanceof GitAnalysisSourceError) {
                    await broadcastFilteredGitReferences(this.host, messageContext);
                }
                messageContext.broadcast({
                    type: 'project-evolution-error',
                    payload: describeBridgeError(error, 'project-evolution-failed'),
                });
            }
        })();
        return true;
    }
}
