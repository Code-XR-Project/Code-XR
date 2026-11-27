// #264: the compatibility probe, from the command line. Installs each .vsix
// through the IDE's own install path, starts the real extension host on it
// in Node, fires its activation events, and prints what happened: activated
// or failed, and which vscode APIs it used that the host does not implement.
//
// Usage:
//   node --experimental-strip-types scripts/extensionCompat.mjs [options] <file.vsix | folder>... [--open-vsx <publisher.name>...]
// Options:
//   --json <file>    also write the full results as JSON
//   --markdown       print the Markdown table of docs/ide/extensions-compatibility.md
//   --open-vsx ...   download these extensions from Open VSX first (the same client and SHA-256 check as the IDE)
// A folder stands for every .vsix directly inside it. Exit code 1 when an extension failed to install, activate or answer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IDE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { probeVsix, probeTable } = await import(path.join(IDE_ROOT, 'src/main/extensions/compatProbe.ts'));
const { OpenVsxClient } = await import(path.join(IDE_ROOT, 'src/main/extensions/openVsx.ts'));

const args = process.argv.slice(2);
const files = [];
const fromOpenVsx = [];
let jsonOut = null;
let markdown = false;
let mode = 'files';
for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') {
        jsonOut = path.resolve(args[++index] ?? 'compat.json');
    } else if (arg === '--markdown') {
        markdown = true;
    } else if (arg === '--open-vsx') {
        mode = 'open-vsx';
    } else if (mode === 'open-vsx') {
        fromOpenVsx.push(arg);
    } else if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
        files.push(...fs.readdirSync(arg).filter((name) => name.endsWith('.vsix')).sort().map((name) => path.resolve(arg, name)));
    } else {
        files.push(path.resolve(arg));
    }
}

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-compat-downloads-'));
const results = [];
try {
    if (fromOpenVsx.length > 0) {
        const client = new OpenVsxClient('https://open-vsx.org', (url, init) => fetch(url, init));
        for (const id of fromOpenVsx) {
            try {
                const vsix = await client.download(id);
                const file = path.join(downloads, `${id}-${vsix.version}.vsix`);
                fs.writeFileSync(file, vsix.bytes);
                files.push(file);
                console.error(`[compat] downloaded ${id} ${vsix.version}${vsix.verified ? ' (verified publisher)' : ''}`);
            } catch (error) {
                results.push({ file: id, id, version: null, outcome: 'not-installed', engineSupported: null, contributions: null, missingApi: [], errors: [], registeredCommands: 0, milliseconds: 0, detail: `Open VSX: ${error instanceof Error ? error.message : String(error)}` });
            }
        }
    }
    if (files.length === 0 && results.length === 0) {
        console.error('[compat] no .vsix given.');
        process.exit(2);
    }
    for (const file of files) {
        const result = await probeVsix(file, {
            hostEntry: path.join(IDE_ROOT, 'src/extensionHost/index.ts'),
            execArgv: ['--experimental-strip-types', '--no-warnings'],
        });
        results.push(result);
        const missing = result.missingApi.length > 0 ? `; missing: ${result.missingApi.join(', ')}` : '';
        console.error(`[compat] ${result.id ?? path.basename(file)} ${result.version ?? ''}: ${result.outcome}${missing}${result.detail ? ` (${result.detail})` : ''}`);
    }
} finally {
    fs.rmSync(downloads, { recursive: true, force: true });
}

if (jsonOut) {
    fs.writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
}
if (markdown) {
    console.log(probeTable(results));
}
process.exit(results.some((result) => result.outcome === 'failed' || result.outcome === 'not-installed' || result.outcome === 'timeout') ? 1 : 0);
