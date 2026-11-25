import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { UnifiedAnalysisSession } from '../core/analysisSession';
import { VenvManager } from '../../../core/python-env/venvManager';
import { getBackendScriptCandidates, resolveBackendScriptPath } from './backendScriptPath';
import { classifyStderrLine } from './pythonStderrStream';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('EXECUTE_PYTHON');

/**
 * What every ExecutePython entry point resolves: the backend's parsed JSON
 * payload, or (for the raw entry points: schema and dependencies) a
 * PythonScriptFailure record. Its shape depends on the mode (an XR record
 * array, a LivePanel object, the DOM parser's object, the schema...) and
 * each caller reads the fields of its own mode, so the boundary stays open
 * in this one alias rather than in an `any` per method. Narrowing it per
 * caller is follow-up work outside this module.
 */
type PythonPayload = any;

/** The HTML DOM parser fails a run with a truthy `error` field (or no outcome at all). */
function domFailureOf(result: unknown): { error?: string } | undefined {
    if (!result) {
        return {};
    }
    return (result as { error?: string }).error ? result as { error?: string } : undefined;
}

/** How a spawned backend process ended, before its output is interpreted. */
type SpawnOutcome =
    | { kind: 'spawn-error'; error: Error }
    | { kind: 'closed'; code: number | null; stdout: string; stderr: string };

/** The record executePythonScript resolves instead of throwing when a run fails. */
interface PythonScriptFailure {
    success: false;
    error?: string;
    rawOutput?: string;
    stderr?: string;
    stdout?: string;
}

/**
 * The failure carried by a script outcome, or `undefined` when the outcome
 * counts as a payload: any truthy value whose `success` is not `false`.
 * A falsy outcome is a failure with no message.
 */
