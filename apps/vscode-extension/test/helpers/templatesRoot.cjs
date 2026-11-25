'use strict';

/**
 * The test-side twin of src/platform/templatePaths.ts: where the shipped
 * templates live in this checkout. New tests build template paths through it,
 * so moving templates/ (e.g. into a package) changes one line here.
 */

const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');

/** Absolute path of `templates/<segments…>` in the extension project. */
function templatesRoot(...segments) {
    return path.join(projectRoot, 'templates', ...segments);
}

module.exports = { templatesRoot };
