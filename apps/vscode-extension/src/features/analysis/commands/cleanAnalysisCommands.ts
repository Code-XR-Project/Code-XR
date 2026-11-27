/**
 * Clean Analysis
 * Startup cleanup of stale analysis files in workspace storage (run from extension.ts)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CodeXRLogger } from '../../../platform/logging/logger';
import { getSweptStorageFolders } from '../../../core/analysis/launch/storageFolders';

const logger = CodeXRLogger.getLogger('CLEAN_ANALYSIS');

export class CleanAnalysisCommands {

    /**
     * Execute cleanup of stale analysis files on plugin startup.
     */
    static async executeStartupCleanup(context: vscode.ExtensionContext, activationStartedAt: number): Promise<void> {
        try {
            await CleanAnalysisCommands.cleanStaleAnalysisArtifacts(context, activationStartedAt);
        } catch (error) {
            logger.warn('Startup cleanup failed.', error);
        }
    }

    /**
     * Clean analysis artifacts that were already present before activation
     * completed. Sessions live in memory only, so every folder written before
     * this activation belongs to a session that no longer exists. Sweeps the
     * folders the launchers actually write (LAUNCHER-14); it used to sweep
     * `storage/analysis`, which nothing writes.
     */
    private static async cleanStaleAnalysisArtifacts(
        context: vscode.ExtensionContext,
        activationStartedAt: number,
    ): Promise<boolean> {
        if (!context.storageUri) {
            return true;
        }
        let clean = true;
        for (const folderName of getSweptStorageFolders()) {
            const analysisPath = path.join(context.storageUri.fsPath, folderName);
            try {
                if (!fs.existsSync(analysisPath)) {
                    continue;
                }
                const entries = fs.readdirSync(analysisPath, { withFileTypes: true });
                for (const entry of entries) {
                    const entryPath = path.join(analysisPath, entry.name);
                    const stats = fs.statSync(entryPath);
                    if (stats.mtimeMs >= activationStartedAt) {
                        continue;
                    }

                    await this.deletePathRecursive(entryPath);
                }

                this.removeDirectoryIfEmpty(analysisPath);
            } catch (error) {
                logger.warn(`Error cleaning startup analysis artifacts in ${folderName}.`, error);
                clean = false;
            }
        }
        return clean;
    }

    private static async deletePathRecursive(targetPath: string): Promise<void> {
        if (!fs.existsSync(targetPath)) {
            return;
        }

        const stat = fs.statSync(targetPath);
        if (!stat.isDirectory()) {
            fs.unlinkSync(targetPath);
            return;
        }

        const files = fs.readdirSync(targetPath);
        for (const file of files) {
            await this.deletePathRecursive(path.join(targetPath, file));
        }

        fs.rmdirSync(targetPath);
    }

    private static removeDirectoryIfEmpty(dirPath: string): void {
        if (!fs.existsSync(dirPath)) {
            return;
        }

        if (fs.readdirSync(dirPath).length === 0) {
            fs.rmdirSync(dirPath);
        }
    }
}

