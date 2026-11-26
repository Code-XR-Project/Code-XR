// Resolves `@codexr/core/...` and `@codexr/logging/...` for the unit tests,
// which Node runs straight from the TypeScript sources (--experimental-strip-types)
// without Vite's aliases. Only pure core modules can load this way: a test
// that reaches anything needing the extension's compiler fails loudly.
import { register } from 'node:module';

register(new URL('./testCoreAliasHooks.mjs', import.meta.url));
