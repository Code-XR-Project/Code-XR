import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { UnifiedAnalysisSession } from '../core/analysisSession';
import { VenvManager } from '../../../python_env/runtime/venvManager';
import { getBackendScriptCandidates, resolveBackendScriptPath } from './backendScriptPath';
import { classifyStderrLine } from './pythonStderrStream';
import { getLogger } from '../../../core/logging/sink';

const logger = getLogger('EXECUTE_PYTHON');

/**
 * Utility para ejecutar análisis Python
 * 
 * Esta clase:
 * - Recibe el tipo de análisis y sesión
 * - Determina qué script Python ejecutar  
 * - Ejecuta el análisis y retorna los datos JSON
 */

export class ExecutePython {
    private venvManager: VenvManager;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        logger.debug('Initializing ExecutePython utility...');
        this.context = context;
        this.venvManager = new VenvManager(context);
    }

    public async executeXRFieldSchema(targetType: 'file' | 'directory'): Promise<any> {
        logger.debug(() => 'Loading XR field schema for ' + targetType);
        return await this.executePythonScript('main.py', [
            '--mode', 'schema',
            '--type', targetType,
        ]);
    }

      public async executeDependencyAnalysis(
          targetPath: string,
          targetType: 'file' | 'directory',
          deep: boolean,
          cachePath?: string,
          refreshRequestPath?: string,
          projectRoot?: string,
      ): Promise<any> {
        const args = [
            '--mode', 'dependencies',
            '--type', targetType,
            '--target', targetPath,
        ];
        if (deep) {
            args.push('--deep');
        }
          if (cachePath) {
              args.push('--cache', cachePath);
          }
          if (refreshRequestPath) {
              args.push('--dependency-refresh', refreshRequestPath);
          }
          if (projectRoot) {
              args.push('--project-root', projectRoot);
          }
          return this.executePythonScript('main.py', args);
      }

    /**
     * Ejecuta análisis Python según el tipo de análisis
     * 
     * @param session - Sesión de análisis unificada
     * @returns Promise con los datos JSON del análisis
     */
    public async executeAnalysis(
        session: UnifiedAnalysisSession,
        options: { silent?: boolean } = {},
    ): Promise<any> {
        logger.debug(`Starting Python analysis execution...`);
        logger.debug(() => `Analysis mode: ${session.analysisMode}`);
        logger.debug(() => `Target type: ${session.targetType}`);
        logger.debug(() => `Target path: ${session.targetPath}`);

        const runAnalysis = async (progress: vscode.Progress<{message: string; increment: number}>): Promise<any> => {
            progress.report({
                increment: 0,
                message: `Starting ${session.analysisMode} analysis...`,
            });

            try {
                if (session.analysisMode === 'LivePanel' && session.targetType === 'file') {
                    logger.debug('File LivePanel analysis requested');
                    return await this.executeFileAnalysis(session, progress);
                } else if (session.analysisMode === 'LivePanel' && session.targetType === 'directory') {
                    logger.debug('Directory LivePanel analysis requested');
                    return await this.executeDirectoryAnalysis(session, progress);
                } else if (session.analysisMode === 'VisualizeDOM' && session.targetType === 'file') {
                    logger.debug('HTML DOM analysis requested');
                    return await this.executeHTMLDOMAnalysis(session, progress);
                } else if (session.analysisMode === 'XR') {
                    logger.debug('XR analysis requested');
                    return await this.executeXRAnalysis(session, progress);
                }

                throw new Error(`Unknown analysis combination: ${session.analysisMode} + ${session.targetType}`);
            } catch (error) {
                logger.error('Error during Python analysis:', error);
                progress.report({ increment: 0, message: 'Analysis failed' });
                throw error;
            }
        };

        if (options.silent) {
            return await runAnalysis({ report: () => {} });
        }

        return await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'CodeXR Analysis',
                cancellable: false,
            },
            runAnalysis,
        );
    }

    private async executeFileAnalysis(
        session: UnifiedAnalysisSession,
        progress?: vscode.Progress<{message?: string; increment?: number}>,
    ): Promise<any> {
        logger.debug(() => `Executing file analysis for: ${session.targetPath}`);

        try {
            const args = [
                '--mode', 'livePanel',
                '--type', 'file',
                '--target', session.targetPath,
            ];

            logger.debug(() => `Executing file analysis with args: ${args.join(' ')}`);
            const result = await this.executePythonScript('main.py', args, progress);

            if (result && result?.success !== false) {
                logger.debug('File analysis completed successfully');
                progress?.report({ message: 'File analysis completed!' });
                return result;
            }

            logger.error('File analysis failed:', result);
            throw new Error(`File analysis failed: ${result?.error || 'Unknown error'}`);
        } catch (error) {
            logger.error('Error during file analysis:', error);
            throw error;
        }
    }

    private async executeDirectoryAnalysis(
        session: UnifiedAnalysisSession,
        progress?: vscode.Progress<{message?: string; increment?: number}>,
    ): Promise<any> {
        logger.debug('Executing directory analysis...');
        logger.debug(() => `Will analyze directory: ${session.targetPath}`);
        logger.debug(() => `Analysis mode: ${session.analysisMode}`);

        try {
            const isDeepAnalysis = session.isDeep;
            const args = [
                '--mode', 'livePanel',
                '--type', 'directory',
                '--target', session.targetPath,
            ];

            logger.debug('Python coordinator will scan and filter directory contents internally');
            progress?.report({ message: 'Preparing directory analysis...' });

            if (isDeepAnalysis) {
                logger.debug('Deep analysis requested');
                args.push('--deep');
            }

            logger.debug(() => `Executing with args: ${args.join(' ')}`);

            const result = await this.executePythonScript('main.py', args, progress);

            if (result && result.success !== false) {
                logger.debug('Directory analysis completed successfully');
                progress?.report({ message: 'Directory analysis completed!' });
                return result;
            }

            logger.error('Directory analysis failed:', result);
            throw new Error(`Directory analysis failed: ${result?.error || 'Unknown error'}`);
        } catch (error) {
            logger.error('Error during directory analysis:', error);
            throw error;
        }
    }

    private async executeXRAnalysis(
        session: UnifiedAnalysisSession,
        progress?: vscode.Progress<{message?: string; increment?: number}>,
    ): Promise<any> {
        logger.debug(() => `Executing XR analysis for: ${session.targetPath}`);
        logger.debug(() => `Target type: ${session.targetType}`);

        try {
            const args = [
                '--mode', 'xr',
                '--type', session.targetType,
                '--target', session.targetPath,
            ];

            if (session.targetType === 'directory') {
                logger.debug('XR_ANALYSIS: Python coordinator will scan and filter directory contents internally');
                progress?.report({ message: session.isDeep ? 'Preparing deep XR analysis...' : 'Preparing XR directory analysis...' });
            }

            if (session.targetType === 'directory' && session.isDeep) {
                logger.debug('XR_ANALYSIS: Adding --deep flag for deep directory analysis');
                args.push('--deep');
            }

            logger.debug('XR_ANALYSIS: Starting XR analysis with main.py');
            logger.debug(() => `XR_ANALYSIS: Args: ${args.join(' ')}`);
            progress?.report({ message: 'Starting XR analysis...' });

            const result = await this.executePythonScript('main.py', args, progress);

            logger.debug('XR_ANALYSIS: Raw Python result received:', {
                resultType: typeof result,
                isArray: Array.isArray(result),
                isObject: typeof result === 'object',
                hasSuccessProperty: result && typeof result === 'object' && 'success' in result,
                hasErrorProperty: result && typeof result === 'object' && 'error' in result,
                success: result?.success,
                error: result?.error,
                rawOutputLength: result?.rawOutput?.length || 0,
            });

            if (result?.success === false && result?.rawOutput && result?.error?.includes('JSON markers not found')) {
                logger.debug('XR_ANALYSIS: JSON markers missing, attempting to parse rawOutput directly...');
                logger.debug(() => `XR_ANALYSIS: Raw output preview: ${result.rawOutput.substring(0, 200)}${result.rawOutput.length > 200 ? '...' : ''}`);

                try {
                    const parsedData = JSON.parse(result.rawOutput);
                    logger.debug('XR_ANALYSIS: Successfully parsed rawOutput as direct JSON!');
                    logger.debug('XR_ANALYSIS: Parsed data type:', typeof parsedData);
                    logger.debug('XR_ANALYSIS: Is array:', Array.isArray(parsedData));

                    if (Array.isArray(parsedData)) {
                        logger.debug(() => `XR_ANALYSIS: Generated ${parsedData.length} XR function records`);
                        if (parsedData.length > 0) {
                            logger.debug('XR_ANALYSIS: Sample function data:', {
                                functionName: parsedData[0].functionName,
                                complexity: parsedData[0].complexity,
                                parameters: parsedData[0].parameters,
                                lineCount: parsedData[0].lineCount,
                                fileName: parsedData[0].fileName,
                            });
                        }
                        logger.debug(() => `XR_ANALYSIS: Successfully completed analysis for ${session.targetPath}`);
                    }

                    progress?.report({ message: 'XR analysis completed!' });
                    return parsedData;
                } catch (parseError) {
                    logger.error('XR_ANALYSIS: Failed to parse rawOutput as JSON:', parseError);
                    logger.error('XR_ANALYSIS: Raw output content:', result.rawOutput);
                    throw new Error(`XR analysis failed: Unable to parse result - ${result.error}`);
                }
            }

            if (result && result.success !== false) {
                logger.debug('XR_ANALYSIS: Direct result received (no error wrapper)');
                logger.debug('XR_ANALYSIS: Analysis result details:', {
                    functionsCount: Array.isArray(result) ? result.length : 0,
                    isArray: Array.isArray(result),
                    resultType: typeof result,
                });

                if (Array.isArray(result)) {
                    logger.debug(() => `XR_ANALYSIS: Generated ${result.length} XR function records`);
                    logger.debug(() => `XR_ANALYSIS: Successfully completed analysis for ${session.targetPath}`);

                    if (result.length > 0) {
                        logger.debug('XR_ANALYSIS: Sample function:', {
                            functionName: result[0].functionName,
                            complexity: result[0].complexity,
                            parameters: result[0].parameters,
                            lineCount: result[0].lineCount,
                            fileName: result[0].fileName,
                        });
                    }
                } else {
                    logger.debug(() => `XR_ANALYSIS: Result is not an array, type: ${typeof result}`);
                }

                progress?.report({ message: 'XR analysis completed!' });
                return result;
            }

            logger.error('XR_ANALYSIS: XR analysis failed with error:', result);
            throw new Error(`XR analysis failed: ${result?.error || 'Unknown error'}`);
        } catch (error) {
            logger.error('XR_ANALYSIS: Error during XR analysis:', error);
            throw error;
        }
    }

    private async executeHTMLDOMAnalysis(
        session: UnifiedAnalysisSession,
        progress?: vscode.Progress<{message?: string; increment?: number}>,
    ): Promise<any> {
        logger.debug(() => `Executing HTML DOM analysis for: ${session.targetPath}`);

        try {
            const args = [session.targetPath];

            logger.debug(() => `Executing HTML DOM analysis with args: ${args.join(' ')}`);
            progress?.report({ message: 'Parsing HTML DOM...' });

            const result = await this.executePythonScript('html/html_dom_parser.py', args, progress);

            if (result && !result.error) {
                logger.debug('HTML DOM analysis completed successfully');
                logger.debug(() => `Processed HTML content length: ${result.htmlContent?.length || 0} chars`);
                logger.debug('Analysis result:', {
                    originalFile: result.originalFile,
                    preparedForVisualization: result.preparedForVisualization,
                    htmlContentLength: result.htmlContent?.length || 0,
                });
                progress?.report({ message: 'HTML DOM analysis completed!' });
                return result;
            }

            logger.error('HTML DOM analysis failed:', result);
            throw new Error(`HTML DOM analysis failed: ${result?.error || 'Unknown error'}`);
        } catch (error) {
            logger.error('Error during HTML DOM analysis:', error);
            throw error;
        }
    }

    public async executeFileReanalysis(filePaths: string[]): Promise<any> {
        logger.debug(() => `Starting file re-analysis for ${filePaths.length} files`);

        try {
            const args = [
                ...filePaths,
            ];

            logger.debug(() => `Executing file re-analysis with args: ${args.join(' ')}`);
            const result = await this.executePythonScript('summaryFiles/file_reanalysis_coordinator.py', args);

            if (result && Array.isArray(result)) {
                logger.debug(() => `File re-analysis completed successfully for ${result.length} files`);
                return result;
            } else if (result && result.success !== false) {
                logger.debug('File re-analysis completed successfully for single file');
                return [result];
            }

            logger.error('File re-analysis failed:', result);
            throw new Error(`File re-analysis failed: ${result?.error || 'Unknown error'}`);
        } catch (error) {
            logger.error('Error during file re-analysis:', error);
            throw error;
        }
    }

    private async executePythonScript(
        scriptName: string,
        args: string[],
        progress?: vscode.Progress<{message?: string; increment?: number}>,
    ): Promise<any> {
        logger.debug(() => `Executing Python script: ${scriptName}`);
        logger.debug(() => `Script arguments: ${args.join(' ')}`);

        logger.debug('STARTING ANALYSIS');
        logger.debug(() => `Script: ${scriptName}`);
        logger.debug(() => `Target: ${args.includes('--target') ? args[args.indexOf('--target') + 1] : 'Multiple targets'}`);
        logger.debug(() => `Mode: ${args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'Unknown'}`);
        logger.debug(() => `Type: ${args.includes('--type') ? args[args.indexOf('--type') + 1] : 'Unknown'}`);

        try {
            const pythonExecutable = this.venvManager.getPythonExecutablePath();
            if (!pythonExecutable) {
                throw new Error('Python executable not found in virtual environment');
            }
            logger.debug(() => `Using Python executable: ${pythonExecutable}`);

            if (!require('fs').existsSync(pythonExecutable)) {
                throw new Error(`Python executable does not exist: ${pythonExecutable}`);
            }

            logger.debug('Python executable verified to exist');

            const extensionPath = this.context.extensionPath;
            // The shipped dist copy, or in ExtensionMode.Development only the
            // monorepo sources at <repo>/backend/src (see backendScriptPath.ts).
            const { distPath, developmentPath } = getBackendScriptCandidates(this.context, scriptName);
            const scriptPath = resolveBackendScriptPath(this.context, scriptName);

            if (scriptPath !== distPath) {
                logger.debug('Script not found in dist, trying src directory');
            }

            logger.debug(() => `Script path: ${scriptPath}`);

            if (!require('fs').existsSync(scriptPath)) {
                logger.error('Python script not found in either location:');
                logger.error(`Dist path: ${distPath} (exists: ${require('fs').existsSync(distPath)})`);
                if (developmentPath !== undefined) {
                    logger.error(`Src path: ${developmentPath} (exists: ${require('fs').existsSync(developmentPath)})`);
                }
                logger.error(`Extension path: ${extensionPath}`);

                try {
                    const distCodeAnalysisPath = path.join(extensionPath, 'dist', 'code_analysis');
                    if (require('fs').existsSync(distCodeAnalysisPath)) {
                        const distContents = require('fs').readdirSync(distCodeAnalysisPath);
                        logger.error(`dist/code_analysis contents: ${distContents.join(', ')}`);
                    }

                    const distPythonPath = path.join(extensionPath, 'dist', 'code_analysis', 'python');
                    if (require('fs').existsSync(distPythonPath)) {
                        const distPythonContents = require('fs').readdirSync(distPythonPath);
                        logger.error(`dist/code_analysis/python contents: ${distPythonContents.join(', ')}`);
                    }
                } catch (listError) {
                    logger.error('Failed to list directory contents:', listError);
                }

                throw new Error(`Python script does not exist: ${scriptPath}`);
            }

            logger.debug('Python script verified to exist');

            const fullArgs = [scriptPath, ...args];
            logger.debug(() => `Full command: ${pythonExecutable} ${fullArgs.join(' ')}`);
            logger.debug('About to spawn Python process...');

            return new Promise((resolve) => {
                logger.debug('Creating child process with spawn...');
                logger.debug(() => `Executable: "${pythonExecutable}"`);
                logger.debug(() => `Arguments: [${fullArgs.map(arg => `"${arg}"`).join(', ')}]`);
                logger.debug(() => `Working directory: ${path.dirname(scriptPath)}`);

                const childProcess = cp.spawn(pythonExecutable, fullArgs, {
                    cwd: path.dirname(scriptPath),
                    env: process.env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });

                logger.debug(() => `Process spawned with PID: ${childProcess.pid}`);

                childProcess.on('error', (error) => {
                    logger.error('Failed to start Python process:', error);
                    logger.error('Error details:', {
                        code: (error as any).code,
                        errno: (error as any).errno,
                        syscall: (error as any).syscall,
                        path: (error as any).path,
                    });
                    resolve({
                        success: false,
                        error: `Failed to start Python process: ${error}`,
                        rawOutput: '',
                    });
                });

                let stdoutData = '';
                let stderrData = '';

                childProcess.stdout.on('data', (data) => {
                    stdoutData += data.toString();
                    logger.debug(() => `stdout chunk received (${data.toString().length} chars)`);
                });

                childProcess.stderr.on('data', (data) => {
                    const stderrLine = data.toString();
                    stderrData += stderrLine;

                    for (const line of stderrLine.split('\n')) {
                        const classified = classifyStderrLine(line);
                        if (!classified) {
                            continue;
                        }
                        for (const logLine of classified.logLines) {
                            logger.debug(logLine);
                        }
                        if (classified.report && progress) {
                            progress.report(classified.report);
                        }
                    }
                });

                childProcess.on('close', (code) => {
                    logger.debug('ANALYSIS COMPLETED');
                    logger.debug(() => `Script: ${scriptName}`);
                    logger.debug(() => `Exit code: ${code}`);
                    logger.debug(() => `Output size: ${stdoutData.length} chars`);
                    logger.debug(() => `Error output size: ${stderrData.length} chars`);

                    if (code === 0) {
                        logger.debug('SUCCESS - Processing results...');

                        try {
                            const parsedResult = this.parsePythonOutput(stdoutData);
                            logger.debug('Successfully parsed Python result');
                            if (Array.isArray(parsedResult)) {
                                logger.debug(() => `Result type: Array with ${parsedResult.length} items`);
                            } else if (typeof parsedResult === 'object' && parsedResult !== null) {
                                logger.debug('Result type: Object');
                                if ((parsedResult as any).files && Array.isArray((parsedResult as any).files)) {
                                    logger.debug(() => `Files analyzed: ${(parsedResult as any).files.length}`);
                                }
                                if ((parsedResult as any).summary) {
                                    logger.debug('Summary available: Yes');
                                }
                            }
                            resolve(parsedResult);
                        } catch (parseError) {
                            logger.warn('JSON markers not found or parse failed');
                            resolve({
                                success: false,
                                error: parseError instanceof Error ? parseError.message : String(parseError),
                                rawOutput: stdoutData,
                            });
                        }
                    } else {
                        logger.error(`FAILED - Python script failed with exit code ${code}`);
                        if (stderrData.trim()) {
                            logger.error(`Error output preview: ${stderrData.substring(0, 200)}${stderrData.length > 200 ? '...' : ''}`);
                        }
                        resolve({
                            success: false,
                            error: `Python script failed with exit code ${code}`,
                            stderr: stderrData,
                            stdout: stdoutData,
                        });
                    }
                });
            });
        } catch (error) {
            logger.error('Error executing Python script:', error);
            throw error;
        }
    }

    private parsePythonOutput(stdoutData: string): any {
        const jsonStartMarker = '=== JSON_START ===';
        const jsonEndMarker = '=== JSON_END ===';
        const startIndex = stdoutData.indexOf(jsonStartMarker);
        const endIndex = stdoutData.indexOf(jsonEndMarker);

        if (startIndex >= 0 && endIndex >= 0) {
            const jsonContent = stdoutData.substring(startIndex + jsonStartMarker.length, endIndex).trim();
            return JSON.parse(jsonContent);
        }

        const trimmedOutput = stdoutData.trim();
        if (!trimmedOutput) {
            throw new Error('JSON markers not found in Python output');
        }

        try {
            return JSON.parse(trimmedOutput);
        } catch {
            throw new Error('JSON markers not found in Python output');
        }
    }
}
