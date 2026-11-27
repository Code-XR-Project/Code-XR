'use strict';

/**
 * backend/requirements.txt is GENERATED from the one source of truth for the
 * Python packages Code-XR installs: CODEXR_PYTHON_PACKAGES in
 * src/core/python-env/pythonPackageManifest.ts (the extension installs those
 * exact versions into the user's managed venv). The file exists so the backend
 * can be set up, and the future IDE can reuse the pin, without reading the
 * extension's TypeScript.
 *
 *   npm run python:requirements          rewrite backend/requirements.txt
 *
 * test/python_env/pythonRequirements.test.cjs fails when the two disagree.
 * Reads the compiled manifest from out/, so run `npm run compile-tests` first
 * (the npm script does).
 */

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const requirementsPath = path.join(projectRoot, '..', '..', 'backend', 'requirements.txt');
const manifestModule = path.join(projectRoot, 'out', 'core', 'python-env', 'pythonPackageManifest.js');

function renderRequirements(packages, getPinnedPythonRequirement) {
    const header = [
        '# GENERATED - do not edit. Source of truth:',
        '#   apps/vscode-extension/src/core/python-env/pythonPackageManifest.ts',
        '# Regenerate with `npm run python:requirements` (from the repository root).',
        '# These are the exact versions the extension installs into its managed venv.',
    ];
    const lines = packages.map((pkg) => `${getPinnedPythonRequirement(pkg)}  # ${pkg.purpose}`);
    return `${[...header, ...lines].join('\n')}\n`;
}

function renderFromManifest() {
    const { CODEXR_PYTHON_PACKAGES, getPinnedPythonRequirement } = require(manifestModule);
    return renderRequirements(CODEXR_PYTHON_PACKAGES, getPinnedPythonRequirement);
}

if (require.main === module) {
    if (!fs.existsSync(manifestModule)) {
        console.error(`PYTHON_REQUIREMENTS: ${manifestModule} is missing; run npm run compile-tests first.`);
        process.exit(1);
    }
    if (process.argv.includes('--write')) {
        fs.writeFileSync(requirementsPath, renderFromManifest());
        console.log(`PYTHON_REQUIREMENTS: wrote ${requirementsPath}`);
    } else {
        process.stdout.write(renderFromManifest());
    }
}

module.exports = { renderRequirements, renderFromManifest, requirementsPath };
