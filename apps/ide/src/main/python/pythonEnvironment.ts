import { VenvManager } from '@codexr/core/python-env/venvManager';
import { CODEXR_PYTHON_PACKAGES } from '@codexr/core/python-env/pythonPackageManifest';
import { PythonEnvUtils } from '@codexr/core/python-env/pythonEnvUtils';
import { PythonEnvStorage } from '@codexr/core/python-env/pythonEnvStorage';
import { resolveBackendScriptPath } from '@codexr/core/host/backendScriptPath';
import { getHost } from '@codexr/core/host/hostRegistry';
import { execFile } from 'node:child_process';
import type { PythonEnvStatus, PythonPackageInfo } from '../../shared/api.ts';
import { parseParsersCheck, type ParsersStatus } from '../dependencies/dependencyReport.ts';
import { channelLog } from '../log.ts';
import { describePythonEnv, setUpDisclosure, type PythonFacts } from './pythonStatus.ts';

const log = channelLog('python');

const PACKAGES: readonly PythonPackageInfo[] = CODEXR_PYTHON_PACKAGES.map((pkg) => ({ name: pkg.distribution, version: pkg.version, purpose: pkg.purpose }));

/**
 * The Python environment of the IDE (#15), run by the core's `VenvManager`
 * (the same code the extension uses) in the IDE's user-data folder.
 *
 * Checking runs Python only. Setting up and repairing download the pinned
 * packages and the language parsers. Adrián decided that the IDE installs its
 * own dependencies with no question (#154): `ensureReady` runs at start-up,
 * the Analysis view's buttons run `setUp` directly, and every set-up writes
 * exactly what it fetches to the log. The VS Code extension still asks.
 */
export class PythonEnvironmentService {
    private readonly venv: VenvManager;
    private readonly venvFolder: string;
    private readonly onChange: (status: PythonEnvStatus) => void;
    private busy: { message?: string | undefined; percent?: number | undefined } | null = null;
    private lastError: string | null = null;
    private last: PythonEnvStatus | null = null;
    private cached: PythonFacts | null = null;

    constructor(storageDir: string, onChange: (status: PythonEnvStatus) => void) {
        const context = { globalStorageUri: { fsPath: storageDir } };
        this.venv = new VenvManager(context);
        this.venvFolder = new PythonEnvStorage(context).getVenvPath();
        this.onChange = onChange;
    }

    /** Progress from the core while busy (the host's withProgress), forwarded to the views. */
    reportProgress(message: string | undefined, percent: number | undefined): void {
        if (!this.busy) {
            return;
        }
        this.busy = { message: message ?? this.busy.message, percent: percent ?? this.busy.percent };
        this.publish(describePythonEnv({ ...this.lastFacts(), busy: this.busy }));
    }

    async status(): Promise<PythonEnvStatus> {
        return this.publish(describePythonEnv(await this.facts()));
    }

    /**
     * At start-up (#154): sets the environment up, or repairs it, when it is
     * missing or incomplete. Does nothing when it is ready or when no Python
     * is installed (the renderer then explains what to install).
     */
    async ensureReady(): Promise<PythonEnvStatus> {
        const status = await this.status();
        if (status.state === 'not-installed' || status.state === 'broken') {
            log.info('Python environment missing or incomplete: setting it up.');
            return this.setUp();
        }
        return status;
    }

    async setUp(): Promise<PythonEnvStatus> {
        if (this.busy) {
            return this.last ?? this.status();
        }
        const before = await this.status();
        if (before.state === 'ready' || before.state === 'missing-python') {
            return before;
        }
        const python = await this.venv.findSystemPython();
        const disclosure = setUpDisclosure(before, python ? PythonEnvUtils.formatCommand(python.command) : 'the system Python');
        log.info(`${disclosure.message}\n${disclosure.detail}`);

        this.busy = { message: 'Starting…', percent: 0 };
        this.lastError = null;
        this.publish(describePythonEnv({ ...(await this.facts()), busy: this.busy }));
        try {
            // A valid venv only lacks packages: initializeEnvironment installs what is missing.
            // Anything else is created from scratch (createEnvironment clears a damaged folder).
            if (this.venv.getEnvironmentStatus().isValid) {
                await this.venv.initializeEnvironment();
            } else {
                await this.venv.createEnvironment();
            }
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            log.error('Python environment set-up failed.', error);
        } finally {
            this.busy = null;
        }
        return this.status();
    }

    /**
     * Which tree-sitter parsers the venv holds (#161), from the backend's
     * `download_parsers.py --check`: runs the venv's Python, never the network.
     */
    async parsersStatus(): Promise<ParsersStatus> {
        if (this.busy || !this.venv.getEnvironmentStatus().isValid) {
            return { state: 'unknown', total: 0, missing: [] };
        }
        const script = resolveBackendScriptPath(getHost().paths, 'tools/download_parsers.py');
        const command = PythonEnvUtils.getVenvPythonCommand(this.venvFolder, [script, '--check']);
        return new Promise((resolve) => {
            execFile(command.executable, command.args, { timeout: 30_000, windowsHide: true }, (error, stdout) => {
                if (error) {
                    log.warn(`Could not check the language parsers: ${error.message}`);
                    resolve({ state: 'unknown', total: 0, missing: [] });
                    return;
                }
                resolve(parseParsersCheck(stdout));
            });
        });
    }

    async remove(): Promise<PythonEnvStatus> {
        if (this.busy) {
            return this.last ?? this.status();
        }
        // The core asks for confirmation itself (a native dialog through the host).
        await this.venv.deleteEnvironment();
        this.lastError = null;
        return this.status();
    }

    private async facts(): Promise<PythonFacts> {
        const env = this.venv.getEnvironmentStatus();
        const packagesOk = env.isValid ? await this.venv.areRequiredPackagesInstalled() : null;
        const python = env.isValid && packagesOk ? null : await this.venv.findSystemPython();
        this.cached = {
            busy: this.busy,
            venvValid: env.isValid,
            venvRecorded: env.exists,
            packagesOk,
            venvPythonVersion: env.metadata?.pythonVersion ?? null,
            systemPython: python ? { version: python.version, launcher: PythonEnvUtils.formatCommand(python.command) } : null,
            lastError: this.lastError,
            venvPath: this.venvPath(),
            packages: PACKAGES,
            platform: process.platform,
        };
        return this.cached;
    }

    private lastFacts(): PythonFacts {
        return this.cached ?? {
            busy: null, venvValid: false, venvRecorded: false, packagesOk: null, venvPythonVersion: null,
            systemPython: null, lastError: null, venvPath: this.venvPath(), packages: PACKAGES, platform: process.platform,
        };
    }

    private venvPath(): string {
        return this.venvFolder;
    }

    private publish(status: PythonEnvStatus): PythonEnvStatus {
        this.last = status;
        this.onChange(status);
        return status;
    }
}
