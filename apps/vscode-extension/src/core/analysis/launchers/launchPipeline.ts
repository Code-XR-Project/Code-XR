/**
 * Launch Pipeline — shared execution logic for all analysis launchers.
 *
 * Encapsulates the common flow:
 *   1. Process/get required files
 *   2. Save files to storage
 *   3. Start the server with SSE
 *   4. Start the watcher for live updates
 *
 * The launch is a transaction (S5, LAUNCHER-5/7/10): it runs under a
 * `LaunchControl` record with an abort signal and a deadline, every step that
 * starts something pushes how to undo it, and any failure, timeout or Close
 * undoes the whole stack in reverse. The server starts BEFORE the watcher for
 * every kind, so a server that cannot start never leaves a watcher re-running
 * the analysis for a page that does not exist.
 *
 * Each launcher configures the pipeline via {@link LaunchPipelineConfig} without
 * duplicating the orchestration boilerplate.
 */

import { UnifiedAnalysisSession } from '../session/analysisSession';
import { UnifiedSessionRegistry } from '../session/sessionRegistry';
import { ProcessedRequirements } from '../processors/FileRequirementProcessor';
import { SaveFiles } from '../utils/saveFiles';
import { ServerLaunchOrchestrator } from '../session-servers/serverLaunchOrchestrator';
import { SessionWatcherManager } from '../watchers/sessionWatcherManager';
import { ServerControl } from '../../server/serverControl';
import { getActiveServerRegistry } from '../../server/registry/activeServerRegistry';
import {
    DEFAULT_LAUNCH_TIMEOUT_MS,
    LaunchAbortedError,
    LaunchAbortReason,
    LaunchControl,
    describeAbortReason,
    runWithLaunchSignal,
} from '../launch/launchControl';
import { getLogger } from '../../../platform/logging/sink';
import { getHost } from '../../host/hostRegistry';
import type { CoreContext } from '../../host/hostPaths';

const logger = getLogger('LAUNCH_PIPELINE');

/** Progress percentages for each pipeline step. */
export interface ProgressSteps {
    /** After requirements processed */
    process: number;
    /** After files saved */
    save: number;
    /** After the server started */
    watcherOrServer: number;
    /** After the watcher started */
    serverOrWatcher: number;
    /** Final — monitoring */
    done: number;
}

/** Configuration object that each launcher passes to {@link executeLaunchPipeline}. */
export interface LaunchPipelineConfig {
    /** Log prefix for console messages, e.g. `"NEW_LAUNCHER_LIVEPANEL_ANALYSIS"` */
    logPrefix: string;
    /** Sub-folder name passed to SaveFiles, e.g. `"fileAnalysis"` */
    folderName: string;
    /** Progress percentages for each step */
    progress: ProgressSteps;

    // ---------- Strategy callbacks ----------

    /** Produce the processed files (templates + data). */
    processRequirements: () => Promise<ProcessedRequirements>;

    /**
     * Start the appropriate watcher for this analysis type.
     * @returns watcher ID if started, undefined otherwise.
     */
    startWatcher: (savedPath: string) => Promise<string | undefined | null>;

    // ---------- Optional hooks ----------

    /** Runs before step 1 (e.g. hash/directory/XR-config validation). */
    preValidation?: () => Promise<void>;

    /** Called after server started successfully (e.g. show info messages). */
    onSuccess?: (serverPort: number | undefined, serverUrl: string | undefined) => void;

    /** If true, `session.endTime` is set on completion. */
    setEndTime?: boolean;

    /** If true, errors are re-thrown after handling. */
    rethrowErrors?: boolean;
}

/**
 * Execute the shared launch pipeline for one session.
 *
 * Resolves when the analysis is served and watched. A launch that was closed
 * while running resolves quietly (the user asked for it); any other failure
 * shows ONE error message and, for kinds that ask for it, rethrows.
 */
export async function executeLaunchPipeline(
    session: UnifiedAnalysisSession,
    context: CoreContext,
    config: LaunchPipelineConfig,
    options: { timeoutMs?: number; control?: LaunchControl } = {},
): Promise<void> {
    const log = (msg: string) => logger.debug(() => `${config.logPrefix}: ${msg}`);
    const logError = (msg: string) => logger.error(`${config.logPrefix}: ${msg}`);

    log(`Starting analysis with session ${session.id}`);

    const registry = UnifiedSessionRegistry.getInstance(context);
    const control = options.control ?? LaunchControl.getInstance();
    const signal = control.begin(session.id, options.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);
    const step = <T>(work: Promise<T>): Promise<T> => untilAborted(work, signal);
    const checkpoint = () => control.throwIfAborted(session.id);

    try {
        await runWithLaunchSignal(signal, async () => {
            // ── Optional pre-validation ──────────────────────────────
            if (config.preValidation) {
                await step(config.preValidation());
            }
            checkpoint();

            // ── STEP 1: Process requirements ─────────────────────────
            log(`STEP 1 - Getting template files and data.json...`);
            registry.updateSessionStatus(session.id, 'analyzing', config.progress.process);

            const processedFiles = await step(config.processRequirements());
            checkpoint();

            log(`Received ${processedFiles.loadedFiles.size} processed template files`);

            // ── STEP 2: Save files ───────────────────────────────────
            log(`STEP 2 - Saving processed files to storage...`);
            registry.updateSessionStatus(session.id, 'analyzing', config.progress.save);

            const saveFiles = new SaveFiles();
            const savedPath = await step(saveFiles.saveFilesToStorage(
                processedFiles.loadedFiles,
                config.folderName,
                session.outputDirectory,
                context,
            ));
            checkpoint();

            log(`Files successfully saved to: ${savedPath}`);

            session.savedFilesPath = savedPath;
            for (const [fileName, content] of processedFiles.loadedFiles) {
                session.requiredFiles.set(fileName, content);
            }

            const steps: StepContext = { session, context, registry, config, control, log, step };

            // ── STEP 3: Server ───────────────────────────────────────
            await startServer(steps);
            checkpoint();

            // ── STEP 4: Watcher ──────────────────────────────────────
            await startWatcher(steps, savedPath);
            checkpoint();
        });

        control.settle(session.id);
        registry.updateSessionStatus(session.id, 'monitoring', config.progress.done);
        if (config.setEndTime) {
            session.endTime = new Date();
        }
        config.onSuccess?.(session.assignedPort, session.serverUrl);
        log(`Analysis completed successfully!`);

    } catch (error) {
        const reason = signal.aborted ? (signal.reason as LaunchAbortReason) : 'failed';
        await handleLaunchFailure(error, reason, { session, registry, config, control, log, logError });
    }
}

