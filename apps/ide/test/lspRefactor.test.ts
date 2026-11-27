import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LanguageServer } from '../src/main/lsp/languageServer.ts';
import { buildDocumentRequest, buildWorkspaceSymbolRequest, lspLanguageId, type DocumentRequestMethod } from '../src/main/lsp/lspProtocol.ts';
import { mapDocumentResult, mapWorkspaceSymbols } from '../src/main/lsp/lspResults.ts';
import { findPythonServer, typescriptServerCommand, type ServerCommand } from '../src/main/lsp/lspServers.ts';
import { toClientUri, toServerUri, workspacePathToClientUri, type WorkspaceRoots } from '../src/main/lsp/lspUri.ts';
import { Workspace } from '../src/main/workspace/workspace.ts';
import type { LspLanguage, LspServerId } from '../src/shared/lsp.ts';
import { applyTextEdits, workspaceEditFiles, type FileTextEdits } from '../src/renderer/lsp/lspEdits.ts';
import { toSignatureHelp } from '../src/renderer/lsp/lspConvert.ts';

/**
 * #287 end to end against the real servers: the bundled
 * typescript-language-server (on the IDE's TypeScript, as the IDE runs it)
 * and pyright or pylsp when one is on PATH (skipped otherwise, like the IDE
 * itself goes without). Everything between the server and Monaco runs as in
 * the IDE: the request rebuilt by `buildDocumentRequest`, the answer mapped
 * by `mapDocumentResult`, the edit read by the renderer's
 * `workspaceEditFiles`, and a file that is not open written through the
 * workspace (real path inside the folder, refused if it changed on disk), as
 * `EditorGroup.applyWorkspaceEdit` does.
 */

const IDE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const silent = { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined };

interface Harness {
    readonly root: string;
    readonly roots: WorkspaceRoots;
    readonly server: LanguageServer;
    readonly diagnostics: Map<string, unknown[]>;
    open(workspacePath: string, language: LspLanguage): void;
    /** The editor's new text of an open document, as the language client sends it. */
    change(workspacePath: string, text: string): void;
    request(method: DocumentRequestMethod, workspacePath: string, params: Record<string, unknown>): Promise<unknown>;
    clientUri(workspacePath: string): string;
}

function makeFolder(files: Record<string, string>): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-lsp-refactor-')));
    for (const [relative, text] of Object.entries(files)) {
        const absolute = path.join(root, ...relative.split('/'));
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, text);
    }
    return root;
}

function startHarness(id: LspServerId, command: ServerCommand, root: string, workspaceRoot = root): Harness {
    const roots = { root: workspaceRoot, realRoot: workspaceRoot };
    const diagnostics = new Map<string, unknown[]>();
    const server = new LanguageServer({
        id,
        command,
        rootPath: workspaceRoot,
        rootUri: pathToFileURL(workspaceRoot).href,
        rootName: path.basename(workspaceRoot),
        log: silent,
        onDiagnostics: (params) => {
            const uri = toClientUri(params.uri, roots);
            if (uri) {
                diagnostics.set(uri, [...params.diagnostics]);
            }
        },
    });
    const clientUri = (workspacePath: string): string => workspacePathToClientUri(workspacePath);
    let version = 1;
    return {
        root: workspaceRoot,
        roots,
        server,
        diagnostics,
        clientUri,
        open(workspacePath, language) {
            const text = fs.readFileSync(path.join(workspaceRoot, ...workspacePath.split('/')), 'utf8');
            server.open(toServerUri(clientUri(workspacePath), roots), lspLanguageId(language, workspacePath), 1, text);
        },
        change(workspacePath, text) {
            const uri = toServerUri(clientUri(workspacePath), roots);
            server.change(uri, ++version, text);
        },
        async request(method, workspacePath, params) {
            const request = buildDocumentRequest(method, { textDocument: { uri: clientUri(workspacePath) }, ...params }, (uri) => toServerUri(uri, roots));
            return mapDocumentResult(request.method, await server.request(request.method, request.params), (uri) => toClientUri(uri, roots));
        },
    };
}

/** Writes the edit like `EditorGroup.applyWorkspaceEdit` writes a file that is not open; returns the new texts. */
async function applyToDisk(workspace: Workspace, files: readonly FileTextEdits[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const file of files) {
        const content = await workspace.readFile(file.path);
        assert.equal(content.kind, 'text');
        if (content.kind !== 'text') {
            continue;
        }
        const text = applyTextEdits(content.text, file.edits);
        await workspace.writeFile(file.path, text, content.mtimeMs);
        result.set(file.path, text);
    }
    return result;
}

/**
 * Polls until `read` gives a value: a server answers before it has read the
 * project (tsserver loading the tsconfig, pyright listing the folder's files)
 * with fewer results, and diagnostics come when they come.
 */
async function eventually<T>(read: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 60_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value !== undefined) {
            return value;
        }
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

