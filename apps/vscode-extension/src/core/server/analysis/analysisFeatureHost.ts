import * as path from 'path';
import { liveChannelHub } from '../live/liveChannelHub';
import { fileToServerMap } from '../fileToServerMap';
import { CollaborationRoomServer } from '../collaboration/collaborationRoomServer';
import { HistoricalComparisonProgress } from '../../history/historicalComparisonModels';
import { HistoricalComparisonService, describeHistoricalComparisonError } from '../../history/historicalComparisonService';
import { HISTORICAL_COMPARISON_CANCELLED_MESSAGE } from '../../history/historicalComparisonStatus';
import { JobCancelledError } from '../../analysis/launch/jobRunner';
import { GitAnalysisSourceCatalog } from '../../history/gitAnalysisEligibility';
import { ProjectEvolutionService } from '../../history/projectEvolutionService';
import { analysisUpdateEvents } from '../../history/analysisUpdateEvents';
import { DependencyGraphService } from '../../dependencies/dependencyGraphService';
import { AGENT_FLOW_NOT_ATTACHED, agentFlowAvailability, releaseAgentFlow, wireAgentFlow, type AgentFlowWiringInput } from './agentFlowHostWiring';
import { AnalysisSourceChangeBatch, AnalysisViewState, AnalysisViewMode, analysisRefreshCoordinator } from '../../analysis/refresh/analysisRefreshCoordinator';
import { SessionWatcherManager } from '../../analysis/watchers/sessionWatcherManager';
import { UnifiedSessionRegistry } from '../../analysis/session/sessionRegistry';
import { resolveAnalysisServerCapabilities } from '../analysisServerCapabilities';
import { AnalysisAvailabilitySnapshot } from '../collaboration/collaborationSessionApi';
import { getLogger } from '../../../platform/logging/sink';
import type { CoreContext } from '../../host/hostPaths';

/** Debounce of a live refresh after a save; retries back off from it (HIST-1). */
const HISTORICAL_REFRESH_DEBOUNCE_MS = 350;
const HISTORICAL_REFRESH_MAX_ATTEMPTS = 3;

function describeHistoricalRefreshFailure(error: unknown): string {
    const reason = describeHistoricalComparisonError(error);
    return `The comparison stopped following your edits: ${reason} Compare again to resume.`;
}

const logger = getLogger('ANALYSIS_FEATURE_HOST');

/** The slice of the server configuration the analysis features run on. */
export interface AnalysisFeatureHostConfig {
    extensionContext?: CoreContext;
    analysisSessionId?: string;
    staticRoot?: string;
    port: number;
}

/** Late-bound collaboration-room access, provided by the owning server. */
export interface AnalysisRoomHooks {
    getRoom(): CollaborationRoomServer | null;
    getRoomId(): string;
}

/**
 * Owns the per-session analysis feature services (dependency graph, historical
 * comparison, project evolution), their refresh-coordinator wiring, and the
 * LivePanel live-channel delivery. Message and REST handling live in the sibling
 * bridge modules; this host is their shared context.
 */
export class AnalysisFeatureHost {
    public analysisMode: string | undefined;
    public dependencyGraphService: DependencyGraphService | null = null;
    public historicalComparisonService: HistoricalComparisonService | null = null;
    public projectEvolutionService: ProjectEvolutionService | null = null;
    public gitAnalysisSourceCatalog: GitAnalysisSourceCatalog | null = null;
    public agentFlow = AGENT_FLOW_NOT_ATTACHED;

    private analysisUpdateSubscription: (() => void) | null = null;
    private historicalRefreshTimer: NodeJS.Timeout | null = null;
    private historicalRefreshQueued = false;
    /** Consecutive failed live refreshes (HIST-1); reset by a success. */
    private historicalRefreshFailures = 0;
    /** A live refresh was skipped while the XR view was elsewhere; run it on re-entry (HIST-4). */
    private historicalRefreshPendingOnEntry = false;
    /** The room's mode at the last view change, to see History being left (HIST-7). */
    private lastViewMode: AnalysisViewMode | null = null;
    private refreshCoordinatorDisposables: Array<() => void> = [];
    private dependencyRefreshHandler: (batch: AnalysisSourceChangeBatch) => Promise<void> =
        async () => undefined;

