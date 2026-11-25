import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

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
        // stay allowed (noUnusedParameters is a separate, later step); a
        // leading underscore marks a deliberately unused binding.
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
    // sources tsconfig.json covers. Warn-only: an un-awaited promise is often
    // deliberate fire-and-forget, and marking each one `void` is a separate,
    // per-module cleanup.
    files: ["src/**/*.ts"],

    languageOptions: {
        parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname,
        },
    },

    rules: {
        "@typescript-eslint/no-floating-promises": ["warn", { checkThenables: true }],
        "@typescript-eslint/no-misused-promises": "warn",
    },
}];
