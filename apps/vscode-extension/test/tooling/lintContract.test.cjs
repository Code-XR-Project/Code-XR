const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The lint gate's own contract: what it covers, what it never touches, and how
// strict it is. A weakened config would otherwise pass silently, because a lint
// run that checks nothing reports nothing.
const projectRoot = path.resolve(__dirname, '..', '..');

async function loadEslintConfig() {
    const configUrl = pathToFileURL(path.join(projectRoot, 'eslint.config.mjs')).href;
    return (await import(configUrl)).default;
}

test('the ESLint config ignores generated output and shipped data', async () => {
    const config = await loadEslintConfig();
    const globalIgnores = config.filter((block) => block.ignores && Object.keys(block).length === 1);

    assert.equal(globalIgnores.length, 1, 'exactly one global ignores block');
    for (const pattern of ['dist/**', 'out/**', 'artifacts/**', 'node_modules/**', 'examples/**']) {
        assert.ok(globalIgnores[0].ignores.includes(pattern), `ignores ${pattern}`);
    }
});

test('every block that sets a parser or plugins is scoped with files', async () => {
    // An unscoped parser block applies the TypeScript parser to every file a
    // future root adds (JS tests, scripts, templates), which is how the old
    // config would have mis-linted them.
    const config = await loadEslintConfig();

    for (const block of config) {
        if (block.plugins || (block.languageOptions && block.languageOptions.parser)) {
            assert.ok(Array.isArray(block.files) && block.files.length > 0, 'a parser/plugin block names its files');
        }
    }
});
