import * as vscode from 'vscode';
import { ThemeUtils } from '../utils/themeUtils';
import { UnifiedAnalysisSession } from '../session/analysisSession';
import { AnalysisBootstrap, BootstrapProcessedRequirements } from './analysisBootstrap';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('FILE_REQUIREMENT_PROCESSOR');

export interface ProcessedRequirements {
    sessionId: string;
    analysisMode: string;
    targetPath: string;
    loadedFiles: Map<string, string>;
    estimatedComplexity: 'low';
    processingTime: Date;
}

export class FileRequirementProcessor {
    private analysisBootstrap: AnalysisBootstrap;

    constructor(context: vscode.ExtensionContext) {
        logger.debug('Initializing FileRequirementProcessor...');
        this.analysisBootstrap = new AnalysisBootstrap(context);
        ThemeUtils.initialize(context);
        logger.debug('ThemeUtils initialized');
        logger.debug('AnalysisBootstrap initialized');
    }

    public async processRequirements(session: UnifiedAnalysisSession, theme?: string): Promise<ProcessedRequirements> {
        logger.debug(() => `Processing requirements for session ${session.id}`);
        logger.debug(() => `Analysis mode: ${session.analysisMode}, Target type: ${session.targetType}`);
        logger.debug(() => `Target path: ${session.targetPath}`);
        logger.debug(() => `Theme: ${theme || 'default'}`);

        try {
            const requirements: BootstrapProcessedRequirements = await this.analysisBootstrap.bootstrap(session, theme);

            logger.debug(() => `Requirements processed successfully for session ${session.id}`);
            logger.debug(() => `Total files loaded: ${requirements.loadedFiles.size}`);
            logger.debug(() => `Estimated complexity: ${requirements.estimatedComplexity}`);

            return requirements;
        } catch (error) {
            logger.error(`Error processing requirements for session ${session.id}:`, error);
            throw error;
        }
    }
}
