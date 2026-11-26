import type { ExtensionContextPaths } from '../../host/hostPaths';
/**
 * Directory Re-Analyzer
 * Re-analyzes only the directory entries that actually changed and updates data.json in place.
 */

import * as fs from 'fs';
import * as path from 'path';
import { UnifiedAnalysisSession } from '../session/analysisSession';
import { ExecutePython } from '../python/executePython';
import { SHA256Generator } from '../utils/sha256Generator';
import { FileHashTracker } from './fileHashTracker';
import {
    AnalysisFileEntry,
    createEmptyFileEntry,
    hasMatchingLivePanelFile,
    hasMatchingXRFile,
    isXRDataFormat,
    LivePanelAnalysisData,
    recalculateLivePanelSummary,
    removeDeletedFileFromLivePanelFormat,
    removeDeletedFileFromXRFormat,
    upsertLivePanelFiles,
    upsertXRFiles,
    XRAnalysisData,
} from './directoryReanalysisData';
import { analysisUpdateEvents } from '../../history/analysisUpdateEvents';
import { getLogger } from '../../../platform/logging/sink';
import { getHost } from '../../host/hostRegistry';

const logger = getLogger('DIRECTORY_REANALYZER');

/** A parsed data.json, in either layout; `xrFormat` says which one. */
type AnalysisData = XRAnalysisData | LivePanelAnalysisData;

interface IncrementalChangeSet {
    removedFiles?: string[];
    updatedResults?: AnalysisFileEntry[];
    addedFiles?: string[];
}

export class DirectoryReAnalyzer {
    private executePython: ExecutePython;

    constructor(context: ExtensionContextPaths) {
        this.executePython = new ExecutePython(context);
    }

    async reAnalyzeFiles(changedFiles: string[]): Promise<AnalysisFileEntry[] | null> {
        try {
            logger.debug(() => `Re-analyzing ${changedFiles.length} changed files`);
            const result = await this.executePython.executeFileReanalysis(changedFiles);

            if (!result || !Array.isArray(result)) {
                logger.error('Invalid re-analysis result');
                return null;
            }

            return result;
        } catch (error) {
            logger.error('Error during re-analysis:', error);
            return null;
        }
    }

    async applyIncrementalChanges(
        session: UnifiedAnalysisSession,
        changeSet: IncrementalChangeSet,
        hashTracker: FileHashTracker,
        options: { notifyClients?: boolean } = {},
    ): Promise<boolean> {
        try {
            if (!session.savedFilesPath) {
                logger.error('No saved files path in session');
                return false;
            }

            const dataJsonPath = path.join(session.savedFilesPath, 'data.json');
            if (!(await this.fileExists(dataJsonPath))) {
                logger.error(`data.json not found at ${dataJsonPath}`);
                return false;
            }

            const currentData = JSON.parse(await fs.promises.readFile(dataJsonPath, 'utf8'));
            const xrFormat = isXRDataFormat(currentData);
            const removedFiles = changeSet.removedFiles ?? [];
            const updatedResults = changeSet.updatedResults ?? [];
            const addedFiles = changeSet.addedFiles ?? [];

            // In this order; each non-empty step yields to the event loop after it runs.
            const steps: ReadonlyArray<readonly [number, () => boolean | Promise<boolean>]> = [
                [removedFiles.length, () => this.applyRemovedFiles(currentData, xrFormat, removedFiles, hashTracker)],
                [updatedResults.length, () => this.applyUpdatedResults(currentData, xrFormat, updatedResults)],
                [addedFiles.length, () => this.applyAddedFiles(currentData, xrFormat, session, addedFiles, hashTracker)],
            ];
            let hasChanges = false;
            for (const [count, applyStep] of steps) {
                if (count > 0) {
                    hasChanges = await applyStep() || hasChanges;
                    await this.yieldToEventLoop();
                }
            }

            if (!hasChanges) {
                return false;
            }

            const changedCount = removedFiles.length + updatedResults.length + addedFiles.length;
            await this.publishChanges(session, dataJsonPath, currentData, xrFormat, changedCount, options);
            return true;
        } catch (error) {
            logger.error('Error applying incremental changes:', error);
            return false;
        }
    }

