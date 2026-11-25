/**
 * Active Analyses Data Service
 * Provides data for the Active Analyses TreeView
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { UnifiedAnalysisSession } from '../../../../engine/core/analysisSession';
import { UnifiedSessionRegistry } from '../../../../engine/core/sessionRegistry';
import type { CodeAnalysisTreeItem } from '../../../../views/items/analysisItems';
import { getLogger } from '../../../../../core/logging/sink';

const logger = getLogger('ACTIVE_ANALYSES_DATA_SERVICE');

export interface ActiveAnalysisItem {
    // Core session properties - SIMPLIFIED
    id: string;
    sessionId: string;
    label: string;
    description?: string;
    analysisType: string;
    status: string;
    filePath?: string;
    targetPath?: string;
    resourceUri?: vscode.Uri;
    contextValue: string;
    iconPath?: vscode.ThemeIcon;
    serverUrl?: string;
    assignedPort?: number;
    // Direct session reference for commands - NO MORE COMPLEX TRANSFORMATIONS
    session: UnifiedAnalysisSession;
}

/**
 * The session fields copied onto the TreeItem: VS Code passes the TreeItem,
 * not the element, to context-menu commands, and they locate the session
 * through these.
 */
type ActiveAnalysisTreeItem = vscode.TreeItem & Pick<
    ActiveAnalysisItem,
    'sessionId' | 'analysisType' | 'status' | 'targetPath' | 'serverUrl' | 'assignedPort'
>;

/** Icon colour per analysis mode for file targets; legacy mode names included. */
const FILE_ICON_COLORS: Readonly<Record<string, string>> = {
    LivePanel: 'charts.green',
    FileLivePanel: 'charts.green',
    XR: 'charts.purple',
    FileXRAnalysis: 'charts.purple',
    VisualizeDOM: 'charts.orange',
    FileVisualizeDOM: 'charts.orange',
};

/** Icon colour per analysis mode for directory targets; legacy mode names included. */
const DIRECTORY_ICON_COLORS: Readonly<Record<string, string>> = {
    LivePanel: 'charts.green',
    DirectoryLivePanel: 'charts.green',
    DeepDirectoryLivePanel: 'charts.green',
    XR: 'charts.purple',
    DirectoryXRAnalysis: 'charts.purple',
    DeepDirectoryXRAnalysis: 'charts.purple',
    VisualizeDOM: 'charts.orange',
};

/**
 * The tree item's resourceUri: the trimmed, normalized target path, or
 * undefined for a blank or non-string path, or one Uri.file rejects.
 */
function safeResourceUri(targetPath: unknown): vscode.Uri | undefined {
    if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
        return undefined;
    }
    try {
        return vscode.Uri.file(path.normalize(targetPath.trim()));
    } catch (uriError) {
        logger.warn(`Invalid path for URI creation: ${targetPath}`, uriError);
        return undefined;
    }
}

export class ActiveAnalysesDataService {
    private static instance: ActiveAnalysesDataService;
    private _onDidChangeTreeData: vscode.EventEmitter<ActiveAnalysisItem | undefined | null | void> = new vscode.EventEmitter<ActiveAnalysisItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ActiveAnalysisItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private sessionRegistry: UnifiedSessionRegistry | null = null;

    private constructor() {
        logger.debug('Initialized');
    }

    public static getInstance(): ActiveAnalysesDataService {
        if (!ActiveAnalysesDataService.instance) {
            ActiveAnalysesDataService.instance = new ActiveAnalysesDataService();
        }
        return ActiveAnalysesDataService.instance;
    }

    public initialize(context: vscode.ExtensionContext): void {
        if (!this.sessionRegistry) {
            this.sessionRegistry = UnifiedSessionRegistry.getInstance(context);
            
            // Listen to session changes
            this.sessionRegistry.onSessionChanged(() => {
                this.refresh();
            });
        }
    }

    /**
     * Refresh the tree view
     */
    public refresh(): void {
        logger.debug('Refreshing tree view');
        this._onDidChangeTreeData.fire();
    }

    /**
     * Get tree children
     */
    public getChildren(element?: ActiveAnalysisItem): Promise<ActiveAnalysisItem[]> {
        if (!element) {
            // Root level - return all active analyses
            return Promise.resolve(this.getAllActiveAnalyses());
        } else {
            // No children for analysis items - flat list
            return Promise.resolve([]);
        }
    }

