/**
 * Unified Session Registry
 * Only the essentials for creating and managing sessions
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { generateNonce } from '../../../shared/nonceGenerator';
import { 
    UnifiedAnalysisSession, 
    AnalysisMode, 
    TargetType, 
    AnalysisStatus,
    SessionCreationParams
} from './analysisSession';
import { SHA256Generator } from '../utils/sha256Generator';
import { getLogger } from '../../../platform/logging/sink';
import { targetKey } from '../launch/targetKey';

const logger = getLogger('UNIFIED_REGISTRY');

/**
 * What createSession did: built a new session, or found a live one for the
 * same target, mode, type and depth (re-announced, not recreated). Telling the
 * user is the caller's job (AnalysisOrchestrator).
 */
export type SessionCreationResult =
    | { kind: 'created'; session: UnifiedAnalysisSession }
    | { kind: 'duplicate'; existing: UnifiedAnalysisSession };


export class UnifiedSessionRegistry {
    private static instance: UnifiedSessionRegistry;
    private sessions: Map<string, UnifiedAnalysisSession> = new Map();
    private _onSessionChanged = new vscode.EventEmitter<UnifiedAnalysisSession>();
    public readonly onSessionChanged = this._onSessionChanged.event;

    private constructor(_context: vscode.ExtensionContext) {
        logger.debug('Initializing session registry');
    }

    static getInstance(context: vscode.ExtensionContext): UnifiedSessionRegistry {
        if (!UnifiedSessionRegistry.instance) {
            UnifiedSessionRegistry.instance = new UnifiedSessionRegistry(context);
        }
        return UnifiedSessionRegistry.instance;
    }

    /**
     * Check if a session with the same parameters already exists
     * A session is considered duplicate if it has the same:
     * - targetPath
     * - analysisMode
     * - targetType
     * - isDeep
     */
    private hasDuplicateSession(params: SessionCreationParams): UnifiedAnalysisSession | null {
        const existingSessions = this.getAllSessions();

        // Compared by normalised key, not raw string: `C:\p\a.ts` and
        // `c:\p\a.ts` are one target (LAUNCHER-17).
        const wantedKey = targetKey(params.targetPath);
        for (const session of existingSessions) {
            const isDuplicate =
                targetKey(session.targetPath) === wantedKey &&
                session.analysisMode === params.analysisMode &&
                session.targetType === params.targetType &&
                session.isDeep === (params.isDeep || false) &&
                session.status !== 'closed' &&
                session.status !== 'error';

            if (isDuplicate) {
                logger.debug(() => `Duplicate session detected for ${params.targetPath}`);
                return session;
            }
        }

        return null;
    }

    /**
     * Create a new unified analysis session - SIMPLIFIED
     */
    async createSession(params: SessionCreationParams): Promise<SessionCreationResult> {
        try {
            logger.debug(`Creating session`, {
                targetPath: params.targetPath,
                analysisMode: params.analysisMode,
                targetType: params.targetType,
                isDeep: params.isDeep || false
            });

            const duplicateSession = this.hasDuplicateSession(params);
            if (duplicateSession) {
                this._onSessionChanged.fire(duplicateSession);
                return { kind: 'duplicate', existing: duplicateSession };
            }

            const id = generateNonce();
            const targetName = path.basename(params.targetPath);
            const { outputDirectory, outputPath } = this.buildSessionPaths(params, id, targetName);

            // Reserve BEFORE the first await (LAUNCHER-4): the duplicate check
            // above and this insertion run in the same tick, so a double click
            // finds the first session already registered as `creating`. The
            // hash and the directory check below used to run in between, which
            // let two launches of one target through.
            const session: UnifiedAnalysisSession = {
                id,
                targetPath: params.targetPath,
                targetType: params.targetType,
                targetName,
                analysisMode: params.analysisMode,
                isDeep: params.isDeep || false,
                status: 'creating',
                startTime: new Date(),
                hash256: '',
                outputDirectory,
                outputPath,
                requiredFiles: new Map<string, string>(),
                templatePaths: new Map<string, string>(),
                metadata: {}
            };

            this.sessions.set(id, session);

            try {
                if (params.targetType === 'file') {
                    session.hash256 = await this.hashTargetFile(params.targetPath);
                } else {
                    await this.assertDirectoryTarget(params.targetPath);

                    // Directory scanning and initial hashes are populated after Python
                    // completes the first analysis, keeping the startup path lightweight.
                    session.directoriesToAnalyze = [];
                    session.filesToHash = [];
                    logger.debug('Directory session will populate tracked files after initial analysis');
                }
            } catch (validationError) {
                // Release the reservation: a target that cannot be read must
                // not block the next attempt as "already in progress".
                this.sessions.delete(id);
                throw validationError;
            }

            this._onSessionChanged.fire(session);

            logger.debug(() => `Created session ${id} for ${targetName}`);
            return { kind: 'created', session };

        } catch (error) {
            logger.error('Error creating session:', error);
            throw error;
        }
    }

    /**
     * `<target name without extension>_<mode>_<type>_<id>`, under
     * `fileAnalysis/` or `directoryAnalysis/` in the workspace storage.
     */
    private buildSessionPaths(
        params: SessionCreationParams,
        id: string,
        targetName: string,
    ): { outputDirectory: string; outputPath: string } {
        const storageUri = params.context.storageUri;
        if (!storageUri) {
            throw new Error('Workspace storage URI is not available');
        }

        const outputDirectory = `${path.parse(targetName).name}_${params.analysisMode}_${params.targetType}_${id}`;
        const baseDirectory = params.targetType === 'file' ? 'fileAnalysis' : 'directoryAnalysis';
        const outputPath = path.join(storageUri.fsPath, baseDirectory, outputDirectory);
        return { outputDirectory, outputPath };
    }

