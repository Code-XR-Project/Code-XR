import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { PythonEnvStorage, PythonEnvMetadata } from './pythonEnvStorage';
import { ExecutableCommand, PythonEnvUtils } from './pythonEnvUtils';
import { PythonEnvUiStateService } from './pythonEnvUiState';
import { getLogger } from '../../platform/logging/sink';
import {
    CODEXR_PYTHON_PACKAGES,
    CodeXRPythonPackage,
    getPinnedPythonRequirement,
} from './pythonPackageManifest';
import { PARSER_DOWNLOAD_TIMEOUT_MS, parseParserDownload } from './parserDownload';
import { resolveBackendScriptPath } from '../host/backendScriptPath';
import { InstallProgress } from './installProgress';
import { getHost } from '../host/hostRegistry';
import type { GlobalStorageContext } from '../host/hostPaths';

const logger = getLogger('PYTHON_ENV');

interface CommandExecutionResult {
    stdout: string;
    stderr: string;
    output: string;
}

interface EnvironmentVerificationResult {
    pythonPath: string;
    pythonVersion: string | null;
    packageCount: number;
    dependencies: string[];
}

class PythonCommandExecutionError extends Error {
    constructor(
        public readonly command: ExecutableCommand,
        public readonly exitCode: number | string | null,
        public readonly stdout: string,
        public readonly stderr: string,
        cause?: unknown,
    ) {
        const displayCommand = PythonEnvUtils.formatCommand(command);
        const details = stderr || stdout || (cause instanceof Error ? cause.message : String(cause ?? 'Unknown error'));
        const exitCodeLabel = exitCode !== null && exitCode !== undefined ? ` (exit code ${String(exitCode)})` : '';

        super(`Command failed${exitCodeLabel}: ${displayCommand}${details ? `\n${details}` : ''}`);
        this.name = 'PythonCommandExecutionError';
    }
}

/**
 * Core virtual environment management functionality.
 */
export class VenvManager {
    private readonly storage: PythonEnvStorage;
    private readonly uiState = PythonEnvUiStateService.getInstance();

    constructor(context: GlobalStorageContext) {
        this.storage = new PythonEnvStorage(context);
        this.logInfo('PYTHON_ENV: VenvManager initialized');
    }

    /**
     * Initialize the Python environment on extension startup.
     * If the environment already exists, only verify and refresh metadata.
     */
    public async initializeEnvironment(): Promise<void> {
        this.logInfo('PYTHON_ENV: Initializing Python environment...');

        try {
            const venvExists = this.storage.isVenvValid();

            if (venvExists) {
                this.logInfo('PYTHON_ENV: Existing valid environment found, verifying current installation');
                await this.ensureRequiredPackagesAvailable();
                await this.refreshEnvironmentMetadata();
                this.uiState.setReady('Python environment is ready.');
                return;
            }

            this.logInfo('PYTHON_ENV: No valid environment found, creating new one...');
            await this.createEnvironment();
        } catch (error) {
            const detail = this.getErrorDetails(error);
            const isPermissionError = this.isPermissionError(detail);

            if (isPermissionError && os.platform() === 'win32') {
                this.uiState.setError(
                    'Windows blocked the CodeXR virtual environment installation.',
                    this.getWindowsPermissionHelpMessage(detail),
                );
            } else {
                this.uiState.setError('Python environment initialization failed.', detail);
            }

            this.logError('PYTHON_ENV: Failed to initialize environment:', error);
            throw error;
        }
    }