    /**
     * Get tree item
     */
    public getTreeItem(element: ActiveAnalysisItem): vscode.TreeItem {
        try {
            if (!element) {
                logger.error('getTreeItem called with null/undefined element');
                return new vscode.TreeItem('Error: Invalid item');
            }

            const item = new vscode.TreeItem(element.label || 'Unknown Analysis');
            item.description = element.description;
            item.contextValue = element.contextValue;
            
            // Safely set resourceUri
            if (element.resourceUri) {
                try {
                    item.resourceUri = element.resourceUri;
                } catch (uriError) {
                    logger.warn('Error setting resourceUri:', uriError);
                    item.resourceUri = undefined;
                }
            }
            
            item.iconPath = element.iconPath;
            
            // CRITICAL: Add sessionId to the TreeItem so commands can locate the session
            // VS Code passes the TreeItem object to context menu commands, not the original element
            (item as ActiveAnalysisTreeItem).sessionId = element.sessionId;
            (item as ActiveAnalysisTreeItem).id = element.id;
            (item as ActiveAnalysisTreeItem).analysisType = element.analysisType;
            (item as ActiveAnalysisTreeItem).status = element.status;
            (item as ActiveAnalysisTreeItem).targetPath = element.targetPath;
            (item as ActiveAnalysisTreeItem).serverUrl = element.serverUrl;
            (item as ActiveAnalysisTreeItem).assignedPort = element.assignedPort;
            
            logger.debug('Created TreeItem with session info:', {
                sessionId: element.sessionId,
                id: element.id,
                label: element.label,
                targetPath: element.targetPath
            });
            
            item.tooltip = element.description
                ? `${element.description}\n\nLeft-click to show available actions.`
                : 'Left-click to show available actions.';

            // Add command to show available actions when clicked.
            item.command = {
                command: 'codeXR.analysis.activeAnalyses.showActions',
                title: 'Show Analysis Actions',
                arguments: element ? [element] : [] // Ensure arguments array is never undefined
            };
            
            // Analysis items are always leaf nodes (no children)
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            
            return item;
        } catch (error) {
            logger.error('Error in getTreeItem:', error);
            return new vscode.TreeItem('Error: Failed to create tree item');
        }
    }

    /**
     * Get all active analyses
     */
    private getAllActiveAnalyses(): ActiveAnalysisItem[] {
        const analyses: ActiveAnalysisItem[] = [];

        try {
            if (!this.sessionRegistry) {
                logger.warn('Session registry not initialized');
                return analyses;
            }

            // Get all sessions with safety check
            let allSessions;
            try {
                allSessions = this.sessionRegistry.getAllSessions();
            } catch (error) {
                logger.error('Error getting sessions from registry:', error);
                return analyses;
            }

            if (!Array.isArray(allSessions)) {
                logger.warn('getAllSessions() returned non-array:', typeof allSessions);
                return analyses;
            }

            logger.debug(() => `Found ${allSessions.length} sessions`);
            
            for (const session of allSessions) {
                if (!session) {
                    logger.warn('Found null/undefined session in registry');
                    continue;
                }
                
                if (session.status !== 'closed') {
                    try {
                        // Determine type based on session properties
                        const type = session.targetType === 'directory' ? 'directory' : 'file';
                        const analysisItem = this.createAnalysisItem(session, type);
                        if (analysisItem) {
                            analyses.push(analysisItem);
                        }
                    } catch (error) {
                        logger.error(`Error creating analysis item for session: ${session.id}`, error);
                    }
                }
            }

        } catch (error) {
            logger.error('Error getting analyses:', error);
        }

        logger.debug(() => `Returning ${analyses.length} active analyses`);
        return analyses;
    }

    /**
     * Create analysis item for tree view
     */
    private createAnalysisItem(session: UnifiedAnalysisSession, type: 'file' | 'directory'): ActiveAnalysisItem | null {
        try {
            if (!session) {
                logger.warn('Cannot create analysis item - session is null/undefined');
                return null;
            }

            if (!session.id) {
                logger.warn('Cannot create analysis item - session has no ID');
                return null;
            }

            // Use analysis type icon instead of status icon for better visual differentiation
            const analysisIcon = this.getAnalysisTypeIcon(session.analysisMode, type);
            const analysisTypeLabel = this.getAnalysisTypeLabel(session.analysisMode);
            
            // Safe property access with fallbacks
            const targetName = session.targetName || (session.targetPath ? path.basename(session.targetPath) : 'Unknown');
            const status = session.status || 'unknown';
            const analysisMode = session.analysisMode || 'unknown';
            const targetPath = session.targetPath;
            
            const resourceUri = safeResourceUri(targetPath);
            
            logger.debug('Creating analysis item for session:', {
                sessionId: session.id,
                targetName: targetName,
                targetPath: targetPath
            });
            
            return {
                id: session.id,
                sessionId: session.id, // For command compatibility
                label: targetName,
                description: `${analysisTypeLabel} - ${this.getStatusLabel(status)}`,
                analysisType: analysisMode,
                status: status,
                filePath: targetPath || undefined,
                targetPath: targetPath || undefined,
                serverUrl: session.serverUrl || undefined,
                assignedPort: session.assignedPort || undefined,
                resourceUri: resourceUri,
                // Fix contextValue to match package.json patterns - remove type from the middle
                contextValue: `activeAnalysis.${status}`,
                iconPath: analysisIcon,
                // SIMPLIFIED: Direct session reference for commands
                session: session
            };
        } catch (error) {
            logger.error('Error creating analysis item:', error);
            return null;
        }
    }

