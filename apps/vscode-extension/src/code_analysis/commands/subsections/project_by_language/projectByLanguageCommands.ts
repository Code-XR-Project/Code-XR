/**
 * Project Structure Commands
 * Commands for analyzing files and directories from project structure
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { CommandRegistration } from '../analysis_settings/analysis_file_mode/analysisFileModeCommands';
import { AnalysisConfigurationStorage } from '../../../configuration/analysisConfigurationStorage';
import { AnalysisOrchestrator } from '../../../engine/analysisOrchestrator';
import { getLanguageByExtension } from '../../../../utils/supportedLanguages';
import { getLogger } from '../../../../core/logging/sink';

const logger = getLogger('PROJECT_STRUCTURE_COMMANDS');

export class ProjectByLanguageCommands {
    
    constructor(private context: vscode.ExtensionContext) {}

    /**
     * Get project structure command registrations (nested dolls pattern)
     */
    static getCommandRegistrations(
        context: vscode.ExtensionContext, 
        refreshCallback: () => void
    ): CommandRegistration[] {
        logger.debug('ANALYSIS: Collecting Project Structure command registrations');
        const commands = new ProjectByLanguageCommands(context);
        
        const commandRegistrations: CommandRegistration[] = [
            {
                commandId: 'codeXR.analysis.projectStructure.analyzeFile',
                callback: async (filePath: string) => {
                    logger.debug(() => `Analyze file command TRIGGERED for: ${filePath}`);
                    logger.debug(() => `Callback argument type: ${typeof filePath}`);
                    logger.debug(() => `Callback argument value: "${filePath}"`);
                    await commands.analyzeFile(filePath);
                    refreshCallback();
                },
                description: 'Analyze a file using the configured analysis mode from Project Structure'
            },
            {
                commandId: 'codeXR.analysis.projectStructure.analyzeDirectory',
                callback: async (directoryPath: string) => {
                    logger.debug(() => `Analyze directory command TRIGGERED for: ${directoryPath}`);
                    logger.debug(() => `Callback argument type: ${typeof directoryPath}`);
                    logger.debug(() => `Callback argument value: "${directoryPath}"`);
                    await commands.analyzeDirectory(directoryPath);
                    refreshCallback();
                },
                description: 'Analyze a directory using the configured analysis mode from Project Structure'
            }
        ];

        logger.debug(() => `ANALYSIS: Collected ${commandRegistrations.length} Project Structure command registrations`);
        return commandRegistrations;
    }

    /**
     * Analyze a file using the configured file analysis mode
     */
    private async analyzeFile(filePath: string): Promise<void> {
        logger.debug(() => `Analyzing file: ${filePath}`);
        logger.debug(() => `FilePath type: ${typeof filePath}`);
        logger.debug(() => `FilePath value: "${filePath}"`);
        
        try {
            // Validate input
            if (!filePath || typeof filePath !== 'string') {
                logger.error('Invalid filePath received:', filePath);
                void vscode.window.showErrorMessage('Invalid file path received');
                return;
            }

            const storage = AnalysisConfigurationStorage.getInstance(this.context);
            const analysisMode = await storage.getAnalysisMode();
            
            logger.debug(() => `Using analysis mode: ${analysisMode}`);
            
            // Get file extension and language
            const ext = path.extname(filePath).toLowerCase();
            const languageConfig = getLanguageByExtension(ext);
            const languageName = languageConfig?.name || 'Unknown';
            
            logger.debug(() => `Running analysis for ${filePath} (${languageName}) in ${analysisMode} mode`);

            // Determine which analysis to run based on file type and configuration
            if (languageName === 'HTML') {
                // HTML files always use DOM Visualization using NEW ENGINE
                logger.debug('Running DOM Visualization for HTML file using NEW ENGINE');
                await AnalysisOrchestrator.orchestrateAnalysis(
                    filePath,
                    'VisualizeDOM',
                    'file',
                    this.context,
                    false
                );
            } else {
                // For other files, use the configured analysis mode with NEW ENGINE
                if (analysisMode === 'XR') {
                    logger.debug('Running XR Analysis using NEW ENGINE');
                    await AnalysisOrchestrator.orchestrateAnalysis(
                        filePath,
                        'XR',
                        'file',
                        this.context,
                        false
                    );
                } else if (analysisMode === 'LivePanel') {
                    logger.debug('Running LivePanel Analysis using NEW ENGINE');
                    await AnalysisOrchestrator.orchestrateAnalysis(
                        filePath,
                        'LivePanel',
                        'file',
                        this.context,
                        false
                    );
                } else {
                    void vscode.window.showWarningMessage(`Unknown analysis mode: ${analysisMode}`);
                }
            }
            
            void vscode.window.showInformationMessage(`Started ${analysisMode} analysis for file: ${path.basename(filePath)}`);
            
        } catch (error) {
            logger.error('Error analyzing file:', error);
            void vscode.window.showErrorMessage(`Failed to analyze file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Analyze a directory using the configured directory analysis mode
     */
    private async analyzeDirectory(directoryPath: string): Promise<void> {
        logger.debug(() => `Analyzing directory: ${directoryPath}`);
        logger.debug(() => `DirectoryPath type: ${typeof directoryPath}`);
        logger.debug(() => `DirectoryPath value: "${directoryPath}"`);
        
        try {
            // Validate input
            if (!directoryPath || typeof directoryPath !== 'string') {
                logger.error('Invalid directoryPath received:', directoryPath);
                void vscode.window.showErrorMessage('Invalid directory path received');
                return;
            }

            const storage = AnalysisConfigurationStorage.getInstance(this.context);
            const directoryAnalysisMode = await storage.getAnalysisDirectoryMode();
            
            logger.debug(() => `Using directory analysis mode: ${directoryAnalysisMode}`);
            
            // Map directory analysis mode to AnalysisOrchestrator parameters
            let analysisMode: 'XR' | 'LivePanel';
            let isDeep: boolean;
            
            switch (directoryAnalysisMode) {
                case 'XR':
                    analysisMode = 'XR';
                    isDeep = false;
                    break;
                case 'XRDeep':
                    analysisMode = 'XR';
                    isDeep = true;
                    break;
                case 'LivePanel':
                    analysisMode = 'LivePanel';
                    isDeep = false;
                    break;
                case 'LivePanelDeep':
                    analysisMode = 'LivePanel';
                    isDeep = true;
                    break;
                default:
                    void vscode.window.showWarningMessage(`Unknown directory analysis mode: ${directoryAnalysisMode}`);
                    return;
            }
            
            logger.debug(() => `Running ${analysisMode} Directory Analysis (Deep: ${isDeep}) using NEW ENGINE`);
            await AnalysisOrchestrator.orchestrateAnalysis(
                directoryPath,
                analysisMode,
                'directory',
                this.context,
                isDeep
            );
            
            void vscode.window.showInformationMessage(`Started ${directoryAnalysisMode} analysis for directory: ${path.basename(directoryPath)}`);
            
        } catch (error) {
            logger.error('Error analyzing directory:', error);
            void vscode.window.showErrorMessage(`Failed to analyze directory: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

