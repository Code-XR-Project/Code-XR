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

// What `npm run lint` covers (ROADMAP W3-11/12).
const LINT_ROOTS = ['src', 'test', 'scripts', 'templates', 'webpack.config.js', 'eslint.config.mjs'];

// Rules that count toward the --max-warnings budget instead of failing outright
// (ROADMAP W3-08..10). Each landed with the budget raised to its measured count.
const WARN_BUDGET_RULES = [
    '@typescript-eslint/no-explicit-any',
    'complexity',
    'max-depth',
    'max-params',
    'max-lines-per-function',
    'max-lines',
    '@typescript-eslint/no-misused-promises',
];

// Budget rules that reached zero and were promoted to errors (ROADMAP T59).
const PROMOTED_RULES = ['@typescript-eslint/no-floating-promises'];

// The flat-config block (by its name) where folders free of `any` make
// no-explicit-any an error (story #56).
const ANY_FREE_BLOCK = 'codexr/any-free-folders';

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

test('the warn-only budget rules are configured as warnings over src', async () => {
    // The type-aware ones live in their own block (they need the TypeScript
    // program); the merge below follows flat-config order, last block wins.
    // A budget rule set to "off" would let its count drift while the
    // --max-warnings ceiling still looks tight. The any-free folders block is
    // the one deliberate exception: it makes no-explicit-any stricter (an
    // error) for the folders listed there, never looser.
    const config = await loadEslintConfig();
    const rules = Object.assign({}, ...config
        .filter((block) => block.rules && block.name !== ANY_FREE_BLOCK)
        .map((block) => block.rules));

    for (const rule of WARN_BUDGET_RULES) {
        const value = rules[rule];
        assert.equal(Array.isArray(value) ? value[0] : value, 'warn', `${rule} is a warning`);
    }
});

test('budget rules that reached zero stay errors', async () => {
    // A floating promise is now either awaited or an explicit `void`, a
    // reviewed fire-and-forget; a new one fails lint instead of joining a budget.
    const config = await loadEslintConfig();
    const rules = Object.assign({}, ...config.filter((block) => block.rules).map((block) => block.rules));

    for (const rule of PROMOTED_RULES) {
        const value = rules[rule];
        assert.equal(Array.isArray(value) ? value[0] : value, 'error', `${rule} is an error`);
    }
});

test('the lint script names its roots explicitly and every root exists', () => {
    // Explicit roots, never `eslint .`: the scope is reviewable in the diff and
    // a new directory (a fixture corpus, a generated folder) is not linted by
    // accident.
    const manifest = require(path.join(projectRoot, 'package.json'));
    const args = manifest.scripts.lint.split(/\s+/);
    const roots = args.slice(args.findIndex((arg) => arg.endsWith('eslint.js')) + 1)
        .filter((arg, index, all) => !arg.startsWith('--') && !(all[index - 1] || '').startsWith('--'));

    assert.deepEqual(roots, LINT_ROOTS);
    for (const root of roots) {
        assert.ok(fs.existsSync(path.join(projectRoot, root)), `${root} exists`);
    }
});