// ── Internal helpers ─────────────────────────────────────────────

/** What the server and watcher steps share. */
interface StepContext {
    session: UnifiedAnalysisSession;
    context: CoreContext;
    registry: UnifiedSessionRegistry;
    config: LaunchPipelineConfig;
    control: LaunchControl;
    log: (msg: string) => void;
    step: <T>(work: Promise<T>) => Promise<T>;
}

/**
 * Rolls a failed or stopped launch back and reports it: silent when the user
 * closed it (or a newer launch replaced it), one error message otherwise.
 */
async function handleLaunchFailure(
    error: unknown,
    reason: LaunchAbortReason,
    ctx: Omit<StepContext, 'context' | 'step'> & { logError: (msg: string) => void },
): Promise<void> {
    const { session, registry, config, control, log } = ctx;
    // Undo whatever this launch started, newest first: watcher, server.
    const undone = await control.abort(session.id, reason);
    if (undone.length) {
        log(`Rolled back: ${undone.join(', ')}`);
    }

    if (reason === 'closed' || reason === 'superseded') {
        // Nothing to report: the session is already being removed.
        log(`Launch stopped: ${describeAbortReason(reason)}`);
        return;
    }

    const message = reason === 'timeout'
        ? describeAbortReason('timeout')
        : (error instanceof Error ? error.message : String(error));
    ctx.logError(`Error during analysis: ${message}`);

    registry.updateSessionStatus(session.id, 'error', config.rethrowErrors ? 0 : undefined, message);
    if (config.setEndTime) {
        session.status = 'error';
        session.endTime = new Date();
    }

    void getHost().notifier.notify('error', `Failed to start analysis: ${message}`);

    if (config.rethrowErrors) {
        throw error instanceof LaunchAbortedError ? new Error(message) : error;
    }
}

/**
 * Settles with `work`, or rejects as soon as the launch is aborted: Close and
 * the deadline take effect at once, not when the step happens to return.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        work.catch(() => undefined);
        return Promise.reject(new LaunchAbortedError(signal.reason as LaunchAbortReason));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new LaunchAbortedError(signal.reason as LaunchAbortReason));
        signal.addEventListener('abort', onAbort, { once: true });
        work.then(
            (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
            (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}

async function startServer(ctx: StepContext): Promise<void> {
    const { session, context, registry, config, control, log, step } = ctx;
    log(`Starting server with SSE...`);
    registry.updateSessionStatus(session.id, 'analyzing', config.progress.watcherOrServer);

    const orchestrator = new ServerLaunchOrchestrator(context);
    const launch = orchestrator.launchServerForSession(
        { sessionId: session.id, targetPath: session.targetPath, serverType: 'http' },
        session,
    );
    // A server that comes up after the launch was aborted (Close or the
    // deadline hit while it was starting) is stopped as soon as it resolves:
    // `step()` below has already rejected, so nothing else would own it.
    void launch.then((result) => {
        if (result.success && result.sessionServerInfo && control.signal(session.id)?.aborted !== false) {
            void stopSessionServer(result.sessionServerInfo.serverId);
        }
    });
    const result = await step(launch);

    if (!result.success || !result.sessionServerInfo) {
        throw new Error(result.error || 'The analysis server could not be started.');
    }
    const info = result.sessionServerInfo;
    control.push(session.id, 'server', () => stopSessionServer(info.serverId));

    log(`Server started successfully on port ${info.port}`);
    registry.registerSessionPort(session.id, info.port);
    session.assignedPort = info.port;
    session.serverUrl = info.serverUrl;
    session.serverId = info.serverId;
}

async function startWatcher(ctx: StepContext, savedPath: string): Promise<void> {
    const { session, context, registry, config, control, log, step } = ctx;
    log(`Starting watcher...`);
    registry.updateSessionStatus(session.id, 'analyzing', config.progress.serverOrWatcher);

    const watcherId = await step(config.startWatcher(savedPath));
    if (watcherId) {
        log(`Watcher started successfully with ID: ${watcherId}`);
        session.watcherId = watcherId;
        control.push(session.id, 'watcher', () => new SessionWatcherManager(context).stopWatchingSession(session.id));
    } else {
        log(`Watcher could not be started`);
    }
}

/** Stops a session's server if it is still registered; silent and idempotent. */
async function stopSessionServer(serverId: string | undefined): Promise<void> {
    if (!serverId || !getActiveServerRegistry().getServer(serverId)) {
        return;
    }
    await ServerControl.stopServer(serverId, { silent: true });
}