    constructor(
        private readonly config: AnalysisFeatureHostConfig,
        private readonly hooks: AnalysisRoomHooks,
    ) {
        if (this.config.extensionContext && this.config.analysisSessionId && this.config.staticRoot) {
            // Every analysis mode shares this launch path; a mode's declared
            // capabilities decide which optional feature services get attached.
            // XR-only services throw for non-XR sessions, so gating construction
            // here is what lets LivePanel/DOM/future modes launch successfully.
            const session = UnifiedSessionRegistry
                .getInstance(this.config.extensionContext)
                .getSession(this.config.analysisSessionId);
            this.analysisMode = session?.analysisMode;
            const capabilities = resolveAnalysisServerCapabilities(session?.analysisMode);
            if (
                session
                && (capabilities.historicalComparison || capabilities.projectEvolution)
            ) {
                this.gitAnalysisSourceCatalog = new GitAnalysisSourceCatalog(
                    session.targetType,
                    session.isDeep === true,
                    path.join(
                        session.savedFilesPath || this.config.staticRoot,
                        'data.json',
                    ),
                );
            }

            if (capabilities.dependencyGraph) {
                this.dependencyGraphService = new DependencyGraphService(
                    this.config.extensionContext,
                    this.config.analysisSessionId,
                    this.config.staticRoot,
                );
                this.refreshCoordinatorDisposables.push(
                    analysisRefreshCoordinator.registerHandler(
                        this.config.analysisSessionId,
                        'dependency-graph',
                        (batch) => this.dependencyRefreshHandler(batch),
                    ),
                );

                if (this.analysisMode === 'LivePanel') {
                    // The LivePanel dependency summary (file and directory sessions —
                    // the service resolves the project root for file targets) shows
                    // every metric at once, so it must stay in lockstep with the
                    // classic re-analysis: recompute on every source change (incrementally,
                    // changed files only) and seed the initial dataset now. The result is
                    // pushed to the panel over the live channel by refreshDependencyGraph().
                    const livePanelSessionId = this.config.analysisSessionId;
                    analysisRefreshCoordinator.setBackgroundRefresh(livePanelSessionId, 'dependency-graph', true);
                    this.refreshCoordinatorDisposables.push(
                        () => analysisRefreshCoordinator.setBackgroundRefresh(livePanelSessionId, 'dependency-graph', false),
                    );
                    void analysisRefreshCoordinator.forceRefreshMode(livePanelSessionId, 'dependency-graph');
                }
            }

            if (capabilities.historicalComparison) {
                this.attachHistoricalComparison(this.config.extensionContext, this.config.analysisSessionId, this.config.staticRoot);
            }

            if (capabilities.projectEvolution) {
                this.projectEvolutionService = new ProjectEvolutionService(
                    this.config.extensionContext,
                    this.config.analysisSessionId,
                    this.config.staticRoot,
                    this.gitAnalysisSourceCatalog ?? undefined,
                );
            }
            this.agentFlow = wireAgentFlow(this.agentFlowWiring(capabilities.agentFlow, session, this.config.analysisSessionId, this.config.staticRoot));

            // Shared by every session-bound mode: publish analysis view-state
            // changes over the collaboration channel (no-op without a room).
            this.refreshCoordinatorDisposables.push(
                analysisRefreshCoordinator.onStateChanged(
                    this.config.analysisSessionId,
                    () => this.publishAnalysisViewState(),
                ),
            );
        }
    }

    /** Agent Flow's slot on this server (agentFlowHostWiring.ts); a file analysis gets the reason instead. */
    private agentFlowWiring(enabled: boolean, target: AgentFlowWiringInput['target'], sessionId: string, staticRoot: string): AgentFlowWiringInput {
        return {
            enabled, target, sessionId, staticRoot,
            disposables: this.refreshCoordinatorDisposables,
            publish: (entity) => this.hooks.getRoom()?.upsertServerEntity(this.hooks.getRoomId(), { ...entity }),
            activate: () => { void this.activateAnalysisViewMode('agent-flow', 'agent-flow'); },
        };
    }

