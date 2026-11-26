import * as http from 'http';
import {
    CollaborationApplicationMessageContext,
    CollaborationMessage,
} from '../collaboration/collaborationRoomServer';
import { GitAnalysisSourceError } from '../../history/gitAnalysisEligibility';
import { JobCancelledError, JobTicket } from '../../analysis/launch/jobRunner';
import { HistoricalComparisonRequest, HistoricalComparisonResult } from '../../history/historicalComparisonModels';
import { classifyHistoricalComparisonError } from '../../history/historicalComparisonService';
import { analysisRefreshCoordinator } from '../../analysis/refresh/analysisRefreshCoordinator';
import { SessionWatcherManager } from '../../analysis/watchers/sessionWatcherManager';
import { readJsonBody, sendErrorResponse, sendJsonResponse } from '../http/httpRespond';
import { AnalysisFeatureHost } from './analysisFeatureHost';
import {
    broadcastFilteredGitReferences,
    describeBridgeError,
    replyWithReferences,
} from './analysisBridgeReplies';

/**
 * Historical-comparison feature bridge: the LivePanel REST endpoints and the
 * collaboration-room messages that start comparisons. The service, the live
 * refresh debounce and the SSE notifiers live on the host.
 */
export class HistoricalComparisonBridge {
    constructor(private readonly host: AnalysisFeatureHost) {}

    /** The service lives on the host; null when the mode has no comparison. */
    private get historicalComparisonService() {
        return this.host.historicalComparisonService;
    }

    /**
     * LivePanel REST endpoint: availability + Git references (working copy,
     * branches, tags, commits) for the historical comparison panel. Reuses the
     * same session-bound HistoricalComparisonService the XR mode uses.
     */
    public async handleHistoricalReferences(
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ): Promise<void> {
        if (req.method !== 'GET') {
            sendErrorResponse(res, 405, 'Method not allowed');
            return;
        }
        if (!this.historicalComparisonService) {
            sendErrorResponse(res, 404, 'Historical comparison is not available for this session.');
            return;
        }
        const availability = await this.historicalComparisonService.getAvailability();
        if (!availability.enabled) {
            sendJsonResponse(res, 200, { enabled: false, reason: availability.reason });
            return;
        }
        try {
            const references = await this.historicalComparisonService.getReferences();
            sendJsonResponse(res, 200, { enabled: true, reason: null, references });
        } catch (error) {
            sendErrorResponse(
                res,
                500,
                error instanceof Error ? error.message : 'Failed to list Git references.',
            );
        }
    }

