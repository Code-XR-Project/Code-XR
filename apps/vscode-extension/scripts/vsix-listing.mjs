import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Lists what a built VSIX actually contains and checks it against what must
// and must not ship. The `files` allowlist in package.json is the only control
// over the package (there is no .vscodeignore), so the built artefact is the
// thing to inspect, not the manifest.
//
//   node scripts/vsix-listing.mjs [--vsix <file>] [--out <listing.txt>]
//
// Without --vsix it reads the single .vsix in artifacts/. Exits 1 on any
// violation. Node builtins only: the central directory of the zip is enough
// (names and sizes), nothing is decompressed.

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Entries every package must contain (paths inside the zip). */
export const REQUIRED_ENTRIES = [
    'extension/package.json',
    'extension/readme.md',
    'extension/changelog.md',
    'extension/LICENSE.txt',
    'extension/dist/extension.js',
    'extension/dist/code_analysis/python/main.py',
    'extension/resources/icon.png',
];

/** Required directories: at least one entry below each. */
export const REQUIRED_PREFIXES = [
    'extension/templates/',
    'extension/examples/',
    'extension/dist/code_analysis/python/',
];

/** What must never ship, each with the reason a reviewer sees. */
export const FORBIDDEN = [
    { pattern: /\.map$/, reason: 'source maps are stripped before packaging' },
    { pattern: /^extension\/(src|test|out|scripts|node_modules|certs|docs|\.claude|\.vscode-test|artifacts)\//, reason: 'not in the files allowlist' },
    { pattern: /\/__pycache__\/|\.py[cod]$/, reason: 'Python bytecode' },
    { pattern: /(^|\/)[^/]+(?<!\.d)\.ts$/, reason: 'TypeScript sources' },
    { pattern: /(^|\/)(tsconfig[^/]*\.json|eslint\.config\.mjs|webpack\.config\.js)$/, reason: 'build configuration' },
    { pattern: /(^|\/)\.env|\.pem$|\.key$/, reason: 'secrets or keys' },
];

/** @param {string[]} names @returns {string[]} the violations, empty when the listing is fine */
export function checkListing(names) {
    const problems = [];
    const lowerNames = new Set(names.map((name) => name.toLowerCase()));
    for (const required of REQUIRED_ENTRIES) {
        if (!lowerNames.has(required.toLowerCase())) {
            problems.push(`missing: ${required}`);
        }
    }
    for (const prefix of REQUIRED_PREFIXES) {
        if (!names.some((name) => name.startsWith(prefix))) {
            problems.push(`missing: anything under ${prefix}`);
        }
    }
    for (const name of names) {
        for (const { pattern, reason } of FORBIDDEN) {
            if (pattern.test(name)) {
                problems.push(`forbidden (${reason}): ${name}`);
            }
        }
    }
    return problems;
}

/** Reads the zip central directory: [{ name, size }] in archive order. */
export function readZipListing(buffer) {
    const endSignature = 0x06054b50;
    let end = -1;
    for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
        if (buffer.readUInt32LE(offset) === endSignature) {
            end = offset;
            break;
        }
    }
    if (end < 0) {
        throw new Error('not a zip file: no end-of-central-directory record');
    }

    const count = buffer.readUInt16LE(end + 10);
    let offset = buffer.readUInt32LE(end + 16);
    const entries = [];
    for (let index = 0; index < count; index += 1) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error(`corrupt central directory at entry ${index}`);
        }
        const size = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        entries.push({ name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength), size });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

function findVsix() {
    const artifacts = join(workspaceRoot, 'artifacts');
    const candidates = readdirSync(artifacts).filter((name) => name.endsWith('.vsix'));
    if (candidates.length !== 1) {
        throw new Error(`expected exactly one .vsix in ${artifacts}, found ${candidates.length}: pass --vsix <file>`);
    }
    return join(artifacts, candidates[0]);
}

function main(argv) {
    const vsixIndex = argv.indexOf('--vsix');
    const outIndex = argv.indexOf('--out');
    const vsixPath = resolve(vsixIndex >= 0 ? argv[vsixIndex + 1] : findVsix());
    const buffer = readFileSync(vsixPath);
    const entries = readZipListing(buffer);
    const names = entries.map((entry) => entry.name);

    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    console.log(`${vsixPath}: ${entries.length} entries, ${buffer.length} bytes packed, ${totalBytes} bytes unpacked`);
    if (outIndex >= 0) {
        const listing = entries.map((entry) => `${entry.size}\t${entry.name}`).join('\n');
        writeFileSync(resolve(argv[outIndex + 1]), `${listing}\n`);
    }

    const problems = checkListing(names);
    if (problems.length > 0) {
        console.error(`VSIX listing check failed:\n  - ${problems.join('\n  - ')}`);
        process.exit(1);
    }
    console.log('VSIX listing check passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(/** @type {Error} */ (error).message);
        process.exit(1);
    }
}