    /**
     * Create a new virtual environment.
     * Handles Windows permission issues with retry logic and --clear flag.
     */
    public async createEnvironment(): Promise<void> {
        this.logInfo('PYTHON_ENV: Creating new virtual environment...');
        this.uiState.beginInstallation('Checking Python installation...');

        try {
            await getHost().withProgress({
                title: 'Creating Python Virtual Environment',
                cancellable: false,
            }, async (hostProgress) => {
                const progress = new InstallProgress(hostProgress, message => this.uiState.reportProgress(message));
                progress.to(0, 'Checking Python installation...');

                const { command: pythonCommand, version: pythonVersion } = await this.resolveSystemPython();
                progress.to(20, `Found Python ${pythonVersion}, creating environment...`);

                const venvPath = this.storage.getVenvPath();
                await this.createVenvWithRetry(pythonCommand, venvPath, progress);

                progress.to(55, 'Bootstrapping pip inside the virtual environment...');
                await this.ensurePipInVenv(progress);

                progress.to(70, 'Updating pip inside the CodeXR virtual environment...');
                await this.upgradePipInVenv(progress);

                progress.to(80, 'Installing required packages...');
                await this.installBasePackages(progress);

                progress.to(95, 'Saving environment metadata...');
                const metadata = this.storage.createInitialMetadata(pythonVersion);
                metadata.dependencies = await this.getInstalledDependencies();
                await this.storage.saveMetadata(metadata);

                progress.to(100, 'Environment created successfully!');
            });

            this.logInfo('PYTHON_ENV: Virtual environment created successfully');
            this.uiState.setReady('Python virtual environment is ready.');
            void getHost().notifier.notify('info', 'Python virtual environment created successfully!');
        } catch (error) {
            const detail = this.getErrorDetails(error);
            if (this.isPermissionError(detail) && os.platform() === 'win32') {
                this.uiState.setError(
                    'Windows blocked the CodeXR virtual environment installation.',
                    this.getWindowsPermissionHelpMessage(detail),
                );
            } else {
                this.uiState.setError('Python environment installation failed.', detail);
            }

            this.logError('PYTHON_ENV: Failed to create environment:', error);
            throw error;
        }
    }

