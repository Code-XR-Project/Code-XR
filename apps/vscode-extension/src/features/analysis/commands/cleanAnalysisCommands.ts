/**
 * Clean Analysis
 * Startup cleanup of stale analysis files in workspace storage (run from extension.ts)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CodeXRLogger } from '../../../platform/logging/logger';

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
     * Clean analysis artifacts that were already present before activation completed.
     */
    private static async cleanStaleAnalysisArtifacts(
        context: vscode.ExtensionContext,
        activationStartedAt: number,
    ): Promise<boolean> {
        try {
            const analysisPath = this.getAnalysisPath(context);
            if (!analysisPath || !fs.existsSync(analysisPath)) {
                return true;
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
            return true;
        } catch (error) {
            logger.warn('Error cleaning startup analysis artifacts.', error);
            return false;
        }
    }

    private static getAnalysisPath(context: vscode.ExtensionContext): string | null {
        if (!context.storageUri) {
            return null;
        }

        return path.join(context.storageUri.fsPath, 'analysis');
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

