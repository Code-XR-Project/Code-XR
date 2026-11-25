'use strict';

/**
 * Template paths come from the extension root, never from a module's own
 * location. The bundle runs every module from dist/extension.js, while the
 * tests run them from out/<folder>/<file>.js, so a `__dirname`-relative path
 * that the tests see as right is wrong in the shipped extension: from
 * dist/, `path.join(__dirname, '../../../templates')` lands two folders ABOVE
 * the extension.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const { createFakeVscode, withFakeVscode } = require('../helpers/fakeVscode.cjs');
const { collectFiles, readSource } = require('../helpers/sourceText.cjs');
const { templatesRoot } = require('../helpers/templatesRoot.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const outRoot = path.join(projectRoot, 'out');

/**
 * Evaluates a compiled out/ module as the bundle would run it: same code, but
 * with `__dirname` set to `<extensionRoot>/dist`. Its require() still resolves
 * from the real out/ location (and through the fake vscode).
 */
function loadAsBundled(relativeOutPath, extensionRoot) {
    const realPath = path.join(outRoot, ...relativeOutPath.split('/'));
    const distDirectory = path.join(extensionRoot, 'dist');
    const moduleShim = { exports: {} };
    new Function('exports', 'require', 'module', '__filename', '__dirname', fs.readFileSync(realPath, 'utf8'))(
        moduleShim.exports, createRequire(realPath), moduleShim, path.join(distDirectory, 'extension.js'), distDirectory,
    );
    return moduleShim.exports;
}

test('resolveTemplatePath joins the segments under <extension>/templates', () => {
    const { resolveTemplatePath, TEMPLATES_FOLDER } = require(path.join(outRoot, 'platform', 'templatePaths.js'));
    const root = path.resolve(path.sep, 'ext');
    assert.equal(TEMPLATES_FOLDER, 'templates');
    assert.equal(resolveTemplatePath(root), path.join(root, 'templates'));
    assert.equal(resolveTemplatePath(root, 'xr', 'sse', 'live_sse_fileXR.js'), path.join(root, 'templates', 'xr', 'sse', 'live_sse_fileXR.js'));
    assert.equal(resolveTemplatePath(projectRoot, 'guide'), templatesRoot('guide'));
});

test('from the bundle layout (dist/), the server default static root is still <extension>/templates', () => {
    const extensionRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-bundle-layout-')));
    try {
        withFakeVscode(createFakeVscode(), () => {
            const { HttpServer } = loadAsBundled('servers/runtime/httpServer.js', extensionRoot);
            const server = new HttpServer({ port: 0, extensionContext: { extensionPath: extensionRoot, subscriptions: [] } });
            assert.equal(server.getConfig().staticRoot, path.join(extensionRoot, 'templates'));
        });
    } finally {
        fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
});

test('an HttpServer with neither a static root nor an extension context is refused', () => {
    withFakeVscode(createFakeVscode(), ({ requireOut }) => {
        const { HttpServer } = requireOut('servers/runtime/httpServer.js');
        assert.throws(() => new HttpServer({ port: 0 }), { message: 'SERVER: HttpServer needs a staticRoot or an extension context' });
    });
});

test('no src module derives a template path from __dirname', () => {
    const offenders = collectFiles('src', { extensions: ['.ts'] })
        .filter((file) => /__dirname[^;\n]*templates/.test(readSource(file)));
    assert.deepEqual(offenders, []);
});
