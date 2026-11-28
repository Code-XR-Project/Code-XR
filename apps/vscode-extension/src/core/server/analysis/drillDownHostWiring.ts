/**
 * Drill-down on an analysis server (#335): one DrillDownService per XR
 * session, analysing with the session's own Python runner and drawing with
 * the user's configured chart defaults. No session, server or watcher is
 * created for a drilled target; its dataset is a file under the static root.
 *
 * Kept out of AnalysisFeatureHost so the host only holds one slot for it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DrillDownService } from '../../drilldown/drillDownService';
import type { DrillChartResolver } from '../../drilldown/drillDownService';
import type { DrillAnalyzer, DrillSessionSeed } from '../../drilldown/drillDownDatasetBuilder';
import type { DrillDownEntity, DrillTargetKind } from '../../drilldown/drillDownModels';
import { analysisUpdateEvents } from '../../history/analysisUpdateEvents';
import { analysisRefreshCoordinator } from '../../analysis/refresh/analysisRefreshCoordinator';
import { ExecutePython } from '../../analysis/python/executePython';
import { getFileStatSnapshot, scanDirectoryScope } from '../../analysis/watchers/directorySnapshot';
import { SHA256Generator } from '../../analysis/utils/sha256Generator';
import { UnifiedSessionRegistry } from '../../analysis/session/sessionRegistry';
import { runWithLaunchSignal } from '../../analysis/launch/launchControl';
import { AnalysisConfigurationStorage } from '../../analysis/configuration/analysisConfigurationStorage';
import type { UnifiedAnalysisSession } from '../../analysis/session/analysisSession';
import { getHost } from '../../host/hostRegistry';
import type { CoreContext } from '../../host/hostPaths';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('DRILL_DOWN');

/** Debounce between a save and the refresh of a drilled view. */
const SOURCE_CHANGE_DEBOUNCE_MS = 300;

export interface DrillDownSlot {
    readonly service: DrillDownService | null;
    readonly reason: string;
}

export const DRILL_DOWN_NOT_ATTACHED: DrillDownSlot = Object.freeze({
    service: null,
    reason: 'Drill-down is not available for this server.',
});

export interface DrillDownWiringInput {
    /** False when the server's capabilities leave drill-down out. */
    readonly enabled: boolean;
    readonly session: Pick<UnifiedAnalysisSession, 'targetType' | 'targetPath' | 'isDeep' | 'savedFilesPath' | 'filesToHash'> | null | undefined;
    readonly sessionId: string;
    readonly staticRoot: string;
    readonly context: CoreContext;
    readonly publish: (entity: DrillDownEntity) => void;
    readonly activate: (mode: 'drill-down' | 'single') => void | Promise<void>;
    readonly disposables: Array<() => void>;
    /** Tests replace the Python run, the settings lookup and the session seed. */
    readonly analyzer?: DrillAnalyzer;
    readonly readSessionSeed?: () => DrillSessionSeed | null;
    readonly resolveChart?: DrillChartResolver;
    readonly workspaceFolders?: readonly string[];
}

/**
 * The managed Python runner, cancellable through the signal: per-file
 * summaries for folders (the incremental re-analysis' coordinator), the XR
 * file analysis for one file, and the analyzer's own file policy to list a
 * folder.
 */
export function createPythonDrillAnalyzer(context: CoreContext): DrillAnalyzer {
    return {
        listFolderFiles: async (folder, deep) => (await scanDirectoryScope(folder, deep)).files.map((file) => file.filePath),
        analyzeFiles: async (files, signal) => {
            if (!files.length) {
                return [];
            }
            const rows = await runWithLaunchSignal(signal, () => new ExecutePython(context).executeFileReanalysis([...files]));
            return Array.isArray(rows) ? rows : [];
        },
        analyzeFunctions: async (absolutePath, signal) => {
            // ExecutePython only reads these four fields; this is not a registered session.
            const pseudoSession = {
                analysisMode: 'XR',
                targetType: 'file',
                targetPath: absolutePath,
                isDeep: false,
            } as unknown as UnifiedAnalysisSession;
            const rows = await runWithLaunchSignal(signal, () =>
                new ExecutePython(context).executeAnalysis(pseudoSession, { silent: true }));
            if (!Array.isArray(rows)) {
                throw new Error('The analysis returned no rows.');
            }
            return rows;
        },
        io: {
            stat: (absolutePath) => getFileStatSnapshot(absolutePath),
            hash: (absolutePath) => SHA256Generator.generateFileHash(absolutePath),
        },
    };
}