function scriptFailureOf(result: unknown): Partial<PythonScriptFailure> | undefined {
    if (!result) {
        return {};
    }
    return (result as { success?: unknown }).success === false ? result as PythonScriptFailure : undefined;
}

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

    public async executeXRFieldSchema(targetType: 'file' | 'directory'): Promise<PythonPayload> {
        logger.debug(() => `Loading XR field schema for ${targetType}`);
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
      ): Promise<PythonPayload> {
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
    ): Promise<PythonPayload> {
        logger.debug(`Starting Python analysis execution...`);
        logger.debug(() => `Analysis mode: ${session.analysisMode}`);
        logger.debug(() => `Target type: ${session.targetType}`);
        logger.debug(() => `Target path: ${session.targetPath}`);

        const runAnalysis = async (progress: vscode.Progress<{message: string; increment: number}>): Promise<PythonPayload> => {
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
    ): Promise<PythonPayload> {
        logger.debug(() => `Executing file analysis for: ${session.targetPath}`);

        try {
            const args = [
                '--mode', 'livePanel',
                '--type', 'file',
                '--target', session.targetPath,
            ];

            logger.debug(() => `Executing file analysis with args: ${args.join(' ')}`);
            const result = await this.executePythonScript('main.py', args, progress);
            return this.finishAnalysis(result, 'File analysis', progress);
        } catch (error) {
            logger.error('Error during file analysis:', error);
            throw error;
        }
    }

    private async executeDirectoryAnalysis(
        session: UnifiedAnalysisSession,
        progress?: vscode.Progress<{message?: string; increment?: number}>,
    ): Promise<PythonPayload> {
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
            return this.finishAnalysis(result, 'Directory analysis', progress);
        } catch (error) {
            logger.error('Error during directory analysis:', error);
            throw error;
        }
    }

    private async executeXRAnalysis(
        session: UnifiedAnalysisSession,
        progress?: vscode.Progress<{message?: string; increment?: number}>,
    ): Promise<PythonPayload> {
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
                if (session.isDeep) {
                    logger.debug('XR_ANALYSIS: Adding --deep flag for deep directory analysis');
                    args.push('--deep');
                }
            }

            logger.debug(() => `XR_ANALYSIS: Starting XR analysis with main.py, args: ${args.join(' ')}`);
            progress?.report({ message: 'Starting XR analysis...' });

            const result = await this.executePythonScript('main.py', args, progress);
            return this.recoverXRResult(result, session, progress);
        } catch (error) {
            logger.error('XR_ANALYSIS: Error during XR analysis:', error);
            throw error;
        }
    }

    /**
     * Maps the outcome of an XR run to its payload, or throws the run's error.
     * A non-empty stdout without parseable JSON gets its own message: the
     * trimmed stdout was already tried as bare JSON by parsePythonOutput, and
     * JSON.parse accepts only whitespace that trim() removes, so nothing is
     * left to recover from it.
     */
    private recoverXRResult(
        result: unknown,
        session: UnifiedAnalysisSession,
        progress?: vscode.Progress<{message?: string; increment?: number}>,
    ): unknown {
        const failure = scriptFailureOf(result);
        if (failure?.success === false && failure.rawOutput && failure.error?.includes('JSON markers not found')) {
            logger.error('XR_ANALYSIS: Failed to parse rawOutput as JSON');
            logger.error('XR_ANALYSIS: Raw output content:', failure.rawOutput);
            throw new Error(`XR analysis failed: Unable to parse result - ${failure.error}`);
        }

        logger.debug(() => Array.isArray(result)
            ? `XR_ANALYSIS: ${result.length} XR function records for ${session.targetPath}`
            : `XR_ANALYSIS: Result is not an array, type: ${typeof result}`);
        return this.finishAnalysis(result, 'XR analysis', progress);
    }

    private async executeHTMLDOMAnalysis(
        session: UnifiedAnalysisSession,
        progress?: vscode.Progress<{message?: string; increment?: number}>,
    ): Promise<PythonPayload> {
        logger.debug(() => `Executing HTML DOM analysis for: ${session.targetPath}`);

        try {
            const args = [session.targetPath];

            logger.debug(() => `Executing HTML DOM analysis with args: ${args.join(' ')}`);
            progress?.report({ message: 'Parsing HTML DOM...' });

            const result = await this.executePythonScript('html/html_dom_parser.py', args, progress);
            // The DOM parser signals failure with an `error` field alone.
            return this.finishAnalysis(result, 'HTML DOM analysis', progress, domFailureOf);
        } catch (error) {
            logger.error('Error during HTML DOM analysis:', error);
            throw error;
        }
    }

    /**
     * The common tail of every progress-reporting analysis: a payload reports
     * "<label> completed!" and is returned; anything else throws
     * "<label> failed: <error>", or "Unknown error" when the outcome has none.
     */
    private finishAnalysis(
        result: unknown,
        label: string,
        progress?: vscode.Progress<{message?: string; increment?: number}>,
        failureOf: (result: unknown) => { error?: string } | undefined = scriptFailureOf,
    ): unknown {
        const failure = failureOf(result);
        if (!failure) {
            logger.debug(() => `${label} completed successfully`);
            progress?.report({ message: `${label} completed!` });
            return result;
        }

        logger.error(`${label} failed:`, result);
        throw new Error(`${label} failed: ${failure.error || 'Unknown error'}`);
    }

    public async executeFileReanalysis(filePaths: string[]): Promise<PythonPayload> {
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
    ): Promise<PythonPayload> {
        logger.debug(() => `Executing Python script: ${scriptName}`);
        logger.debug(() => `Script arguments: ${args.join(' ')}`);
        logger.debug(() => `Target: ${args.includes('--target') ? args[args.indexOf('--target') + 1] : 'Multiple targets'}`);
        logger.debug(() => `Mode: ${args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'Unknown'}`);
        logger.debug(() => `Type: ${args.includes('--type') ? args[args.indexOf('--type') + 1] : 'Unknown'}`);

        try {
            const pythonExecutable = this.resolvePythonExecutable();
            const scriptPath = this.resolveScriptPath(scriptName);
            const outcome = await this.spawnAndCollect(pythonExecutable, [scriptPath, ...args], path.dirname(scriptPath), progress);
            return this.toScriptResult(outcome, scriptName);
        } catch (error) {
            logger.error('Error executing Python script:', error);
            throw error;
        }
    }

    /** The venv interpreter; throws when it is not configured or not on disk. */
    private resolvePythonExecutable(): string {
        const pythonExecutable = this.venvManager.getPythonExecutablePath();
        if (!pythonExecutable) {
            throw new Error('Python executable not found in virtual environment');
        }
        logger.debug(() => `Using Python executable: ${pythonExecutable}`);

        if (!fs.existsSync(pythonExecutable)) {
            throw new Error(`Python executable does not exist: ${pythonExecutable}`);
        }
        return pythonExecutable;
    }

    /**
     * The backend script to run: the shipped dist copy, or in
     * ExtensionMode.Development only the monorepo sources at <repo>/backend/src
     * (see backendScriptPath.ts). Throws, after logging what dist holds, when
     * neither exists.
     */
    private resolveScriptPath(scriptName: string): string {
        const extensionPath = this.context.extensionPath;
        const { distPath, developmentPath } = getBackendScriptCandidates(this.context, scriptName);
        const scriptPath = resolveBackendScriptPath(this.context, scriptName);

        if (scriptPath !== distPath) {
            logger.debug('Script not found in dist, trying src directory');
        }
        logger.debug(() => `Script path: ${scriptPath}`);

        if (fs.existsSync(scriptPath)) {
            return scriptPath;
        }

        logger.error('Python script not found in either location:');
        logger.error(`Dist path: ${distPath} (exists: ${fs.existsSync(distPath)})`);
        if (developmentPath !== undefined) {
            logger.error(`Src path: ${developmentPath} (exists: ${fs.existsSync(developmentPath)})`);
        }
        logger.error(`Extension path: ${extensionPath}`);

        try {
            for (const segments of [['dist', 'code_analysis'], ['dist', 'code_analysis', 'python']]) {
                const directory = path.join(extensionPath, ...segments);
                if (fs.existsSync(directory)) {
                    logger.error(`${segments.join('/')} contents: ${fs.readdirSync(directory).join(', ')}`);
                }
            }
        } catch (listError) {
            logger.error('Failed to list directory contents:', listError);
        }

        throw new Error(`Python script does not exist: ${scriptPath}`);
    }

    /**
     * Spawns the interpreter and collects both streams. Each stderr line is
     * classified as it arrives and may report progress. Resolves once, with
     * whichever comes first: a spawn error or the process closing.
     */
    private spawnAndCollect(
        executable: string,
        fullArgs: string[],
        cwd: string,
        progress?: vscode.Progress<{message?: string; increment?: number}>,
    ): Promise<SpawnOutcome> {
        logger.debug(() => `Full command: ${executable} ${fullArgs.join(' ')}`);
        logger.debug(() => `Working directory: ${cwd}`);

        return new Promise((resolve) => {
            const childProcess = cp.spawn(executable, fullArgs, {
                cwd,
                env: process.env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            logger.debug(() => `Process spawned with PID: ${childProcess.pid}`);

            childProcess.on('error', (error: NodeJS.ErrnoException) => {
                logger.error('Failed to start Python process:', error);
                logger.error('Error details:', {
                    code: error.code,
                    errno: error.errno,
                    syscall: error.syscall,
                    path: error.path,
                });
                resolve({ kind: 'spawn-error', error });
            });

            let stdout = '';
            let stderr = '';

            childProcess.stdout.on('data', (data) => {
                stdout += data.toString();
                logger.debug(() => `stdout chunk received (${data.toString().length} chars)`);
            });

            childProcess.stderr.on('data', (data) => {
                const stderrChunk = data.toString();
                stderr += stderrChunk;

                for (const line of stderrChunk.split('\n')) {
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
                resolve({ kind: 'closed', code, stdout, stderr });
            });
        });
    }

    /**
     * Maps a spawn outcome to what executePythonScript resolves: the parsed
     * payload, or a failure record (never a rejection).
     */
    private toScriptResult(outcome: SpawnOutcome, scriptName: string): unknown {
        if (outcome.kind === 'spawn-error') {
            return {
                success: false,
                error: `Failed to start Python process: ${outcome.error}`,
                rawOutput: '',
            };
        }

        const { code, stdout, stderr } = outcome;
        logger.debug(() => `Script ${scriptName} completed with exit code ${code} (stdout ${stdout.length} chars, stderr ${stderr.length} chars)`);

        if (code !== 0) {
            logger.error(`FAILED - Python script failed with exit code ${code}`);
            if (stderr.trim()) {
                logger.error(`Error output preview: ${stderr.substring(0, 200)}${stderr.length > 200 ? '...' : ''}`);
            }
            return {
                success: false,
                error: `Python script failed with exit code ${code}`,
                stderr,
                stdout,
            };
        }

        try {
            const parsedResult = this.parsePythonOutput(stdout);
            logger.debug(() => Array.isArray(parsedResult)
                ? `Parsed Python result: array with ${parsedResult.length} items`
                : `Parsed Python result: ${typeof parsedResult}`);
            return parsedResult;
        } catch (parseError) {
            logger.warn('JSON markers not found or parse failed');
            return {
                success: false,
                error: parseError instanceof Error ? parseError.message : String(parseError),
                rawOutput: stdout,
            };
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
