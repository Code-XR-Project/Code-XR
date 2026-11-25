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

        curly: "error",
        eqeqeq: "error",
        "no-throw-literal": "error",
        semi: "error",
    },
}];