test('the template directories the lint ignores are multi-part runtimes, nothing else', () => {
    // The global ignore `templates/components/codexr/*/*Runtime/**` exists
    // because a part does not parse alone. A standalone runtime dropped into
    // such a directory would silently escape the lint: every matched directory
    // must be a manifest-driven parts directory.
    const codexrRoot = path.join(projectRoot, 'templates', 'components', 'codexr');
    const partDirectories = [];
    for (const component of fs.readdirSync(codexrRoot, { withFileTypes: true })) {
        if (!component.isDirectory()) {
            continue;
        }
        for (const entry of fs.readdirSync(path.join(codexrRoot, component.name), { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name.endsWith('Runtime')) {
                partDirectories.push(path.join(codexrRoot, component.name, entry.name));
            }
        }
    }

    assert.ok(partDirectories.length > 0, 'canary: the pattern matches the multi-part runtimes');
    for (const directory of partDirectories) {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
        const scripts = fs.readdirSync(directory).filter((name) => name.endsWith('.js')).sort();
        assert.deepEqual(scripts, [...manifest.parts].sort(), `${path.basename(directory)} holds only its listed parts`);
    }
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

test('typecheck also checks the build and packaging JavaScript', () => {
    const manifest = require(path.join(projectRoot, 'package.json'));
    assert.match(manifest.scripts.typecheck, /-p tsconfig\.tooling\.json/);

    const tooling = readTsconfig('tsconfig.tooling.json');
    assert.equal(tooling.compilerOptions.checkJs, true);
    assert.equal(tooling.compilerOptions.noEmit, true);
    for (const entry of ['scripts/**/*.mjs', 'webpack.config.js', 'eslint.config.mjs']) {
        assert.ok(tooling.include.includes(entry), `tsconfig.tooling.json includes ${entry}`);
    }
});

test('the extension project does not type-check against the browser DOM', () => {
    // The extension host is Node; a DOM global (window, document, a DOM-typed
    // setTimeout) in src/ would type-check and then fail at runtime.
    const lib = readTsconfig('tsconfig.json').compilerOptions.lib.map((entry) => entry.toLowerCase());
    assert.ok(!lib.includes('dom'), 'tsconfig.json lib has no DOM');
});

test('no-console is an error over all of src/, and the log sink is the only exception', async () => {
    // Logging programme (ROADMAP W4-L22, LOG-02): the sink falls back to the
    // console while no output channel is attached, so it is the one file
    // allowed to call it.
    const config = await loadEslintConfig();
    const blocks = config.filter((block) => block.rules && block.rules['no-console'] !== undefined);

    assert.equal(blocks.length, 1, 'one no-console block');
    const [block] = blocks;
    assert.equal(block.rules['no-console'], 'error');
    assert.deepEqual(block.files, ['src/**/*.ts']);
    assert.deepEqual(block.ignores, ['src/platform/logging/sink.ts']);
    assert.ok(fs.existsSync(path.join(projectRoot, 'src', 'platform', 'logging', 'sink.ts')), 'the allowlisted sink exists');
});

// Idioms story #56 brought to zero in src/ (docs/cleanup/modernization.md §7).
// Each lock-in landed with the commit that reached zero; one switched off or
// downgraded would let the idiom come back unnoticed.
const MODERNIZED_IDIOM_RULES = [
    'no-var',
    'prefer-rest-params',
    '@typescript-eslint/no-namespace',
    '@typescript-eslint/no-unsafe-function-type',
    '@typescript-eslint/no-require-imports',
    '@typescript-eslint/prefer-includes',
    '@typescript-eslint/prefer-optional-chain',
    'prefer-template',
    '@typescript-eslint/prefer-nullish-coalescing',
    'no-restricted-properties',
];

test('the modernized idioms stay locked over src/', async () => {
    const config = await loadEslintConfig();
    const block = config.find((candidate) => candidate.rules
        && candidate.rules['no-var'] !== undefined
        && Array.isArray(candidate.files) && candidate.files.includes('src/**/*.ts'));

    assert.ok(block, 'one block locks the idioms over src/**/*.ts');
    for (const rule of MODERNIZED_IDIOM_RULES) {
        const value = block.rules[rule];
        assert.equal(Array.isArray(value) ? value[0] : value, 'error', `${rule} is an error over src/`);
    }
});

test('only the three files with deliberate lazy require() may use it', async () => {
    // modernization.md §4: the tree provider's eight lazy requires are
    // load-bearing, the other two break load-time cycles. Any other file
    // imports statically.
    const config = await loadEslintConfig();
    const exemptions = config.filter((block) => block.rules
        && block.rules['@typescript-eslint/no-require-imports'] === 'off');

    assert.equal(exemptions.length, 1, 'one exemption block');
    assert.deepEqual([...exemptions[0].files].sort(), [
        'src/code_analysis/engine/watchers/directoryReAnalyzer.ts',
        'src/core/charts/getVisualizationConfiguration.ts',
        'src/views/ModularTreeDataProvider.ts',
    ]);
    for (const file of exemptions[0].files) {
        assert.ok(fs.existsSync(path.join(projectRoot, file)), `${file} exists`);
    }
});

test('folders typed free of any keep no-explicit-any as an error', async () => {
    // Story #56 types the `any`s folder by folder; a folder at zero is locked
    // there. The block may only tighten the rule, and every folder it names
    // must exist (a moved folder would otherwise drop out of the lock silently).
    const config = await loadEslintConfig();
    const blocks = config.filter((block) => block.name === ANY_FREE_BLOCK);

    assert.equal(blocks.length, 1, 'one any-free folders block');
    const [block] = blocks;
    assert.deepEqual(Object.keys(block.rules), ['@typescript-eslint/no-explicit-any']);
    assert.equal(block.rules['@typescript-eslint/no-explicit-any'], 'error');
    assert.ok(block.files.length > 0);
    for (const pattern of block.files) {
        assert.match(pattern, /^src\/.+\/\*\*\/\*\.ts$/, `${pattern} is a src/ folder glob`);
        const folder = pattern.replace(/\/\*\*\/\*\.ts$/, '');
        assert.ok(fs.statSync(path.join(projectRoot, folder)).isDirectory(), `${folder} exists`);
    }
});
