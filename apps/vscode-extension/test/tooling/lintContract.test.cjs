const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The lint gate's own contract: what it covers, what it never touches, and how
// strict it is. A weakened config would otherwise pass silently, because a lint
// run that checks nothing reports nothing.
const projectRoot = path.resolve(__dirname, '..', '..');

// Each flag lands with its fallout fixes in one commit (ROADMAP W3-03..05).
const STRICT_TYPECHECK_FLAGS = ['noUnusedLocals', 'noFallthroughCasesInSwitch', 'noImplicitReturns', 'noUnusedParameters'];

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

test('the pre-existing style rules are errors and the lint script has a warning budget', async () => {
    const config = await loadEslintConfig();
    const tsBlock = config.find((block) => Array.isArray(block.files) && block.files.includes('**/*.ts'));
    const severity = (rule) => {
        const value = tsBlock.rules[rule];
        return Array.isArray(value) ? value[0] : value;
    };

    for (const rule of ['@typescript-eslint/naming-convention', 'curly', 'eqeqeq', 'no-throw-literal', 'semi']) {
        assert.equal(severity(rule), 'error', `${rule} is an error`);
    }

    const manifest = require(path.join(projectRoot, 'package.json'));
    assert.match(manifest.scripts.lint, /--max-warnings \d+/, 'the lint script carries --max-warnings');
});

function readTsconfig(fileName) {
    const ts = require('typescript');
    const text = fs.readFileSync(path.join(projectRoot, fileName), 'utf8');
    const { config, error } = ts.parseConfigFileTextToJson(fileName, text);
    assert.equal(error, undefined, `${fileName} parses`);
    return config;
}

test('typecheck runs the strict flags, and only typecheck does', () => {
    // compile, compile-tests and ts-loader stay on tsconfig.json so a transient
    // unused symbol never breaks the F5 build (ROADMAP section E, W2-22/23).
    const manifest = require(path.join(projectRoot, 'package.json'));
    assert.match(manifest.scripts.typecheck, /-p tsconfig\.check\.json/);
    assert.doesNotMatch(manifest.scripts['compile-tests'], /tsconfig\.check/);

    const check = readTsconfig('tsconfig.check.json');
    assert.equal(check.extends, './tsconfig.json');
    for (const flag of STRICT_TYPECHECK_FLAGS) {
        assert.equal(check.compilerOptions[flag], true, `tsconfig.check.json enables ${flag}`);
        assert.equal(readTsconfig('tsconfig.json').compilerOptions[flag], undefined, `tsconfig.json leaves ${flag} to the check config`);
    }
});

test('the extension project does not type-check against the browser DOM', () => {
    // The extension host is Node; a DOM global (window, document, a DOM-typed
    // setTimeout) in src/ would type-check and then fail at runtime.
    const lib = readTsconfig('tsconfig.json').compilerOptions.lib.map((entry) => entry.toLowerCase());
    assert.ok(!lib.includes('dom'), 'tsconfig.json lib has no DOM');
});