    /**
     * The comparison service and its live link: working-copy edits refresh
     * the comparison while History is on screen (LivePanel always shows it);
     * a refresh skipped elsewhere runs on re-entry (HIST-4).
     */
    private attachHistoricalComparison(
        extensionContext: CoreContext,
        sessionId: string,
        staticRoot: string,
    ): void {
        this.historicalComparisonService = new HistoricalComparisonService(
            extensionContext,
            sessionId,
            staticRoot,
            this.gitAnalysisSourceCatalog ?? undefined,
        );
        this.analysisUpdateSubscription = analysisUpdateEvents.on((event) => {
            if (event.sessionId !== sessionId) {
                return;
            }
            if (this.isHistoricalViewActive()) {
                this.scheduleHistoricalComparisonRefresh();
            } else {
                this.historicalRefreshPendingOnEntry = this.historicalComparisonService?.hasLiveSource() ?? false;
            }
        });
        this.lastViewMode = analysisRefreshCoordinator.getViewState(sessionId).mode;
        this.refreshCoordinatorDisposables.push(
            analysisRefreshCoordinator.onStateChanged(sessionId, (view) => this.handleHistoricalViewChanged(view)),
        );
    }

    /**
     * Entering History runs a refresh skipped elsewhere (HIST-4); leaving it
     * cancels a comparison with no result yet, told like a Cancel (HIST-7).
     */
    public handleHistoricalViewChanged(view: AnalysisViewState): void {
        const previousMode = this.lastViewMode;
        this.lastViewMode = view.mode;
        if (view.mode === 'historical-compare') {
            if (this.historicalRefreshPendingOnEntry) {
                this.historicalRefreshPendingOnEntry = false;
                this.scheduleHistoricalComparisonRefresh();
            }
            return;
        }
        if (previousMode !== 'historical-compare' || !this.historicalComparisonService) {
            return;
        }
        const jobId = this.historicalComparisonService.getJobStatus()?.id ?? null;
        if (!this.historicalComparisonService.cancelComparisonWithoutResult()) {
            return;
        }
        this.hooks.getRoom()?.broadcastServerMessage(this.hooks.getRoomId(), {
            type: 'historical-comparison-cancelled',
            payload: { message: `${HISTORICAL_COMPARISON_CANCELLED_MESSAGE} You left History.`, jobId },
        });
    }

    /** Session id, valid whenever any feature service exists. */
    public get sessionId(): string {
        return this.config.analysisSessionId!;
    }

    public get hasSession(): boolean {
        return !!this.config.analysisSessionId;
    }

    /**
     * The dependency refresh work is implemented by the dependency bridge; it
     * registers here once constructed. Coordinator events cannot fire before
     * the owning server finishes constructing, so the late binding is safe.
     */
    public setDependencyRefreshHandler(
        handler: (batch: AnalysisSourceChangeBatch) => Promise<void>,
    ): void {
        this.dependencyRefreshHandler = handler;
    }

    /** Feature availability, as reported in the collaboration descriptor. */
    public async getAnalysisAvailability(): Promise<AnalysisAvailabilitySnapshot> {
        return {
            historicalComparison: this.historicalComparisonService
                ? await this.historicalComparisonService.getAvailability()
                : {
                    enabled: false,
                    reason: 'Historical comparison is not available for this server.',
                },
            projectEvolution: this.projectEvolutionService
                ? await this.projectEvolutionService.getAvailability()
                : {
                    enabled: false,
                    reason: 'Project evolution is not available for this server.',
                },
            dependencyGraph: this.dependencyGraphService?.getAvailability() ?? {
                enabled: false,
                reason: 'Dependency analysis is not available for this server.',
            },
            agentFlow: agentFlowAvailability(this.agentFlow),
        };
    }

    public changeAnalysisViewMode(
        mode: AnalysisViewMode,
        controllerView?: string,
    ): AnalysisViewState | null {
        if (!this.config.analysisSessionId) {
            return null;
        }
        return analysisRefreshCoordinator.changeActiveMode(
            this.config.analysisSessionId,
            mode,
            controllerView,
        );
    }

