import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

// Logging programme (ROADMAP W4-L, LOG-02): extension diagnostics go through
// the logger (src/core/logging), never straight to the console. The sink is
// the one file allowed to call console.*: it is the fallback while no output
// channel is attached. Browser runtimes under templates/ are not covered:
// their console is the page's.
const NO_CONSOLE_FILES = ["src/**/*.ts"];
const CONSOLE_ALLOWLIST = ["src/core/logging/sink.ts"];

const NODE_JS_RULES = {
    "no-undef": "error",
    "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
    curly: "error",
    eqeqeq: "error",
    "no-throw-literal": "error",
    "no-eval": "error",
    semi: "error",
};

export default [{
    // Generated output, dependencies and shipped data are never linted. The
    // metric fixture corpus (backend/manual_test) lives outside this workspace
    // on purpose: it is deliberately bad code, and "fixing" it would change
    // what test:analysis measures.
    ignores: [
        "dist/**",
        "out/**",
        "artifacts/**",
        "output/**",
        ".vscode-test/**",
        "node_modules/**",
        "examples/**",
        "docs/**",
        "resources/**",
        // Multi-part runtimes: each part is a fragment of one function body,
        // concatenated in manifest.json order, and does not parse on its own.
        "templates/components/codexr/*/*Runtime/**",
    ],
}, {
    files: ["**/*.ts"],

    plugins: {
        "@typescript-eslint": typescriptEslint,
    },

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["error", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        // Unused imports and locals are errors. Parameters and caught errors
        // stay allowed here: unused parameters are typecheck's job
        // (noUnusedParameters in tsconfig.check.json). A leading underscore
        // marks a deliberately unused binding.
        "@typescript-eslint/no-unused-vars": ["error", {
            args: "none",
            caughtErrors: "none",
            varsIgnorePattern: "^_",
        }],

        // Warn-only budget rules: each counts toward the lint script's
        // --max-warnings, which was raised to the measured count when the rule
        // landed and may only come down (guardrail baseline, eslint.maxWarnings).
        "@typescript-eslint/no-explicit-any": "warn",
        // Size and complexity ceilings (ROADMAP section C distributions;
        // max-lines 600 so a file split to ~500 lines is not one change away
        // from tripping it).
        complexity: ["warn", 15],
        "max-depth": ["warn", 4],
        "max-params": ["warn", 5],
        "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
        "max-lines": ["warn", { max: 600, skipBlankLines: true, skipComments: true }],

        curly: "error",
        eqeqeq: "error",
        "no-throw-literal": "error",
        semi: "error",
    },
}, {
    // Type-aware rules need the TypeScript program, so they are scoped to the
    // sources tsconfig.json covers. no-floating-promises is an error since
    // ROADMAP T56-T59 marked every deliberate fire-and-forget `void`; a new
    // un-awaited promise is either awaited or voided on purpose.
    // no-misused-promises stays in the warning budget.
    files: ["src/**/*.ts"],

    languageOptions: {
        parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname,
        },
    },

    rules: {
        "@typescript-eslint/no-floating-promises": ["error", { checkThenables: true }],
        "@typescript-eslint/no-misused-promises": "warn",
    },
}, {
    files: NO_CONSOLE_FILES,
    ignores: CONSOLE_ALLOWLIST,
    rules: {
        "no-console": "error",
    },
}, {
    // Node-side JavaScript: the test suites, the build/packaging scripts and
    // the two config files. Same style rules as src/, plus the scope checks a
    // compiler would otherwise give TypeScript for free.
    files: ["test/**/*.cjs", "webpack.config.js"],
    languageOptions: {
        ecmaVersion: 2024,
        sourceType: "commonjs",
        globals: { ...globals.node },
    },
    rules: NODE_JS_RULES,
}, {
    // The browser harnesses ship callbacks to Playwright's page.evaluate, which
    // run in the page: there, and only there, window and document exist.
    files: ["test/runners/run-*-harness.cjs"],
    languageOptions: {
        globals: { window: "readonly", document: "readonly" },
    },
}, {
    files: ["scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
        ecmaVersion: 2024,
        sourceType: "module",
        globals: { ...globals.node },
    },
    rules: NODE_JS_RULES,
}, {
    // The standalone browser runtimes under templates/ (the multi-part ones are
    // in the global ignores above). Relaxed on purpose: these are classic
    // scripts, so a top-level declaration is a page global another script
    // reads (no-unused-vars checks locals only), and `x == null` is the
    // null-or-undefined idiom they rely on (eqeqeq "smart"). No source change
    // was needed to land this block, and none should be made to satisfy it
    // without the browser harnesses.
    files: ["templates/**/*.js"],
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: "script",
        // `module` is read behind a typeof guard by the UMD footers.
        globals: { ...globals.browser, module: "readonly" },
    },
    rules: {
        "no-undef": "error",
        "no-unused-vars": ["error", { vars: "local", args: "none", caughtErrors: "none" }],
        curly: "error",
        eqeqeq: ["error", "smart"],
        "no-throw-literal": "error",
        "no-eval": "error",
        semi: "error",
    },
}, {
    // The LivePanel webview loads its scripts into one page scope: these are the
    // names panelShell.js, dataTable.js, charts.js and the two panels define for
    // the *main.js scripts (and each other), plus the webview's own API.
    files: ["templates/analysis_livePanel/**/*.js", "templates/components/livepanel/**/*.js"],
    languageOptions: {
        globals: Object.fromEntries([
            "acquireVsCodeApi", "vscode",
            "applyTheme", "getStoredTheme", "toggleTheme", "createLivePanelSse",
            "showUpdateNotification", "showReloadNotification", "upsertDataTable",
            "escapeHtml", "formatMetricValue", "formatRatio", "codexrSeriesClass",
            "numericColumn", "DataTable",
            "CodexrBarChart", "CodexrDonutChart", "CodexrPairedBarChart",
            "CodexrDependencySummaryPanel", "CodexrHistoricalPanel",
        ].map((name) => [name, "readonly"])),
    },
}];