/** A references answer once it names every one of `paths`. */
function referencesIn(harness: Harness, workspacePath: string, position: { line: number; character: number }, paths: readonly string[]): Promise<string[]> {
    return eventually(async () => {
        const found = [...new Set(pathsOf(await harness.request('textDocument/references', workspacePath, { position, context: { includeDeclaration: true } })))];
        return paths.every((p) => found.includes(p)) ? found : undefined;
    }, `references in ${paths.join(', ')}`);
}

function pathsOf(locations: unknown): string[] {
    return (locations as { uri: string }[]).map((location) => location.uri).sort();
}

describe('refactoring against typescript-language-server (#287)', { timeout: 120_000 }, () => {
    const ideRequire = createRequire(path.join(IDE_ROOT, 'package.json'));
    const command = typescriptServerCommand({
        execPath: process.execPath,
        cliPath: ideRequire.resolve('typescript-language-server/lib/cli.mjs'),
        tsserverPath: ideRequire.resolve('typescript/lib/tsserver.js'),
    }, process.env);
    let harness: Harness;
    let outside: Harness;

    before(() => {
        const root = makeFolder({
            'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'es2022', moduleResolution: 'bundler' } }),
            'a.ts': 'export function greet(name: string, times: number): string {\n    return name.repeat(times);\n}\n',
            'b.ts': "import { greet } from './a';\nexport const x = greet('hi', 2);\n",
            'c.ts': 'export const z = shout("a");\n',
            'd.ts': 'export function shout(text: string): string {\n    return text.toUpperCase();\n}\n',
        });
        harness = startHarness('typescript', command, root);
        // The folder is "app"; "shared" next to it is outside, though the program reads it.
        const parent = makeFolder({
            'shared/config.ts': 'export const config = { port: 8080 };\n',
            'app/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'es2022', moduleResolution: 'bundler' } }),
            'app/main.ts': "import { config } from '../shared/config';\nexport const port = config.port;\n",
        });
        outside = startHarness('typescript', command, parent, path.join(parent, 'app'));
    });

    after(async () => {
        await Promise.all([harness.server.stop(), outside.server.stop()]);
        fs.rmSync(harness.root, { recursive: true, force: true });
        fs.rmSync(path.dirname(outside.root), { recursive: true, force: true });
    });

    it('finds references in a file that is not open', async () => {
        harness.open('a.ts', 'typescript');
        const references = await referencesIn(harness, 'a.ts', { line: 0, character: 17 }, ['codexr-file:/a.ts', 'codexr-file:/b.ts']);
        assert.deepEqual(references, ['codexr-file:/a.ts', 'codexr-file:/b.ts']);
        const highlights = await harness.request('textDocument/documentHighlight', 'a.ts', { position: { line: 0, character: 17 } });
        assert.equal((highlights as unknown[]).length, 1);
    });

    it('renames across files, writing the one that is not open', async () => {
        const prepared = await harness.request('textDocument/prepareRename', 'a.ts', { position: { line: 0, character: 17 } });
        assert.deepEqual(prepared, { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } });
        const edit = await harness.request('textDocument/rename', 'a.ts', { position: { line: 0, character: 17 }, newName: 'salute' });
        const files = workspaceEditFiles(edit);
        assert.deepEqual(files.map((file) => file.path).sort(), ['a.ts', 'b.ts']);
        const workspace = await Workspace.open(harness.root);
        const texts = await applyToDisk(workspace, files.filter((file) => file.path === 'b.ts'));
        assert.equal(texts.get('b.ts'), "import { salute } from './a';\nexport const x = salute('hi', 2);\n");
        assert.equal(fs.readFileSync(path.join(harness.root, 'b.ts'), 'utf8'), texts.get('b.ts'));
        const open = files.find((file) => file.path === 'a.ts');
        assert.ok(open);
        const renamed = applyTextEdits(fs.readFileSync(path.join(harness.root, 'a.ts'), 'utf8'), open.edits);
        assert.match(renamed, /^export function salute\(/);
        // The open file's model changed: the language client sends its text.
        harness.change('a.ts', renamed);
    });

    it('shows signature help inside a call', async () => {
        harness.open('b.ts', 'typescript');
        const help = toSignatureHelp(await harness.request('textDocument/signatureHelp', 'b.ts', {
            position: { line: 1, character: 31 },
            context: { triggerKind: 1, isRetrigger: false },
        }) as Parameters<typeof toSignatureHelp>[0]);
        assert.ok(help, 'signature help');
        assert.match(help.signatures[0]?.label ?? '', /^salute\(name: string, times: number\)/);
        assert.equal(help.activeParameter, 1);
    });

    it('applies a quick fix that adds the missing import', async () => {
        harness.open('c.ts', 'typescript');
        const uri = harness.clientUri('c.ts');
        const diagnostic = await eventually(() => (harness.diagnostics.get(uri) as { code?: unknown; range: unknown; message: string; severity?: number; source?: string }[] | undefined)?.find((d) => d.code === 2304), 'the missing name diagnostic');
        const actions = await harness.request('textDocument/codeAction', 'c.ts', {
            range: diagnostic.range,
            context: { diagnostics: [{ range: diagnostic.range, message: diagnostic.message, severity: diagnostic.severity, code: diagnostic.code, source: diagnostic.source }], triggerKind: 1 },
        }) as { title: string; edit?: unknown; disabled?: string }[];
        const fix = actions.find((action) => action.title.startsWith('Add import from'));
        assert.ok(fix?.edit, `an import fix among ${actions.map((action) => action.title).join(', ')}`);
        assert.equal('command' in fix, false, 'the fix carries no command');
        const files = workspaceEditFiles(fix.edit);
        assert.deepEqual(files.map((file) => file.path), ['c.ts']);
        const text = applyTextEdits(fs.readFileSync(path.join(harness.root, 'c.ts'), 'utf8'), files[0]?.edits ?? []);
        assert.match(text, /^import \{ shout \} from "\.\/d";\n/);
    });

    it('finds workspace symbols, only inside the folder', async () => {
        const symbols = mapWorkspaceSymbols(await harness.server.request('workspace/symbol', buildWorkspaceSymbolRequest({ query: 'salute' })), (uri) => toClientUri(uri, harness.roots));
        assert.ok(symbols.some((symbol) => symbol.name === 'salute' && symbol.location.uri === 'codexr-file:/a.ts'), JSON.stringify(symbols));
    });

    it('refuses a rename that would change a file outside the folder', async () => {
        outside.open('main.ts', 'typescript');
        const references = await referencesIn(outside, 'main.ts', { line: 1, character: 28 }, ['codexr-file:/main.ts']);
        assert.deepEqual(references, ['codexr-file:/main.ts'], 'the declaration outside the folder is left out');
        await assert.rejects(outside.request('textDocument/rename', 'main.ts', { position: { line: 1, character: 28 }, newName: 'listen' }), /Refused workspace edit: it changes a file outside the open folder/);
        assert.equal(fs.readFileSync(path.join(path.dirname(outside.root), 'shared', 'config.ts'), 'utf8'), 'export const config = { port: 8080 };\n');
    });
});

