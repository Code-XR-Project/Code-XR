import { dialog, type BrowserWindow } from 'electron';
import { VenvManager } from '@codexr/core/python-env/venvManager';
import { CODEXR_PYTHON_PACKAGES } from '@codexr/core/python-env/pythonPackageManifest';
import { PythonEnvUtils } from '@codexr/core/python-env/pythonEnvUtils';
import { PythonEnvStorage } from '@codexr/core/python-env/pythonEnvStorage';
import type { PythonEnvStatus, PythonPackageInfo } from '../../shared/api.ts';
import { log } from '../log.ts';
import { describePythonEnv, setUpConsent, type PythonFacts } from './pythonStatus.ts';

const PACKAGES: readonly PythonPackageInfo[] = CODEXR_PYTHON_PACKAGES.map((pkg) => ({ name: pkg.distribution, version: pkg.version, purpose: pkg.purpose }));

/**
 * The Python environment of the IDE (#15), run by the core's `VenvManager`
 * (the same code the extension uses) in the IDE's user-data folder.
 *
 * Checking runs Python only. Anything that downloads (set up, repair) starts
 * from a person's click and then asks once more in a native dialog that lists
 * exactly what will be fetched; the renderer cannot skip that question.
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

    async setUp(owner: BrowserWindow | null): Promise<PythonEnvStatus> {
        if (this.busy) {
            return this.last ?? this.status();
        }
        const before = await this.status();
        if (before.state === 'ready' || before.state === 'missing-python') {
            return before;
        }
        const python = await this.venv.findSystemPython();
        const consent = setUpConsent(before, python ? PythonEnvUtils.formatCommand(python.command) : 'the system Python');
        const options = {
            type: 'question' as const,
            title: 'Python environment',
            message: consent.message,
            detail: consent.detail,
            buttons: [before.state === 'broken' ? 'Download and Repair' : 'Download and Set Up', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
        };
        const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
        if (response !== 0) {
            log.info('Python environment set-up declined.');
            return before;
        }

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