    private async hashTargetFile(targetPath: string): Promise<string> {
        try {
            return await SHA256Generator.generateFileHash(targetPath);
        } catch (hashError) {
            logger.error(`Error calculating file hash:`, hashError);
            throw new Error(`Failed to calculate file hash: ${hashError instanceof Error ? hashError.message : String(hashError)}`);
        }
    }

    private async assertDirectoryTarget(targetPath: string): Promise<void> {
        try {
            const stats = await fs.stat(targetPath);
            if (!stats.isDirectory()) {
                throw new Error(`Target path is not a directory: ${targetPath}`);
            }
        } catch (statError) {
            logger.error(`Error accessing target path ${targetPath}:`, statError);
            throw statError;
        }
    }

    /**
     * Update session status - COMPATIBLE
     */
    updateSessionStatus(sessionId: string, status: AnalysisStatus, progress?: number, error?: string): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }

        session.status = status;
        if (progress !== undefined) {
            session.progress = progress;
        }
        if (error) {
            session.error = error;
        }
        if (status === 'monitoring' || status === 'error' || status === 'closed') {
            session.endTime = new Date();
        }

        this._onSessionChanged.fire(session);
        return true;
    }

    /**
     * Add required file to session
     */
    addRequiredFile(sessionId: string, fileName: string, content: string): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }

        session.requiredFiles.set(fileName, content);
        this._onSessionChanged.fire(session);
        return true;
    }

    /**
     * Get session by ID
     */
    getSession(sessionId: string): UnifiedAnalysisSession | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * Get all sessions
     */
    getAllSessions(): UnifiedAnalysisSession[] {
        return Array.from(this.sessions.values());
    }

    /**
     * Remove session by ID
     */
    removeSession(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }

        // Mark as closed before removal
        session.status = 'closed';
        session.endTime = new Date();
        
        // Remove from registry
        const removed = this.sessions.delete(sessionId);
        
        if (removed) {
            logger.debug(() => `Removed session ${sessionId} (${session.targetName})`);
            this._onSessionChanged.fire(session);
        }
        
        return removed;
    }

    /**
     * Get active sessions - SIMPLE
     */
    getActiveSessions(): UnifiedAnalysisSession[] {
        return this.getAllSessions().filter(s => 
            s.status === 'creating' || s.status === 'analyzing' || s.status === 'monitoring'
        );
    }

    /**
     * Set session monitoring - SIMPLE
     */
    setSessionMonitoring(sessionId: string, port?: number): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }

        session.status = 'monitoring';
        session.endTime = new Date();
        if (port) {
            session.port = port;
        }

        this._onSessionChanged.fire(session);
        return true;
    }

    /**
     * Register server port for session - Centralized function for port assignment
     */
    registerSessionPort(sessionId: string, port: number): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.warn(`Session ${sessionId} not found for port registration`);
            return false;
        }

        session.port = port;
        session.assignedPort = port;

        logger.debug(() => `Registered port ${port} for session ${sessionId}`);

        this._onSessionChanged.fire(session);
        return true;
    }

    /**
     * Get sessions by target path - SIMPLE
     */
    getSessionsByTargetPath(targetPath: string): UnifiedAnalysisSession[] {
        const wantedKey = targetKey(targetPath);
        return this.getAllSessions().filter(s => targetKey(s.targetPath) === wantedKey);
    }

    /**
     * Get sessions by analysis mode - SIMPLE
     */
    getSessionsByAnalysisMode(analysisMode: AnalysisMode): UnifiedAnalysisSession[] {
        return this.getAllSessions().filter(s => s.analysisMode === analysisMode);
    }

    /**
     * Get sessions by target type - SIMPLE
     */
    getSessionsByTargetType(targetType: TargetType): UnifiedAnalysisSession[] {
        return this.getAllSessions().filter(s => s.targetType === targetType);
    }

    /**
     * Clean up old sessions - COMPATIBLE
     */
    cleanupOldSessions(maxAge?: number): number {
        const now = Date.now();
        const ageLimit = maxAge || 3600000; // Default 1 hour
        let cleaned = 0;
        
        for (const [id, session] of this.sessions) {
            if (session.status === 'closed' && session.endTime) {
                const age = now - session.endTime.getTime();
                if (age > ageLimit) {
                    this.sessions.delete(id);
                    cleaned++;
                }
            }
        }
        
        return cleaned;
    }

    /**
     * Get statistics - SIMPLE
     */
    getStatistics() {
        const sessions = this.getAllSessions();
        return {
            total: sessions.length,
            active: this.getActiveSessions().length,
            monitoring: sessions.filter(s => s.status === 'monitoring').length,
            error: sessions.filter(s => s.status === 'error').length,
            closed: sessions.filter(s => s.status === 'closed').length
        };
    }

    /**
     * Close session - SIMPLIFIED
     */
    closeSession(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }

        session.status = 'closed';
        session.endTime = new Date();
        this._onSessionChanged.fire(session);
        
        // Remove after delay
        setTimeout(() => this.sessions.delete(sessionId), 2000);
        return true;
    }


    /**
     * Dispose of registry - SIMPLIFIED
     */
    dispose(): void {
        logger.debug('Disposing session registry');
        
        this._onSessionChanged.dispose();
        this.sessions.clear();
    }
}