    public getAnalysisViewState(): AnalysisViewState | null {
        if (!this.config.analysisSessionId) {
            return null;
        }
        return analysisRefreshCoordinator.getViewState(this.config.analysisSessionId);
    }

    public updateAnalysisViewIfCurrent(
        expectedMode: AnalysisViewMode,
        expectedViewRevision: number,
        controllerView: string,
    ): AnalysisViewState | null {
        if (!this.config.analysisSessionId) {
            return null;
        }
        return analysisRefreshCoordinator.updateActiveViewIfCurrent(
            this.config.analysisSessionId,
            expectedMode,
            expectedViewRevision,
            controllerView,
        );
    }

    public async activateAnalysisViewMode(
        mode: Exclude<AnalysisViewMode, 'selection'>,
        controllerView: string,
    ): Promise<AnalysisViewState | null> {
        if (!this.config.analysisSessionId) {
            return null;
        }
        const snapshot = this.changeAnalysisViewMode(mode, controllerView);
        // Watcher reconciliation must never gate the collaboration reply: a
        // slow or stuck reconcile left dependency-graph-start unanswered
        // (total silence in the scene) while historical — which does not
        // await it — kept working. Run it in the background and log failures.
        void SessionWatcherManager.reconcileSession(this.config.analysisSessionId).catch((error) => {
            logger.warn('[Code-XR Fix][Server] Session watcher reconciliation failed:', error);
        });
        return snapshot;
    }

    public publishAnalysisViewState(): void {
        if (!this.config.analysisSessionId || !this.hooks.getRoom()) {
            return;
        }
        this.hooks.getRoom()!.upsertServerEntity(
            this.hooks.getRoomId(),
            analysisRefreshCoordinator.getViewState(this.config.analysisSessionId),
        );
    }

    public scheduleHistoricalComparisonRefresh(delayMs = HISTORICAL_REFRESH_DEBOUNCE_MS): void {
        if (!this.historicalComparisonService?.hasLiveSource()) {
            return;
        }
        this.historicalRefreshQueued = true;
        if (this.historicalRefreshTimer) {
            clearTimeout(this.historicalRefreshTimer);
        }
        this.historicalRefreshTimer = setTimeout(() => {
            this.historicalRefreshTimer = null;
            void this.refreshHistoricalComparison();
        }, delayMs);
    }

    /** LivePanel always shows the comparison; XR only while the room is in History. */
    private isHistoricalViewActive(): boolean {
        if (this.analysisMode === 'LivePanel') {
            return true;
        }
        return !!this.config.analysisSessionId
            && analysisRefreshCoordinator.getViewState(this.config.analysisSessionId).mode === 'historical-compare';
    }

    /**
     * Retries a failed live refresh with back-off, at most
     * HISTORICAL_REFRESH_MAX_ATTEMPTS times, and only while History is on
     * screen (HIST-1). It used to retry every 350 ms forever without a word.
     */
    private retryHistoricalRefresh(): boolean {
        if (!this.isHistoricalViewActive()) {
            this.historicalRefreshPendingOnEntry = true;
            return true;
        }
        this.historicalRefreshFailures += 1;
        if (this.historicalRefreshFailures >= HISTORICAL_REFRESH_MAX_ATTEMPTS) {
            return false;
        }
        this.scheduleHistoricalComparisonRefresh(
            HISTORICAL_REFRESH_DEBOUNCE_MS * (2 ** this.historicalRefreshFailures),
        );
        return true;
    }

