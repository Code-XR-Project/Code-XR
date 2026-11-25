import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

// Logging programme (ROADMAP W4-L, LOG-02): extension diagnostics go through
// the logger (src/platform/logging), never straight to the console. The sink is
// the one file allowed to call console.*: it is the fallback while no output
// channel is attached. Browser runtimes under templates/ are not covered:
// their console is the page's.
const NO_CONSOLE_FILES = ["src/**/*.ts"];
const CONSOLE_ALLOWLIST = ["src/platform/logging/sink.ts"];

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
    // Modernized idioms (story #56, docs/cleanup/modernization.md §1 and §7).
    // Each rule landed in the commit that brought its idiom to zero in src/, so
    // the count can only stay there. Exceptions are per-file overrides below,
    // never eslint-disable comments (the suppressions guardrail is at 0).
    files: ["src/**/*.ts"],
    rules: {
        "no-var": "error",
        "prefer-rest-params": "error",
        "@typescript-eslint/no-namespace": "error",
        "@typescript-eslint/no-unsafe-function-type": "error",
        "@typescript-eslint/no-require-imports": "error",
        "@typescript-eslint/prefer-includes": "error",
        "@typescript-eslint/prefer-optional-chain": "error",
        "prefer-template": "error",
        "no-restricted-properties": ["error", {
            property: "substr",
            message: "Use slice() (substr is Annex B legacy; slice(start, start + length) for non-negative arguments).",
        }],
        // `??` only where the left operand is object-typed: '' || d and '' ?? d
        // differ, and settings or user JSON carry real '', 0 and false values,
        // so primitive operands, ternaries and if-assignments are not reported.
        "@typescript-eslint/prefer-nullish-coalescing": ["error", {
            ignorePrimitives: { string: true, number: true, boolean: true, bigint: true },
            ignoreTernaryTests: true,
            ignoreIfStatements: true,
        }],
    },
}, {
    // Files that keep an object-typed `x || {}` on purpose: the operand is
    // parsed JSON from a WebSocket client, the bridge protocol, workspace
    // storage or a settings update, where a malformed `0`, `''` or `false`
    // must still fall back to the default (modernization.md §7, row 9).
    files: [
        // historicalComparison.test.cjs pins `source.kind === 'workingCopy') || null` here (S pin).
        "src/code_analysis/historical/projectEvolutionService.ts",
        "src/servers/runtime/analysis/dependencyGraphBridge.ts",
        "src/servers/runtime/analysis/projectEvolutionBridge.ts",
        "src/servers/runtime/collaboration/collaborationRoomServer.ts",
        "src/servers/runtime/collaboration/roomSharedState.ts",
        "src/servers/storage/serverSettingsManager.ts",
        "src/features/visualize-data/model/visualizeDataState.ts",
        "src/code_analysis/views/subsections/analysis_settings/dimension_mapping_shared/sharedDimensionMappingSettingCore.ts",
    ],
    rules: {
        "@typescript-eslint/prefer-nullish-coalescing": "off",
    },
}, {
    // The lazy require() calls that stay (modernization.md §4): the eight in
    // the tree provider are load-bearing (cleanup skill §4), and the other two
    // defer a relative import to break a load-time module cycle.
    files: [
        "src/views/ModularTreeDataProvider.ts",
        "src/code_analysis/engine/watchers/directoryReAnalyzer.ts",
        "src/core/charts/getVisualizationConfiguration.ts",
    ],
    rules: {
        "@typescript-eslint/no-require-imports": "off",
    },
}, {
    // Folders whose `any`s were typed away (story #56, modernization.md §7):
    // there no-explicit-any is an error, not a budget warning. A folder joins
    // the list in the commit that brings it to zero.
    name: "codexr/any-free-folders",
    files: [
        "src/active_servers/**/*.ts",
        "src/code_analysis/engine/watchers/**/*.ts",
        "src/code_analysis/services/**/*.ts",
        "src/code_analysis/views/subsections/active_analyses/**/*.ts",
    ],
    rules: {
        "@typescript-eslint/no-explicit-any": "error",
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
        // No linted template script declares `var` any more (story #56,
        // docs/cleanup/modernization.md §6). A new `var` at the top level of a
        // classic script would also be a page global, which `let`/`const` are not.
        // The multi-part runtimes are linted by nothing (global ignores) and stay
        // on `var` until 1.3.0.
        "no-var": "error",
    },
}, {
    // Standalone runtimes converted from `var` to `let`/`const` (story #56,
    // docs/cleanup/modernization.md §2.3), one runtime per commit. Each is one
    // IIFE, so no top-level binding was a page global. `no-var` covers every
    // linted template (above); prefer-const is kept to these files, the ones
    // whose declarations were reviewed one by one.
    files: [
        "templates/components/codexr/dependency-visual-budget/dependencyVisualBudgetRuntime.js",
        "templates/components/common/codexrCommonRuntime.js",
        "templates/components/common/codexrGitRefPickerRuntime.js",
        "templates/components/codexr/debug/codexrDebugRuntime.js",
        "templates/components/codexr/render-budget/renderBudgetRuntime.js",
    ],
    rules: {
        "prefer-const": "error",
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
