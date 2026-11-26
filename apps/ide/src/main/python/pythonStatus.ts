import type { PythonEnvStatus, PythonPackageInfo } from '../../shared/api.ts';

/**
 * Turns what the main process found out about the Python environment into
 * the status the renderer shows (#15). Pure, so every state and its wording
 * is unit-tested without Python or Electron.
 */
export interface PythonFacts {
    /** A set-up, repair or removal is running. */
    readonly busy: { readonly message?: string | undefined; readonly percent?: number | undefined } | null;
    /** The venv folder holds a working interpreter. */
    readonly venvValid: boolean;
    /** Metadata says an environment was created here before. */
    readonly venvRecorded: boolean;
    /** Every manifest package imports in the venv (null when not checked: no valid venv). */
    readonly packagesOk: boolean | null;
    /** Version recorded when the environment was created. */
    readonly venvPythonVersion: string | null;
    /** The system Python a set-up would use, or null when none answered. */
    readonly systemPython: { readonly version: string; readonly launcher: string } | null;
    /** Error of the last set-up attempt in this session, if it failed. */
    readonly lastError: string | null;
    readonly venvPath: string;
    readonly packages: readonly PythonPackageInfo[];
    readonly platform: string;
}

export function describePythonEnv(facts: PythonFacts): PythonEnvStatus {
    const base = { venvPath: facts.venvPath, packages: facts.packages };
    if (facts.busy) {
        return { ...base, state: 'installing', message: facts.busy.message ?? 'Setting up the Python environment…', progress: facts.busy.percent };
    }
    if (facts.venvValid && facts.packagesOk) {
        return { ...base, state: 'ready', message: facts.venvPythonVersion ? `Python ${facts.venvPythonVersion} environment is ready.` : 'The Python environment is ready.', pythonVersion: facts.venvPythonVersion ?? undefined };
    }
    if (facts.venvValid) {
        return {
            ...base,
            state: 'broken',
            message: 'Some analysis packages are missing from the environment.',
            detail: facts.lastError ?? 'Repair reinstalls them (it downloads them again from pypi.org).',
            pythonVersion: facts.venvPythonVersion ?? undefined,
        };
    }
    if (!facts.systemPython) {
        return { ...base, state: 'missing-python', message: 'Python 3 was not found on this computer.', detail: installHelp(facts.platform) };
    }
    if (facts.venvRecorded || facts.lastError) {
        return {
            ...base,
            state: 'broken',
            message: facts.lastError ? 'Setting up the Python environment failed.' : 'The Python environment is damaged.',
            detail: facts.lastError ?? 'Repair creates it again.',
            pythonVersion: facts.systemPython.version,
        };
    }
    return {
        ...base,
        state: 'not-installed',
        message: `Python ${facts.systemPython.version} found. The analysis environment is not set up yet.`,
        pythonVersion: facts.systemPython.version,
    };
}

/** How to get a Python the IDE can find, per platform (the launchers it tries come from the core). */
export function installHelp(platform: string): string {
    switch (platform) {
        case 'win32':
            return 'Install Python 3 from https://www.python.org/downloads/ (tick "Add python.exe to PATH") or from the Microsoft Store, then check again. The IDE looks for py -3, python and python3.';
        case 'darwin':
            return 'Install Python 3 from https://www.python.org/downloads/ or with Homebrew (brew install python), then check again. The IDE looks for python3 and python.';
        default:
            return 'Install Python 3 and its venv module with your package manager (for example: sudo apt install python3 python3-venv), then check again. The IDE looks for python3 and python.';
    }
}

/** The text of the consent dialog: exactly what a set-up downloads and where it goes. */
export function setUpConsent(status: PythonEnvStatus, launcher: string): { message: string; detail: string } {
    const lines = status.packages.map((pkg) => `• ${pkg.name} ${pkg.version}: ${pkg.purpose}`);
    return {
        message: status.state === 'broken' ? 'Repair the Python environment for Code-XR analyses?' : 'Set up the Python environment for Code-XR analyses?',
        detail: [
            `Code-XR will create a private virtual environment with ${launcher}${status.pythonVersion ? ` (Python ${status.pythonVersion})` : ''} in:`,
            status.venvPath,
            '',
            'and download these packages from the Python Package Index (pypi.org):',
            ...lines,
            '• pip, setuptools and wheel, inside the environment only',
            '',
            'Later, the first time a dependency graph analyses a language, tree-sitter-language-pack fetches that language\'s parser from github.com. Without it, the analysis falls back to pattern matching.',
            '',
            'Nothing is installed system-wide. You can remove the environment later from the Analysis view.',
        ].join('\n'),
    };
}