/** The chart and mapping configured for file or folder analyses (Analysis settings). */
export function createConfiguredChartResolver(context: CoreContext): DrillChartResolver {
    return async (kind: DrillTargetKind) => {
        const storage = AnalysisConfigurationStorage.getInstance(context);
        const chartId = kind === 'file' ? await storage.getChartTypeFile() : await storage.getDirectoryChartType();
        const mapping = kind === 'file' ? await storage.getDimensionMappingFile() : await storage.getDimensionMappingDirectory();
        return { chartId: String(chartId || 'boats'), mapping: { ...(mapping as Record<string, string>) } };
    };
}

function workspaceFoldersOf(input: DrillDownWiringInput): readonly string[] {
    if (input.workspaceFolders) {
        return input.workspaceFolders;
    }
    try {
        return getHost().workspaceFolders();
    } catch {
        return [];
    }
}

export function wireDrillDown(input: DrillDownWiringInput): DrillDownSlot {
    if (!input.enabled || !input.session) {
        return DRILL_DOWN_NOT_ATTACHED;
    }
    const session = input.session;
    const sessionDataPath = path.join(session.savedFilesPath || input.staticRoot, 'data.json');
    // The table's own rows and the hashes the watcher keeps current: files of
    // the project analysis are never sent to Python again.
    const readSessionSeed = input.readSessionSeed ?? ((): DrillSessionSeed | null => {
        try {
            const rows = JSON.parse(fs.readFileSync(sessionDataPath, 'utf8'));
            const live = UnifiedSessionRegistry.getInstance(input.context).getSession(input.sessionId);
            return { rows: Array.isArray(rows) ? rows : [], hashes: live?.filesToHash ?? session.filesToHash ?? [] };
        } catch {
            return null;
        }
    });
    const service = new DrillDownService({
        targetPath: session.targetPath,
        targetType: session.targetType,
        isDeep: session.isDeep === true,
        staticRoot: input.staticRoot,
        workspaceFolders: workspaceFoldersOf(input),
        analyzer: input.analyzer ?? createPythonDrillAnalyzer(input.context),
        readSessionSeed,
        resolveChart: input.resolveChart ?? createConfiguredChartResolver(input.context),
        publish: (entity) => {
            analysisRefreshCoordinator.setSnapshotAvailable(input.sessionId, 'drill-down', typeof entity.datasetUrl === 'string');
            input.publish(entity);
        },
        activate: input.activate,
    });
    let timer: NodeJS.Timeout | null = null;
    const unsubscribe = analysisUpdateEvents.on((event) => {
        if (event.sessionId !== input.sessionId) {
            return;
        }
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            service.handleSourcesChanged().catch((error) => logger.warn('[CodeXR][DrillDown] Live refresh failed:', error));
        }, SOURCE_CHANGE_DEBOUNCE_MS);
    });
    // Only a real move from the drilled view to the classic one (the Analyses
    // menu) makes home current. The coordinator emits its state on every
    // change, snapshot availability included, so a bare `mode === 'single'`
    // would also fire while a jump is publishing, before the table switched.
    let lastMode: string | null = null;
    const unsubscribeView = analysisRefreshCoordinator.onStateChanged(input.sessionId, (view) => {
        const previous = lastMode;
        lastMode = view.mode;
        if (view.mode === 'single' && previous === 'drill-down') {
            service.noteHomeShown();
        }
    });
    input.disposables.push(unsubscribe, unsubscribeView, () => {
        if (timer) {
            clearTimeout(timer);
        }
    });
    return { service, reason: '' };
}

/** The `drillDown` entry of the server's availability snapshot. */
export function drillDownAvailability(slot: DrillDownSlot): { enabled: boolean; reason: string | null } {
    return slot.service ? { enabled: true, reason: null } : { enabled: false, reason: slot.reason };
}

export function releaseDrillDown(slot: DrillDownSlot): DrillDownSlot {
    slot.service?.dispose();
    return DRILL_DOWN_NOT_ATTACHED;
}