    /**
     * Get analysis type icon based on analysis mode and target type: a file or
     * folder icon, coloured by mode (green LivePanel, purple XR, orange DOM).
     */
    private getAnalysisTypeIcon(analysisMode: string, targetType: 'file' | 'directory'): vscode.ThemeIcon {
        const iconId = targetType === 'file' ? 'file' : 'folder';
        const colors = targetType === 'file' ? FILE_ICON_COLORS : DIRECTORY_ICON_COLORS;
        const color = Object.prototype.hasOwnProperty.call(colors, analysisMode) ? colors[analysisMode] : undefined;
        return color ? new vscode.ThemeIcon(iconId, new vscode.ThemeColor(color)) : new vscode.ThemeIcon(iconId);
    }

    /**
     * Get status label
     */
    private getStatusLabel(status: string): string {
        switch (status) {
            case 'creating':
                return 'Creating...';
            case 'analyzing':
                return 'Analyzing...';
            case 'monitoring':
                return 'Monitoring';
            case 'completed':
                return 'Ready';
            case 'error':
                return 'Error';
            case 'failed':
                return 'Failed';
            case 'closed':
                return 'Closed';
            case 'closing':
                return 'Closing...';
            default:
                return status;
        }
    }

    /**
     * Get analysis type label
     */
    private getAnalysisTypeLabel(analysisType: string): string {
        switch (analysisType) {
            // New engine modes
            case 'LivePanel':
                return 'Live Panel';
            case 'XR':
                return 'XR Analysis';
            case 'VisualizeDOM':
                return 'Visualize DOM';
            // Legacy modes
            case 'FileLivePanel':
                return 'Live Panel';
            case 'FileVisualizeDOM':
                return 'Visualize DOM';
            case 'FileXRAnalysis':
                return 'XR Analysis';
            case 'DirectoryLivePanel':
                return 'Directory Live Panel';
            case 'DeepDirectoryLivePanel':
                return 'Deep Directory Live Panel';
            case 'DirectoryXRAnalysis':
                return 'Directory XR Analysis';
            case 'DeepDirectoryXRAnalysis':
                return 'Deep Directory XR Analysis';
            default:
                return analysisType;
        }
    }

    /**
     * Get analysis by ID
     */
    public getAnalysisById(id: string): UnifiedAnalysisSession | undefined | null {
        try {
            if (!this.sessionRegistry) {
                logger.warn('Session registry not initialized');
                return null;
            }

            return this.sessionRegistry.getSession(id);
        } catch (error) {
            logger.error(`Error getting analysis ${id}:`, error);
            return null;
        }
    }

    /**
     * Get analysis count by status
     */
    public getAnalysisCountByStatus(): { creating: number; analyzing: number; monitoring: number; completed: number; error: number; failed: number; closed: number; closing: number; total: number } {
        const analyses = this.getAllActiveAnalyses();
        
        const counts = {
            creating: 0,
            analyzing: 0,
            monitoring: 0,
            completed: 0,
            error: 0,
            failed: 0,
            closed: 0,
            closing: 0,
            total: analyses.length
        };

        for (const analysis of analyses) {
            switch (analysis.status) {
                case 'creating':
                    counts.creating++;
                    break;
                case 'analyzing':
                    counts.analyzing++;
                    break;
                case 'monitoring':
                    counts.monitoring++;
                    break;
                case 'completed':
                    counts.completed++;
                    break;
                case 'error':
                    counts.error++;
                    break;
                case 'failed':
                    counts.failed++;
                    break;
                case 'closed':
                    counts.closed++;
                    break;
                case 'closing':
                    counts.closing++;
                    break;
            }
        }

        return counts;
    }

    /**
     * Get active analyses (alias for getAllActiveAnalyses for compatibility)
     */
    public getActiveAnalyses(): ActiveAnalysisItem[] {
        return this.getAllActiveAnalyses();
    }

    /**
     * Get subsection item for the tree (SIMPLIFIED integration)
     */
    public getSubsectionItem(): CodeAnalysisTreeItem {
        try {
            const activeCount = this.getAllActiveAnalyses().length;
            return {
                label: `Active Analyses (${activeCount})`,
                collapsibleState: 1, // Expanded
                contextValue: 'activeAnalysesSubsection',
                analysisItemType: 'subsection',
                iconPath: new vscode.ThemeIcon(
                    'play-circle',
                    activeCount > 0 ? new vscode.ThemeColor('charts.green') : new vscode.ThemeColor('charts.gray')
                ),
                tooltip: `${activeCount} active analysis sessions`,
                description: activeCount > 0 ? `${activeCount} running` : 'No active sessions'
            };
        } catch (error) {
            logger.error('Error creating subsection item:', error);
            return {
                label: 'Active Analyses (Error)',
                collapsibleState: 1,
                contextValue: 'activeAnalysesSubsection',
                analysisItemType: 'subsection',
                iconPath: new vscode.ThemeIcon('error'),
                tooltip: 'Error loading active analyses',
                description: 'Error'
            };
        }
    }
}

