import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXTENSION_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'vscode-extension', 'src');
const ROOTS = { core: path.join(EXTENSION_SRC, 'core'), logging: path.join(EXTENSION_SRC, 'platform', 'logging') };
const ALIAS = /^@codexr\/(core|logging)\/(.+)$/;

export async function resolve(specifier, context, nextResolve) {
    const match = ALIAS.exec(specifier);
    if (match) {
        const file = path.join(ROOTS[match[1]], match[2].endsWith('.ts') ? match[2] : `${match[2]}.ts`);
        if (fs.existsSync(file)) {
            return { url: pathToFileURL(file).href, shortCircuit: true, format: 'module-typescript' };
        }
    }
    // Core sources import their siblings without an extension, as the extension's compiler allows.
    if (specifier.startsWith('.') && context.parentURL?.startsWith(pathToFileURL(EXTENSION_SRC).href) && !path.extname(specifier)) {
        const file = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
        if (fs.existsSync(file)) {
            return { url: pathToFileURL(file).href, shortCircuit: true, format: 'module-typescript' };
        }
    }
    return nextResolve(specifier, context);
}