describe('refactoring against the Python language server (#287)', { timeout: 120_000 }, async () => {
    const command = await findPythonServer({
        platform: process.platform,
        env: process.env,
        isFile: (file) => fs.promises.stat(file).then((stat) => stat.isFile(), () => false),
    });
    if (!command) {
        it('needs pyright-langserver or pylsp on PATH', (context) => {
            context.skip('no Python language server on PATH');
        });
        return;
    }
    let harness: Harness;

    before(() => {
        harness = startHarness('python', command, makeFolder({
            'a.py': 'def greet(name, times):\n    return name * times\n',
            'b.py': 'from a import greet\n\nx = greet("hi", 2)\n',
        }));
    });

    after(async () => {
        await harness.server.stop();
        fs.rmSync(harness.root, { recursive: true, force: true });
    });

    it(`finds references and renames across files with ${command.name}, one of them not open`, async () => {
        harness.open('a.py', 'python');
        const references = await referencesIn(harness, 'a.py', { line: 0, character: 5 }, ['codexr-file:/a.py', 'codexr-file:/b.py']);
        assert.deepEqual(references, ['codexr-file:/a.py', 'codexr-file:/b.py']);
        const edit = await harness.request('textDocument/rename', 'a.py', { position: { line: 0, character: 5 }, newName: 'salute' });
        const files = workspaceEditFiles(edit);
        assert.deepEqual(files.map((file) => file.path).sort(), ['a.py', 'b.py']);
        const texts = await applyToDisk(await Workspace.open(harness.root), files.filter((file) => file.path === 'b.py'));
        assert.equal(texts.get('b.py'), 'from a import salute\n\nx = salute("hi", 2)\n');
        const open = files.find((file) => file.path === 'a.py');
        assert.ok(open);
        const renamed = applyTextEdits(fs.readFileSync(path.join(harness.root, 'a.py'), 'utf8'), open.edits);
        assert.match(renamed, /^def salute\(name, times\):/);
        harness.change('a.py', renamed);
    });

    it(`shows signature help inside a call with ${command.name}`, async () => {
        harness.open('b.py', 'python');
        const help = toSignatureHelp(await harness.request('textDocument/signatureHelp', 'b.py', {
            position: { line: 2, character: 16 },
            context: { triggerKind: 1, isRetrigger: false },
        }) as Parameters<typeof toSignatureHelp>[0]);
        assert.ok(help, 'signature help');
        assert.match(help.signatures[0]?.label ?? '', /name.*times/);
        assert.equal(help.signatures[0]?.parameters.length, 2);
    });
});