    /**
     * LivePanel REST endpoint: start a historical comparison between two
     * sources. Responds 202 immediately; progress and the finished revision
     * are pushed over SSE (`historical-progress` / `historical-updated`), and
     * the client then fetches the /comparison/revision-N.json artifact.
     * A comparison with a working-copy side stays live: every incremental
     * re-analysis triggers a refresh (see the analysisUpdateEvents wiring).
     */
    public async handleHistoricalCompare(
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ): Promise<void> {
        if (req.method !== 'POST') {
            sendErrorResponse(res, 405, 'Method not allowed');
            return;
        }
        if (!this.historicalComparisonService) {
            sendErrorResponse(res, 404, 'Historical comparison is not available for this session.');
            return;
        }
        let request: HistoricalComparisonRequest;
        try {
            const payload = await readJsonBody(req);
            request = {
                leftSourceId: String(payload.leftSourceId || ''),
                rightSourceId: String(payload.rightSourceId || ''),
            };
        } catch {
            sendErrorResponse(res, 400, 'Invalid request body');
            return;
        }
        // Reserved with no await between the check and the take (HIST-9).
        const service = this.historicalComparisonService;
        const ticket = service.reserveComparison(request);
        if (!ticket) {
            sendErrorResponse(res, 409, 'A historical comparison is already running.');
            return;
        }
        sendJsonResponse(res, 202, { accepted: true, jobId: ticket.id });
        void (async () => {
            try {
                try {
                    await SessionWatcherManager.reconcileSession(this.host.sessionId);
                } catch (error) {
                    ticket.release();
                    throw error;
                }
                const result = await service.runComparison(ticket, request, (progress) => {
                    this.host.notifyLivePanelHistoricalProgress(progress);
                });
                this.host.notifyLivePanelHistoricalUpdated(result.revision);
            } catch (error) {
                this.host.notifyLivePanelHistoricalProgress({
                    state: 'error',
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        })();
    }

    public async handleHistoricalComparisonReferencesMessage(
        messageContext: CollaborationApplicationMessageContext,
    ): Promise<boolean> {
        if (!this.historicalComparisonService) {
            return false;
        }
        const service = this.historicalComparisonService;
        await replyWithReferences(messageContext, {
            load: () => service.getReferences(),
            referencesType: 'historical-comparison-references',
            errorType: 'historical-comparison-error',
        });
        return true;
    }

    /** Stops the running comparison for the whole room; the previous result stays. */
    public handleHistoricalComparisonCancelMessage(
        messageContext: CollaborationApplicationMessageContext,
    ): boolean {
        if (!this.historicalComparisonService) {
            return false;
        }
        const job = this.historicalComparisonService.getJobStatus();
        if (!this.historicalComparisonService.cancelComparison()) {
            messageContext.send({
                type: 'historical-comparison-cancelled',
                payload: { message: 'No historical comparison is running.', jobId: job?.id ?? null },
            });
            return true;
        }
        messageContext.broadcast({
            type: 'historical-comparison-cancelled',
            payload: { message: 'Historical comparison cancelled.', jobId: job?.id ?? null },
        });
        return true;
    }

    public handleHistoricalComparisonStartMessage(
        messageContext: CollaborationApplicationMessageContext,
        message: CollaborationMessage,
    ): boolean {
        if (!this.historicalComparisonService) {
            return false;
        }
        const request: HistoricalComparisonRequest = {
            leftSourceId: String(message.payload?.leftSourceId || ''),
            rightSourceId: String(message.payload?.rightSourceId || ''),
        };
        // Reserve BEFORE the first await: two starts can never both pass, and
        // the loser hears "busy" alone (HIST-9, LAUNCHER-11).
        const service = this.historicalComparisonService;
        const ticket = service.reserveComparison(request);
        if (!ticket) {
            messageContext.send({
                type: 'historical-comparison-error',
                payload: {
                    code: 'comparison-busy',
                    message: 'Another historical comparison is already running.',
                },
            });
            return true;
        }
        const currentView = this.host.getAnalysisViewState();
        if (currentView?.mode !== 'historical-compare') {
            this.host.changeAnalysisViewMode('historical-compare', 'historical.selection');
        }
        const operationView = currentView?.mode === 'historical-compare'
            ? currentView
            : this.host.getAnalysisViewState();
        const operationViewRevision = operationView?.viewRevision;
        void this.runComparisonJob(messageContext, ticket, request, operationViewRevision);
        return true;
    }

    /** Runs a reserved comparison and publishes its result, or its error, to the room. */
    private async runComparisonJob(
        messageContext: CollaborationApplicationMessageContext,
        ticket: JobTicket<HistoricalComparisonResult>,
        request: HistoricalComparisonRequest,
        operationViewRevision: number | undefined,
    ): Promise<void> {
        const service = this.historicalComparisonService!;
        try {
            try {
                await SessionWatcherManager.reconcileSession(
                    this.host.sessionId,
                );
                await analysisRefreshCoordinator.refreshMode(
                    this.host.sessionId,
                    'historical-compare',
                );
            } catch (error) {
                ticket.release();
                throw error;
            }
            const result = await service.runComparison(ticket, request, (progress) => {
                messageContext.broadcast({
                    type: 'historical-comparison-progress',
                    payload: progress,
                });
            });
            // The live-refresh flag describes the request that SUCCEEDED;
            // a failed request no longer leaves it describing itself
            // while the room still shows the previous one (HIST-9).
            analysisRefreshCoordinator.setRefreshEnabled(
                this.host.sessionId,
                'historical-compare',
                request.leftSourceId === 'working-copy' || request.rightSourceId === 'working-copy',
            );
            messageContext.upsertSharedEntity({
                entityKind: 'historical-comparison',
                entityId: 'main',
                mode: 'historical-compare',
                result,
            });
            analysisRefreshCoordinator.setSnapshotAvailable(
                this.host.sessionId,
                'historical-compare',
                true,
            );
            if (operationViewRevision !== undefined) {
                this.host.updateAnalysisViewIfCurrent(
                    'historical-compare',
                    operationViewRevision,
                    'historical.mapping',
                );
            }
        } catch (error) {
            if (error instanceof JobCancelledError && error.reason !== 'timeout') {
                // The cancel handler tells the room itself.
                return;
            }
            if (error instanceof GitAnalysisSourceError) {
                await broadcastFilteredGitReferences(this.host, messageContext);
            }
            messageContext.broadcast({
                type: 'historical-comparison-error',
                payload: classifyHistoricalComparisonError(error) ?? describeBridgeError(error, 'comparison-failed'),
            });
        }
    }
}
