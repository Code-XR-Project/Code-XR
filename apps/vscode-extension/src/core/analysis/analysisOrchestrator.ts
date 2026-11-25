/**
 * Analysis Orchestrator
 * Central coordinator for all analysis operations in the new engine
 */

import * as vscode from 'vscode';
import { resolveLauncher } from './launch/launchKinds';
import { UnifiedSessionRegistry } from './session/sessionRegistry';
import { UnifiedAnalysisSession, AnalysisMode, TargetType } from './session/analysisSession';
import { getLogger } from '../../platform/logging/sink';

const logger = getLogger('ANALYSIS_ORCHESTRATOR');

/**
 * Tells the user why a duplicate request was refused. A finished analysis
 * offers to open the Active Analyses view.
 */
function warnAboutDuplicateSession(duplicateSession: UnifiedAnalysisSession): void {
    if (duplicateSession.status === 'monitoring') {
        void vscode.window.showWarningMessage(
            `Analysis already complete for "${duplicateSession.targetName}". Use Active Analyses panel to view results.`,
            'Open Active Analyses'
        ).then(choice => {
            if (choice === 'Open Active Analyses') {
                void vscode.commands.executeCommand('workbench.view.extension.codeXRView');
            }
        });
    } else if (duplicateSession.status === 'creating' || duplicateSession.status === 'analyzing') {
        void vscode.window.showWarningMessage(
            `Analysis for "${duplicateSession.targetName}" is already in progress (${duplicateSession.status})...`
        );
    } else {
        void vscode.window.showWarningMessage(
            `Analysis session for "${duplicateSession.targetName}" already exists with status: ${duplicateSession.status}`
        );
    }
}

export class AnalysisOrchestrator {
    
    /**
     * Orchestrate analysis based on mode, target type and depth
     */
    static async orchestrateAnalysis(
        targetPath: string,
        analysisMode: AnalysisMode,
        targetType: TargetType,
        context: vscode.ExtensionContext,
        isDeep: boolean = false
    ): Promise<void> {
        logger.debug(() => `Orchestrating ${analysisMode} analysis for ${targetType}: ${targetPath} (deep: ${isDeep})`);
        
        try {
            // Create unified session first - CENTRALIZED SESSION CREATION
            const registry = UnifiedSessionRegistry.getInstance(context);
            let session: UnifiedAnalysisSession;
            
            try {
                logger.debug(`DEBUG - Creating session with parameters:`, {
                    targetPath,
                    targetType,
                    analysisMode,
                    isDeep
                });
                
                const creation = await registry.createSession({
                    targetPath,
                    targetType,
                    analysisMode,
                    isDeep,
                    context
                });
                
                if (creation.kind === 'duplicate') {
                    logger.debug(`Session creation skipped (duplicate detected) - stopping orchestration`);
                    warnAboutDuplicateSession(creation.existing);
                    return;
                }
                session = creation.session;
                
            } catch (sessionError) {
                // Handle session creation errors (e.g., unsupported file types)
                logger.error(`Session creation failed:`, sessionError);
                const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
                void vscode.window.showErrorMessage(`CodeXR Analysis Error: ${errorMessage}`);
                throw sessionError;
            }
            
            logger.debug(() => `Created session ${session.id} for ${analysisMode} analysis`);
            logger.debug(`Session details:`, {
                id: session.id,
                targetName: session.targetName,
                targetPath: session.targetPath,
                analysisMode: session.analysisMode,
                targetType: session.targetType,
                isDeep: session.isDeep,
                status: session.status
            });
            
            // One table of launch kinds (launch/launchKinds.ts) instead of a
            // switch per mode and target type. Resolved before anything runs,
            // so an unsupported combination is refused, not half-launched.
            let launch: ReturnType<typeof resolveLauncher>;
            try {
                launch = resolveLauncher(analysisMode, session.targetType);
            } catch (unsupported) {
                registry.removeSession(session.id);
                throw unsupported;
            }
            await launch(session, context);

        } catch (error) {
            logger.error('Error orchestrating analysis:', error);
            throw error;
        }
    }
    
    /**
     * Get analysis type identifier for the given parameters
     */
    static getAnalysisTypeId(analysisMode: AnalysisMode, targetType: TargetType, isDeep: boolean): string {
        const modePrefix = analysisMode === 'LivePanel' ? 'LP' : 
                          analysisMode === 'XR' ? 'XR' : 
                          analysisMode === 'VisualizeDOM' ? 'DOM' : 'UNKNOWN';
        const targetPrefix = targetType === 'file' ? 'File' : 'Dir';
        const depthSuffix = isDeep ? 'Deep' : '';
        
        return `${modePrefix}_${targetPrefix}${depthSuffix}`;
    }
}