    private async refreshHistoricalComparison(): Promise<void> {
        if (!this.historicalComparisonService || !this.historicalRefreshQueued) {
            return;
        }
        this.historicalRefreshQueued = false;
        if (this.historicalComparisonService.isBusy()) {
            // Another comparison is running: wait for it, without counting a failure.
            this.scheduleHistoricalComparisonRefresh(HISTORICAL_REFRESH_DEBOUNCE_MS * 2);
            return;
        }
        try {
            const result = await this.historicalComparisonService.refreshActiveComparison((progress) => {
                this.hooks.getRoom()?.broadcastServerMessage(this.hooks.getRoomId(), {
                    type: 'historical-comparison-progress',
                    payload: progress,
                });
            });
            this.historicalRefreshFailures = 0;
            if (result) {
                this.hooks.getRoom()?.upsertServerEntity(this.hooks.getRoomId(), {
                    entityKind: 'historical-comparison',
                    entityId: 'main',
                    mode: 'historical-compare',
                    result,
                });
                this.notifyLivePanelHistoricalUpdated(result.revision);
            }
        } catch (error) {
            if (error instanceof JobCancelledError && error.reason !== 'timeout') {
                // Stopped on purpose: no retry; the next edit refreshes again.
                this.historicalRefreshFailures = 0;
                this.notifyLivePanelHistoricalProgress({ state: 'cancelled', message: HISTORICAL_COMPARISON_CANCELLED_MESSAGE });
                return;
            }
            logger.error('[CodeXR][HistoricalComparison] Live refresh failed:', error);
            if (!this.retryHistoricalRefresh()) {
                this.stopHistoricalLiveRefresh(error);
            }
        }
    }

    /**
     * Gives up on the live link after repeated failures: the room and LivePanel
     * are told why, and the working-copy side stops following edits until a
     * new comparison is made.
     */
    private stopHistoricalLiveRefresh(error: unknown): void {
        this.historicalRefreshFailures = 0;
        this.historicalComparisonService?.suspendLiveRefresh();
        const message = describeHistoricalRefreshFailure(error);
        this.hooks.getRoom()?.broadcastServerMessage(this.hooks.getRoomId(), {
            type: 'historical-comparison-error',
            payload: { code: 'comparison-live-refresh-stopped', message },
        });
        this.notifyLivePanelHistoricalProgress({ state: 'error', message });
    }

    public notifyLivePanelHistoricalProgress(progress: HistoricalComparisonProgress): void {
        const channel = this.getLivePanelChannel();
        if (!channel) {
            return;
        }
        liveChannelHub.publish(channel, 'historical-progress', {
            sessionId: this.config.analysisSessionId,
            state: progress.state,
            message: progress.message,
            revision: progress.revision,
            jobId: progress.jobId,
        });
    }

    public notifyLivePanelHistoricalUpdated(revision?: number): void {
        const channel = this.getLivePanelChannel();
        if (!channel) {
            return;
        }
        liveChannelHub.publish(channel, 'historical-updated', {
            sessionId: this.config.analysisSessionId,
            revision,
        });
    }

    /**
     * LivePanel pages have no collaboration room; feature updates reach them
     * over the live channel (/codexr-live), on the channel of the session this
     * server serves (channels are keyed by session id). Returns null for every other mode so the
     * notify helpers are safe to call anywhere.
     */
    private getLivePanelChannel(): string | null {
        if (this.analysisMode !== 'LivePanel') {
            return null;
        }
        return this.config.analysisSessionId || fileToServerMap.findFileByPort(this.config.port);
    }

    public notifyLivePanelDependencyUpdated(revision: number): void {
        // Delivered over the live channel so the page reloads the freshly
        // written dependency-graph.json (see getLivePanelChannel).
        const channel = this.getLivePanelChannel();
        if (!channel) {
            return;
        }
        liveChannelHub.publish(channel, 'dependency-updated', {
            sessionId: this.config.analysisSessionId,
            revision,
        });
    }

    /** Tear down subscriptions, timers and the feature services. */
    public dispose(): void {
        this.analysisUpdateSubscription?.();
        this.analysisUpdateSubscription = null;
        if (this.historicalRefreshTimer) {
            clearTimeout(this.historicalRefreshTimer);
            this.historicalRefreshTimer = null;
        }
        for (const dispose of this.refreshCoordinatorDisposables.splice(0)) {
            dispose();
        }
        if (this.config.analysisSessionId) {
            analysisRefreshCoordinator.disposeSession(this.config.analysisSessionId);
        }
        void this.historicalComparisonService?.dispose();
        this.historicalComparisonService = null;
        void this.projectEvolutionService?.dispose();
        this.projectEvolutionService = null;
        void this.gitAnalysisSourceCatalog?.dispose();
        this.gitAnalysisSourceCatalog = null;
        void this.dependencyGraphService?.dispose();
        this.dependencyGraphService = null;
        this.agentFlow = releaseAgentFlow(this.agentFlow);
    }
}
