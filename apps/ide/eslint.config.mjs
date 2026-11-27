import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

const COMMON_RULES = {
    curly: 'error',
    eqeqeq: 'error',
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-throw-literal': 'error',
    semi: 'error',
};

export default [
    { ignores: ['out/**', 'node_modules/**', '.core-types/**'] },
    {
        files: ['**/*.ts'],
        plugins: { '@typescript-eslint': typescriptEslint },
        languageOptions: { parser: tsParser, ecmaVersion: 2023, sourceType: 'module' },
        rules: {
            ...COMMON_RULES,
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            '@typescript-eslint/consistent-type-imports': 'error',
        },
    },
    {
        // The renderer is a sandboxed web page: no Node or Electron, ever. Its
        // only way out is window.codexr (src/preload).
        files: ['src/renderer/**/*.ts'],
        languageOptions: { globals: globals.browser },
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [
                    { group: ['electron', 'electron/*'], message: 'The renderer cannot use Electron. Add a member to CodeXRApi instead.' },
                    { group: ['node:*'], message: 'The renderer cannot use Node. Add a member to CodeXRApi instead.' },
                    { group: ['../main/*', '../preload/*'], message: 'The renderer may only import src/shared.' },
                    // core/metrics and core/xr are the exceptions: pure logic shared with the extension (#173/#178, #19).
                    { group: ['@codexr/core/*', '!@codexr/core/metrics', '!@codexr/core/xr', '@codexr/logging/*'], message: 'The core runs in the main process only (#15), except the pure core/metrics and core/xr. Add a member to CodeXRApi instead.' },
                ],
            }],
            'no-restricted-properties': ['error',
                { property: 'innerHTML', message: 'Build DOM nodes; never parse strings into markup.' },
                { property: 'outerHTML', message: 'Build DOM nodes; never parse strings into markup.' },
            ],
        },
    },
    {
        // The shared contract is imported by all three processes.
        files: ['src/shared/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', { patterns: [{ group: ['electron', 'node:*', '../*'], message: 'src/shared must stay dependency-free.' }] }],
        },
    },
    {
        // The preload may only require 'electron' (sandbox rule) and src/shared.
        files: ['src/preload/**/*.ts', 'src/scenePreload/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', { patterns: [{ group: ['node:*', '../main/*', '@codexr/core/*', '@codexr/logging/*'], message: 'A sandboxed preload may only use electron and src/shared.' }] }],
        },
    },
    {
        files: ['src/main/**/*.ts', 'test/**/*.ts'],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
        languageOptions: { globals: globals.node, ecmaVersion: 2023, sourceType: 'module' },
        rules: COMMON_RULES,
    },
];