    /**
     * Create venv with retry logic for Windows permission issues.
     */
    private async createVenvWithRetry(
        pythonCommand: ExecutableCommand,
        venvPath: string,
        progress: InstallProgress,
    ): Promise<void> {
        const targetState = this.getExistingPathState(venvPath);

        try {
            if (targetState === 'directory') {
                this.logInfo('PYTHON_ENV: Existing venv directory found, using --clear flag to recreate');
                progress.message('Clearing existing environment...');
                await this.executeCommand(PythonEnvUtils.appendArgs(pythonCommand, ['-m', 'venv', '--clear', venvPath]));
            } else {
                if (targetState === 'file') {
                    this.logWarn('PYTHON_ENV: Non-directory item found at venv path, removing blocker before recreation');
                    progress.message('Removing invalid file blocking the environment path...');
                    this.removePathIfExists(venvPath);
                }

                await this.executeCommand(PythonEnvUtils.appendArgs(pythonCommand, ['-m', 'venv', venvPath]));
            }

            this.logInfo('PYTHON_ENV: Venv created successfully (attempt 1)');
            return;
        } catch (firstError) {
            const errorDetails = this.getErrorDetails(firstError);
            if (!this.isPermissionError(errorDetails)) {
                throw firstError;
            }

            this.logWarn('PYTHON_ENV: Permission denied on venv creation (attempt 1), trying manual cleanup...');
        }

        try {
            progress.message('Resolving permission issue, cleaning up...');
            this.logInfo('PYTHON_ENV: Attempting manual cleanup before retry');
            this.removePathIfExists(venvPath);

            if (os.platform() === 'win32') {
                this.logInfo('PYTHON_ENV: Waiting for Windows file lock release...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            progress.message('Recreating environment...');
            await this.executeCommand(PythonEnvUtils.appendArgs(pythonCommand, ['-m', 'venv', venvPath]));
            this.logInfo('PYTHON_ENV: Venv created successfully (attempt 2 - after manual cleanup)');
            return;
        } catch (secondError: any) {
            this.logError('PYTHON_ENV: Venv creation failed after manual cleanup (attempt 2):', secondError.message);
        }

        const remediation = os.platform() === 'win32'
            ? this.getWindowsPermissionHelpMessage(`Permission denied while creating ${venvPath}`)
            : `Try manually deleting: ${venvPath}\nThen restart VS Code.`;

        throw new Error(
            `Permission denied when creating Python virtual environment at "${venvPath}".` +
            ` The venv directory may be locked by another process or antivirus software.\n\n${remediation}`,
        );
    }

    private getExistingPathState(targetPath: string): 'missing' | 'directory' | 'file' {
        if (!fs.existsSync(targetPath)) {
            return 'missing';
        }

        try {
            const stats = fs.lstatSync(targetPath);
            return stats.isDirectory() ? 'directory' : 'file';
        } catch (error) {
            this.logWarn('PYTHON_ENV: Could not inspect existing path, treating it as a file blocker:', error);
            return 'file';
        }
    }

    private removePathIfExists(targetPath: string): void {
        if (!fs.existsSync(targetPath)) {
            return;
        }

        const targetState = this.getExistingPathState(targetPath);
        if (targetState === 'directory') {
            fs.rmSync(targetPath, { recursive: true, force: true });
            this.logInfo('PYTHON_ENV: Existing directory removed successfully');
            return;
        }

        fs.rmSync(targetPath, { force: true });
        this.logInfo('PYTHON_ENV: Existing file blocker removed successfully');
    }

    /**
     * Delete the virtual environment.
     */
    public async deleteEnvironment(): Promise<void> {
        this.logInfo('PYTHON_ENV: Deleting virtual environment...');

        try {
            const result = await getHost().notifier.confirm(
                'Are you sure you want to delete the Python virtual environment? This action cannot be undone.',
                { modal: true, actions: ['Delete Environment'] },
            );

            if (result !== 'Delete Environment') {
                this.logInfo('PYTHON_ENV: Environment deletion cancelled by user');
                return;
            }

            await getHost().withProgress({
                title: 'Deleting Python Virtual Environment',
                cancellable: false,
            }, async (progress) => {
                progress.report({ increment: 50, message: 'Removing environment files...' });
                await this.storage.deleteEnvironment();
                progress.report({ increment: 50, message: 'Environment deleted successfully!' });
            });

            this.uiState.setIdle('Python virtual environment deleted.');
            this.logInfo('PYTHON_ENV: Environment deleted successfully');
            void getHost().notifier.notify('info', 'Python virtual environment deleted successfully!');
        } catch (error) {
            this.logError('PYTHON_ENV: Failed to delete environment:', error);
            void getHost().notifier.notify('error', `Failed to delete environment: ${this.getErrorDetails(error)}`);
        }
    }

    /**
     * Internal package installation helper.
     */
    public async installPackage(packageName: string): Promise<void> {
        this.logInfo(`PYTHON_ENV: Installing package: ${packageName}`);

        try {
            await getHost().withProgress({
                title: `Installing ${packageName}`,
                cancellable: false,
            }, async (progress) => {
                progress.report({ message: 'Checking virtual environment pip...' });
                await this.ensurePipInVenv();

                progress.report({ increment: 35, message: `Installing ${packageName} inside the CodeXR virtual environment...` });
                await this.runVenvPip(['install', packageName]);

                progress.report({ increment: 45, message: 'Updating dependencies list...' });
                await this.updateDependenciesList();

                progress.report({ increment: 20, message: 'Package installed successfully!' });
            });

            this.logInfo(`PYTHON_ENV: Package ${packageName} installed successfully`);
            void getHost().notifier.notify('info', `Package ${packageName} installed successfully!`);
        } catch (error) {
            this.logError(`PYTHON_ENV: Failed to install package ${packageName}:`, error);
            void getHost().notifier.notify('error', `Failed to install package ${packageName}: ${this.getErrorDetails(error)}`);
        }
    }

    /**
     * Refresh the metadata of an existing environment without reinstalling anything.
     */
    public async refreshEnvironmentMetadata(): Promise<void> {
        const snapshot = await this.collectEnvironmentSnapshot();
        await this.persistEnvironmentSnapshot(snapshot);
    }

    /**
     * Verify the current installation and refresh metadata.
     */
    public async verifyEnvironmentInstallation(): Promise<EnvironmentVerificationResult> {
        const snapshot = await this.collectEnvironmentSnapshot();
        await this.persistEnvironmentSnapshot(snapshot);
        return snapshot;
    }

    /**
     * Force a controlled installation failure for UI debugging.
     */
    public async debugForceInstallationFailure(): Promise<void> {
        const venvPath = this.storage.getVenvPath();

        this.logWarn('PYTHON_ENV: Forcing a debug installation failure');
        await this.storage.deleteEnvironment();
        fs.writeFileSync(venvPath, 'CodeXR debug installation blocker', 'utf8');

        try {
            await this.createEnvironment();
            throw new Error('CodeXR debug failure mode did not fail as expected.');
        } catch (error) {
            const details = this.getErrorDetails(error);
            if (details.includes('did not fail as expected')) {
                throw error;
            }

            this.logWarn('PYTHON_ENV: Debug installation failure triggered successfully:', details);
            await getHost().notifier.notify('warning',
                'CodeXR forced a Python environment installation failure for debugging. Use Reinitialize Python Environment to recover.',
            );
        } finally {
            this.removePathIfExists(venvPath);
        }
    }

    private async collectEnvironmentSnapshot(): Promise<EnvironmentVerificationResult> {
        const venvPath = this.storage.getVenvPath();
        if (!PythonEnvUtils.isValidVenv(venvPath)) {
            throw new Error('CodeXR could not find a valid Python virtual environment to verify.');
        }

        const pythonPath = PythonEnvUtils.getVenvPythonPath(venvPath);
        if (!fs.existsSync(pythonPath)) {
            throw new Error('CodeXR could not find the Python executable inside its virtual environment.');
        }

        if (!(await this.isVenvPipAvailable())) {
            throw new Error('CodeXR could not execute pip inside its virtual environment. Reinitialize the environment.');
        }

        if (!(await this.verifyRequiredPackages())) {
            throw new Error('CodeXR could not verify its Python analysis dependencies. Reinitialize the environment.');
        }

        const dependencies = await this.getInstalledDependencies();
        const pythonVersion = PythonEnvUtils.extractPythonVersion(venvPath) ?? await this.readVenvPythonVersion(venvPath);

        return {
            pythonPath,
            pythonVersion,
            packageCount: dependencies.length,
            dependencies,
        };
    }

    private async persistEnvironmentSnapshot(snapshot: EnvironmentVerificationResult): Promise<void> {
        let metadata = this.storage.loadMetadata();
        if (!metadata) {
            metadata = this.storage.createInitialMetadata(snapshot.pythonVersion);
        }

        metadata.isActive = true;
        metadata.pythonVersion = snapshot.pythonVersion;
        metadata.lastValidated = new Date().toISOString();
        metadata.dependencies = snapshot.dependencies;
        await this.storage.saveMetadata(metadata);
    }

    private async readVenvPythonVersion(venvPath: string): Promise<string | null> {
        try {
            const result = await this.executeCommand(PythonEnvUtils.getVenvPythonCommand(venvPath, ['--version']));
            const versionMatch = result.output.match(/Python\s+(\d+\.\d+\.\d+)/);
            return versionMatch ? versionMatch[1] : null;
        } catch (error) {
            this.logInfo('PYTHON_ENV: Could not read Python version from the existing venv:', error);
            return null;
        }
    }

    /**
     * The system Python the environment would be created from, or null when
     * none of the platform's launchers answers. Runs `--version` only: no
     * network, nothing installed (the IDE asks for consent after this).
     */
    public async findSystemPython(): Promise<{ command: ExecutableCommand; version: string } | null> {
        try {
            return await this.resolveSystemPython();
        } catch {
            return null;
        }
    }

    /** True when every package in the manifest imports inside the environment. Runs Python only, no network. */
    public async areRequiredPackagesInstalled(): Promise<boolean> {
        return this.verifyRequiredPackages();
    }

    /**
     * Get environment status information.
     */
    public getEnvironmentStatus(): {
        exists: boolean;
        isValid: boolean;
        metadata: PythonEnvMetadata | null;
        stats: any;
    } {
        const metadata = this.storage.loadMetadata();
        const isValid = this.storage.isVenvValid();
        const stats = this.storage.getStorageStats();

        return {
            exists: metadata !== null,
            isValid,
            metadata,
            stats,
        };
    }

    /**
     * Get the Python executable path for external use.
     */
    public getPythonExecutablePath(): string | null {
        const venvPath = this.storage.getVenvPath();

        if (!PythonEnvUtils.isValidVenv(venvPath)) {
            return null;
        }

        return PythonEnvUtils.getVenvPythonPath(venvPath);
    }

    /**
     * Get the lizard executable command for external use.
     */
    public getLizardCommand(): string | null {
        const pythonPath = this.getPythonExecutablePath();
        if (!pythonPath) {
            return null;
        }

        return `"${pythonPath}" -m lizard`;
    }

    /**
     * Verify that lizard is working correctly in the environment.
     */
    public async verifyLizardInstallation(): Promise<boolean> {
        const pkg = CODEXR_PYTHON_PACKAGES.find(item => item.distribution === 'lizard');
        return pkg ? this.verifyPackage(pkg) : false;
    }

    /**
     * Execute a command and return the result.
     */
    private async executeCommand(
        command: ExecutableCommand,
        cwd?: string,
        timeoutMs = 60000,
    ): Promise<CommandExecutionResult> {
        return new Promise((resolve, reject) => {
            const displayCommand = PythonEnvUtils.formatCommand(command);
            this.logInfo(`PYTHON_ENV: Executing command: ${displayCommand}`);

            const child = cp.spawn(command.executable, command.args, {
                cwd: cwd || process.cwd(),
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false,
            });

            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let settled = false;

            const timeoutHandle = setTimeout(() => {
                if (settled) {
                    return;
                }

                settled = true;
                child.kill();
                reject(this.createCommandError(command, 'timeout', stdoutChunks, stderrChunks, new Error(`Process timed out after ${timeoutMs}ms`)));
            }, timeoutMs);

            child.stdout?.on('data', (chunk: Buffer | string) => {
                stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });

            child.stderr?.on('data', (chunk: Buffer | string) => {
                stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });

            child.on('error', (error) => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timeoutHandle);
                const exitCode = typeof (error as any).code === 'number' || typeof (error as any).code === 'string'
                    ? (error as any).code
                    : null;
                const commandError = this.createCommandError(command, exitCode, stdoutChunks, stderrChunks, error);
                this.logError(`PYTHON_ENV: Command failed to start: ${displayCommand}`, commandError.message);
                reject(commandError);
            });

            child.on('close', (code, signal) => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timeoutHandle);

                const stdoutText = Buffer.concat(stdoutChunks).toString('utf8').trim();
                const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
                const output = [stdoutText, stderrText].filter(Boolean).join('\n').trim();

                if (code !== 0) {
                    const commandError = new PythonCommandExecutionError(
                        command,
                        code ?? (signal ? String(signal) : null),
                        stdoutText,
                        stderrText,
                        signal ? new Error(`Process terminated with signal ${signal}`) : undefined,
                    );
                    this.logError(`PYTHON_ENV: Command failed: ${displayCommand}`, commandError.message);
                    reject(commandError);
                    return;
                }

                this.logInfo(`PYTHON_ENV: Command completed successfully: ${displayCommand}`);
                if (stdoutText) {
                    this.logInfo(`PYTHON_ENV: stdout: ${stdoutText}`);
                }
                if (stderrText) {
                    this.logInfo(`PYTHON_ENV: stderr: ${stderrText}`);
                }

                resolve({
                    stdout: stdoutText,
                    stderr: stderrText,
                    output,
                });
            });
        });
    }

    private createCommandError(
        command: ExecutableCommand,
        exitCode: number | string | null,
        stdoutChunks: Buffer[],
        stderrChunks: Buffer[],
        cause?: unknown,
    ): PythonCommandExecutionError {
        const stdoutText = Buffer.concat(stdoutChunks).toString('utf8').trim();
        const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
        return new PythonCommandExecutionError(command, exitCode, stdoutText, stderrText, cause);
    }

    /**
     * Resolve a working system Python command and version.
     */
    private async resolveSystemPython(): Promise<{ command: ExecutableCommand; version: string }> {
        const candidates = PythonEnvUtils.getSystemPythonCandidates();

        for (const candidate of candidates) {
            const version = await this.checkPythonVersion(candidate);
            if (version) {
                this.logInfo(`PYTHON_ENV: Using system Python launcher ${PythonEnvUtils.formatCommand(candidate)} (${version})`);
                return { command: candidate, version };
            }
        }

        const triedCommands = candidates.map(candidate => PythonEnvUtils.formatCommand(candidate)).join(', ');
        throw new Error(
            `Python not found. Please install Python 3.7+ and ensure one of these launchers works: ${triedCommands}.`,
        );
    }

    /**
     * Check Python version for a given launcher.
     */
    private async checkPythonVersion(command: ExecutableCommand): Promise<string | null> {
        try {
            const result = await this.executeCommand(PythonEnvUtils.appendArgs(command, ['--version']));
            const versionMatch = result.output.match(/Python\s+(\d+\.\d+\.\d+)/);
            return versionMatch ? versionMatch[1] : null;
        } catch (error) {
            this.logInfo(`PYTHON_ENV: Could not get Python version with '${PythonEnvUtils.formatCommand(command)}':`, error);
            return null;
        }
    }

    /**
     * Ensure pip exists and is runnable inside the virtual environment.
     */
    private async ensurePipInVenv(progress?: InstallProgress): Promise<void> {
        const venvPath = this.storage.getVenvPath();

        if (await this.isVenvPipAvailable()) {
            return;
        }

        this.logWarn('PYTHON_ENV: pip is not available in the virtual environment, trying ensurepip...');
        if (progress) {
            progress.message('Bootstrapping pip inside the CodeXR virtual environment...');
        }

        await this.executeCommand(PythonEnvUtils.getEnsurePipCommand(venvPath));

        if (!(await this.isVenvPipAvailable())) {
            throw new Error(
                `CodeXR could not bootstrap pip inside its virtual environment at "${venvPath}". ` +
                `Your global Python installation was not modified.`,
            );
        }
    }

    /**
     * Try to upgrade pip inside the venv without ever touching the global Python installation.
     */
    private async upgradePipInVenv(progress?: InstallProgress): Promise<void> {
        try {
            if (progress) {
                progress.message('Upgrading pip inside the CodeXR virtual environment...');
            }
            this.logInfo('PYTHON_ENV: Upgrading pip inside the virtual environment...');
            await this.runVenvPip(['install', '--upgrade', 'pip']);
        } catch (error) {
            const pipStillAvailable = await this.isVenvPipAvailable();
            if (!pipStillAvailable) {
                throw new Error(
                    'CodeXR could not upgrade pip and the virtual environment pip is no longer usable. ' +
                    `The global Python installation was not modified.\n\n${this.getErrorDetails(error)}`,
                );
            }

            const warningMessage =
                'CodeXR could not upgrade pip inside its virtual environment. ' +
                'Continuing with the current virtual-environment pip. Your global Python installation was not modified.';
            this.showWarningNotification(warningMessage, this.getErrorDetails(error));
        }
    }

    /**
     * Install base packages in the virtual environment.
     */
    private async installBasePackages(progress?: InstallProgress): Promise<void> {
        try {
            // Packages and parsers share the 80-95% window, one equal part each (#158).
            const step = progress?.span(80, 95, PythonEnvUtils.REQUIRED_BASE_PACKAGES.length + CODEXR_PYTHON_PACKAGES.length + 1);
            let index = 0;
            const reportAt = (at: number) => step ? (message: string) => step(at, message) : undefined;
            for (const pkg of PythonEnvUtils.REQUIRED_BASE_PACKAGES) {
                reportAt(index++)?.(`Installing ${pkg}...`);
                this.logInfo(`PYTHON_ENV: Installing ${pkg}...`);
                await this.runVenvPip(['install', pkg]);
            }

            for (const pkg of CODEXR_PYTHON_PACKAGES) {
                await this.installRequiredPackage(pkg, reportAt(index++));
            }
            await this.downloadLanguageParsers(reportAt(index));
            await this.updateDependenciesList();

            this.logInfo('PYTHON_ENV: Base packages installed successfully');
        } catch (error) {
            this.logError('PYTHON_ENV: Failed to install base packages:', error);
            throw error;
        }
    }

    private async ensureRequiredPackagesAvailable(): Promise<void> {
        for (const pkg of CODEXR_PYTHON_PACKAGES) {
            if (!(await this.verifyPackage(pkg))) {
                this.logInfo(`PYTHON_ENV: Installing missing required package ${pkg.distribution}...`);
                await this.installRequiredPackage(pkg);
            }
        }
        await this.downloadLanguageParsers();
        await this.updateDependenciesList();
    }

    /**
     * Downloads the tree-sitter parsers the dependency graph uses, into the venv.
     *
     * tree-sitter-language-pack 1.x fetches parsers from GitHub on first use; the
     * set-up the person agreed to fetches them here instead, so an analysis never
     * downloads anything. Parsers already in the venv are not fetched again (the
     * script makes no network call then). A parser that cannot be fetched is
     * logged, never fatal: that language falls back to pattern matching.
     */
    private async downloadLanguageParsers(report?: (message: string) => void): Promise<void> {
        const script = resolveBackendScriptPath(getHost().paths, 'tools/download_parsers.py');
        if (!fs.existsSync(script)) {
            this.logWarn(`PYTHON_ENV: Parser download script not found at ${script}`);
            return;
        }
        report?.('Downloading language parsers...');
        try {
            const venvPath = this.storage.getVenvPath();
            const result = await this.executeCommand(
                PythonEnvUtils.getVenvPythonCommand(venvPath, [script]),
                undefined,
                PARSER_DOWNLOAD_TIMEOUT_MS,
            );
            const summary = parseParserDownload(result.stdout);
            if (!summary) {
                this.logWarn('PYTHON_ENV: Unexpected output from the parser download', result.output);
            } else if (summary.missing.length > 0) {
                this.logWarn(
                    `PYTHON_ENV: ${summary.missing.length} language parser(s) could not be downloaded; `
                    + `those languages use pattern matching: ${summary.missing.join(', ')}`,
                    summary.error ?? '',
                );
            } else {
                this.logInfo(`PYTHON_ENV: Language parsers ready (${summary.requested.length} requested)`);
            }
        } catch (error) {
            this.logWarn('PYTHON_ENV: Language parser download failed:', error);
        }
    }

    private async verifyRequiredPackages(): Promise<boolean> {
        const results = await Promise.all(CODEXR_PYTHON_PACKAGES.map(pkg => this.verifyPackage(pkg)));
        return results.every(Boolean);
    }

    private async verifyPackage(pkg: CodeXRPythonPackage): Promise<boolean> {
        try {
            const venvPath = this.storage.getVenvPath();
            await this.executeCommand(PythonEnvUtils.getVenvPythonCommand(venvPath, pkg.verificationArgs));
            return true;
        } catch (error) {
            this.logInfo(`PYTHON_ENV: ${pkg.distribution} verification failed:`, error);
            return false;
        }
    }

    private async installRequiredPackage(
        pkg: CodeXRPythonPackage,
        report?: (message: string) => void,
    ): Promise<void> {
        if (await this.verifyPackage(pkg)) {
            return;
        }
        report?.(`Installing ${pkg.distribution} for ${pkg.purpose}...`);
        await this.runVenvPip(['install', getPinnedPythonRequirement(pkg)]);
        if (!(await this.verifyPackage(pkg))) {
            throw new Error(`CodeXR installed ${pkg.distribution} but could not verify it afterwards.`);
        }
    }

    private async getInstalledDependencies(): Promise<string[]> {
        const output = (await this.runVenvPip(['list', '--format=freeze'])).output;
        return output.split('\n')
            .filter(line => line.trim() && !line.startsWith('#'))
            .map(line => line.trim());
    }

    /**
     * Update the dependencies list in metadata.
     */
    private async updateDependenciesList(): Promise<void> {
        try {
            const dependencies = await this.getInstalledDependencies();
            await this.storage.updateDependencies(dependencies);
            this.logInfo(`PYTHON_ENV: Dependencies list updated (${dependencies.length} packages)`);
        } catch (error) {
            this.logError('PYTHON_ENV: Failed to update dependencies list:', error);
        }
    }

    private async runVenvPip(args: string[]): Promise<CommandExecutionResult> {
        const venvPath = this.storage.getVenvPath();
        return this.executeCommand(PythonEnvUtils.getVenvPipCommand(venvPath, args));
    }

    private async isVenvPipAvailable(): Promise<boolean> {
        try {
            await this.runVenvPip(['--version']);
            return true;
        } catch (error) {
            return false;
        }
    }

    private showWarningNotification(message: string, detail?: string): void {
        void getHost().notifier.notify('warning', message, 'Show Details').then((choice) => {
            if (choice === 'Show Details' && detail) {
                void getHost().notifier.confirm(detail, { modal: true, severity: 'info', actions: [] });
            }
        });
    }

    private isPermissionError(message: string): boolean {
        return message.includes('Permission denied') ||
            message.includes('EACCES') ||
            message.includes('Errno 13');
    }

    private getWindowsPermissionHelpMessage(detail: string): string {
        const venvPath = this.storage.getVenvPath();

        return [
            'CodeXR only modifies its own virtual environment and does not change your global Python installation.',
            'Windows may be locking files in the venv directory.',
            `Venv path: ${venvPath}`,
            '',
            'Try this:',
            '1. Close any running CodeXR setup and retry from the Python Environment section.',
            '2. Exclude the CodeXR globalStorage folder from antivirus scans if needed.',
            '3. If the folder is stuck, delete the venv directory manually and retry.',
            '',
            detail,
        ].join('\n');
    }

    private logInfo(...parts: unknown[]): void {
        logger.info(this.getLogMessage(parts), this.getLogMetadata(parts));
    }

    private logWarn(...parts: unknown[]): void {
        logger.warn(this.getLogMessage(parts), this.getLogMetadata(parts));
    }

    private logError(...parts: unknown[]): void {
        logger.error(this.getLogMessage(parts), this.getLogMetadata(parts));
    }

    private getLogMessage(parts: unknown[]): string {
        if (parts.length === 0) {
            return 'Python environment event';
        }

        const [first] = parts;
        if (typeof first === 'string') {
            return first;
        }

        if (first instanceof Error) {
            return first.message;
        }

        return String(first);
    }

    private getLogMetadata(parts: unknown[]): unknown {
        if (parts.length <= 1) {
            return undefined;
        }

        return parts.length === 2 ? parts[1] : parts.slice(1);
    }
    private getErrorDetails(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error);
    }
}




