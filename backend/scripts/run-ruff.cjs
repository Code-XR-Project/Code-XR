const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// `npm run lint:python`: runs `ruff check` over backend/ with backend/ruff.toml.
// Node builtins only, like the other backend runners: it needs no npm ci.
//
// Ruff is a development tool pinned in backend/requirements-dev.txt. It is
// looked up as a module of the first Python found (CODEXR_PYTHON first, as for
// the test runners), then as a `ruff` executable on PATH. Unlike a missing
// interpreter in test:python, a missing ruff is always a failure: this script
// is run on purpose, and "lint passed" must never mean "lint did not run".
const backendRoot = path.resolve(__dirname, '..');
const requirementsFile = path.join('backend', 'requirements-dev.txt');

function getRuffCandidates() {
    const candidates = [];

    if (process.env.CODEXR_PYTHON) {
        candidates.push({ command: process.env.CODEXR_PYTHON, args: ['-m', 'ruff'] });
    }

    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
        for (const version of ['Python312', 'Python311', 'Python310']) {
            const interpreter = path.join(localAppData, 'Programs', 'Python', version, 'python.exe');
            if (fs.existsSync(interpreter)) {
                candidates.push({ command: interpreter, args: ['-m', 'ruff'] });
            }
        }
    }

    candidates.push({ command: 'py', args: ['-3', '-m', 'ruff'] });
    candidates.push({ command: 'python', args: ['-m', 'ruff'] });
    candidates.push({ command: 'python3', args: ['-m', 'ruff'] });
    candidates.push({ command: 'ruff', args: [] });

    return candidates;
}

for (const candidate of getRuffCandidates()) {
    const probe = spawnSync(candidate.command, [...candidate.args, '--version'], {
        cwd: backendRoot,
        encoding: 'utf8',
    });
    if (probe.error || probe.status !== 0) {
        continue;
    }

    console.log(`lint:python: ${probe.stdout.trim()} (${[candidate.command, ...candidate.args].join(' ')})`);
    const result = spawnSync(candidate.command, [...candidate.args, 'check', '.', ...process.argv.slice(2)], {
        cwd: backendRoot,
        stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
}

console.error(`lint:python: ruff not found. Install it with: python -m pip install -r ${requirementsFile}`);
process.exit(1);