    /**
     * Persists a changed data.json and tells everyone: the LivePanel summary is
     * recomputed and stamped, the file is replaced atomically, the update event
     * fires, the clients are notified unless the caller opted out, and the
     * status bar shows the size of the change set.
     */
    private async publishChanges(
        session: UnifiedAnalysisSession,
        dataJsonPath: string,
        currentData: XRAnalysisData | LivePanelAnalysisData,
        xrFormat: boolean,
        changedCount: number,
        options: { notifyClients?: boolean },
    ): Promise<void> {
        if (!xrFormat) {
            const livePanelData = currentData as LivePanelAnalysisData;
            recalculateLivePanelSummary(livePanelData);
            if (!livePanelData.summary) {
                livePanelData.summary = {};
            }
            livePanelData.summary.analyzedAt = new Date().toISOString();
        }

        await this.writeJsonAtomically(dataJsonPath, currentData);
        analysisUpdateEvents.emit({
            sessionId: session.id,
            targetPath: session.targetPath,
            updatedAt: new Date().toISOString(),
        });
        if (options.notifyClients !== false) {
            await this.sendSSENotification(session);
        }
        getHost().notifier.status(
            `$(check) CodeXR re-analysis updated ${changedCount} file(s)`,
            2000,
        );
    }

    private applyRemovedFiles(
        currentData: AnalysisData,
        xrFormat: boolean,
        removedFiles: string[],
        hashTracker: FileHashTracker,
    ): boolean {
        let hasChanges = false;

        for (const removedPath of removedFiles) {
            const removed = xrFormat
                ? removeDeletedFileFromXRFormat(currentData as XRAnalysisData, removedPath)
                : removeDeletedFileFromLivePanelFormat(currentData as LivePanelAnalysisData, removedPath);

            if (removed) {
                hasChanges = true;
            }

            hashTracker.untrackFile(removedPath);
        }

        return hasChanges;
    }

    private applyUpdatedResults(currentData: AnalysisData, xrFormat: boolean, updatedResults: AnalysisFileEntry[]): boolean {
        if (updatedResults.length === 0) {
            return false;
        }

        return xrFormat
            ? upsertXRFiles(currentData as XRAnalysisData, updatedResults)
            : upsertLivePanelFiles(currentData as LivePanelAnalysisData, updatedResults);
    }

    private async applyAddedFiles(
        currentData: AnalysisData,
        xrFormat: boolean,
        session: UnifiedAnalysisSession,
        addedFiles: string[],
        hashTracker: FileHashTracker,
    ): Promise<boolean> {
        const filesToAnalyze: string[] = [];

        for (const filePath of addedFiles) {
            const alreadyExists = xrFormat
                ? hasMatchingXRFile(currentData as XRAnalysisData, filePath)
                : hasMatchingLivePanelFile(currentData as LivePanelAnalysisData, filePath);

            if (!alreadyExists) {
                filesToAnalyze.push(filePath);
            }
        }

        if (filesToAnalyze.length === 0) {
            return false;
        }

        let reanalysisResults: AnalysisFileEntry[] = [];
        try {
            const results = await this.executePython.executeFileReanalysis(filesToAnalyze);
            reanalysisResults = Array.isArray(results) ? results : [results];
        } catch (error) {
            logger.error('Error analyzing new files:', error);
        }

        const resultsToUpsert: AnalysisFileEntry[] = [];
        for (const [index, filePath] of filesToAnalyze.entries()) {
            const result = reanalysisResults[index] && reanalysisResults[index].success !== false
                ? reanalysisResults[index]
                : createEmptyFileEntry(filePath, session.targetPath);
            resultsToUpsert.push(result);

            try {
                const hash = await SHA256Generator.generateFileHash(filePath);
                await hashTracker.trackNewFile(filePath, hash);
            } catch (hashError) {
                logger.error(`Error hashing added file ${filePath}:`, hashError);
                await hashTracker.trackNewFile(filePath, '');
            }
        }

        if (xrFormat) {
            upsertXRFiles(currentData as XRAnalysisData, resultsToUpsert);
        } else {
            upsertLivePanelFiles(currentData as LivePanelAnalysisData, resultsToUpsert);
        }

        return true;
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    private async writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
        await fs.promises.rename(tempPath, filePath);
    }

    private async yieldToEventLoop(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    async sendSSENotification(session: UnifiedAnalysisSession): Promise<void> {
        // SSE channels are keyed by session id, so two sessions on one target
        // (two modes, or XR and XR-deep) each refresh only their own page
        // (LAUNCHER-3).
        try {
            const { SSEManager } = require('../../server/sse/SSEManager');
            const sseManager = SSEManager.getInstance();

            if (session.analysisMode === 'XR') {
                sseManager.sendDataRefresh(session.id);
            } else {
                sseManager.sendUpdate(session.id);
            }
        } catch (sseError) {
            logger.error('SSE notification failed:', sseError);
        }
    }
}


