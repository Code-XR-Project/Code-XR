const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * End-to-end check of the backend over backend/manual_test: builds a venv with
 * the pinned lizard, runs tests/manual_metrics_suite.py, then writes the
 * reports with scripts/report-manual-metrics.py. Node builtins only, so it runs
 * without npm ci: `node backend/scripts/run-analysis-tests.cjs [--report-only]`.
 */
const backendRoot = path.resolve(__dirname, '..');
const artifactsRoot = path.join(backendRoot, 'artifacts');
const venvRoot = path.join(artifactsRoot, 'analysis-test-venv');
const isWindows = process.platform === 'win32';
const venvPython = path.join(venvRoot, isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python');
const reportOnly = process.argv.includes('--report-only');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: backendRoot,
        stdio: 'inherit',
        ...options,
    });

    if (result.error) {
        throw result.error;
    }

    if ((result.status ?? 1) !== 0) {
        process.exit(result.status ?? 1);
    }
}

function getPythonCandidates() {
    const candidates = [];

    if (process.env.CODEXR_PYTHON) {
        candidates.push({ command: process.env.CODEXR_PYTHON, args: [] });
    }

    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
        for (const version of ['Python312', 'Python311', 'Python310']) {
            const interpreter = path.join(localAppData, 'Programs', 'Python', version, 'python.exe');
            if (fs.existsSync(interpreter)) {
                candidates.push({ command: interpreter, args: [] });
            }
        }
    }

    candidates.push({ command: 'py', args: ['-3'] });
    candidates.push({ command: 'python', args: [] });
    candidates.push({ command: 'python3', args: [] });
    return candidates;
}

function findSystemPython() {
    for (const candidate of getPythonCandidates()) {
        const result = spawnSync(candidate.command, [...candidate.args, '--version'], {
            cwd: backendRoot,
            encoding: 'utf8',
        });

        if (!result.error && result.status === 0) {
            return candidate;
        }
    }

    return null;
}

function ensureVenv(systemPython) {
    if (!fs.existsSync(venvPython)) {
        fs.mkdirSync(artifactsRoot, { recursive: true });
        run(systemPython.command, [...systemPython.args, '-m', 'venv', venvRoot]);
    }
}

/**
 * The extension installs an exact lizard version into the user's managed venv
 * (apps/vscode-extension/src/core/python-env/pythonPackageManifest.ts). The
 * fixtures must be measured with that same version, so the requirement is read
 * from backend/requirements.txt, the generated mirror of that manifest
 * (apps/vscode-extension/test/python_env/pythonRequirements.test.cjs keeps the
 * two equal), instead
 * of being repeated here. Only lizard is installed, as before.
 */
function readPinnedLizardRequirement() {
    const requirementsPath = path.join(backendRoot, 'requirements.txt');
    const requirements = fs.readFileSync(requirementsPath, 'utf8');
    const match = /^lizard==([0-9][0-9A-Za-z.+-]*)\s*(?:#.*)?$/m.exec(requirements);
    if (!match) {
        throw new Error(`ANALYSIS_TEST_RUNNER: could not read the pinned lizard version from ${requirementsPath}`);
    }
    return `lizard==${match[1]}`;
}

function installDependencies() {
    run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    run(venvPython, ['-m', 'pip', 'install', readPinnedLizardRequirement()]);
}

function main() {
    const systemPython = findSystemPython();
    if (!systemPython) {
        console.error('ANALYSIS_TEST_RUNNER: Python interpreter not found.');
        process.exit(1);
    }

    ensureVenv(systemPython);
    installDependencies();

    if (!reportOnly) {
        run(venvPython, [path.join(backendRoot, 'tests', 'manual_metrics_suite.py')]);
    }

    run(venvPython, [path.join(backendRoot, 'scripts', 'report-manual-metrics.py')]);
}

if (require.main === module) {
    main();
}

module.exports = { readPinnedLizardRequirement };
