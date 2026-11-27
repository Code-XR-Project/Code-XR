'use strict';

/**
 * The folder-level import graph of src/, for the dependency-direction test.
 *
 * A "folder" is the first directory under src/ (`src/extension.ts` is
 * "(root)"), or the first two under the areas listed in `twoLevelAreas` of
 * folderDependencies.json (`core/server`, `features/analysis`): there each
 * subsystem or feature is its own unit. Every relative import counts, including `import type`,
 * `export … from`, dynamic `import()`, `require()` and `import('…')` type
 * nodes: a type edge is still an edge a future package split has to honour.
 *
 * Run it to print what the data file has to say about the current tree:
 *     node test/tooling/folderDependencies.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const projectRoot = path.resolve(__dirname, '..', '..');
const srcRoot = path.join(projectRoot, 'src');
const dataPath = path.join(__dirname, 'folderDependencies.json');
const ROOT_FOLDER = '(root)';

function collectSourceFiles(directory = srcRoot, files = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collectSourceFiles(fullPath, files);
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            files.push(fullPath);
        }
    }
    return files.sort();
}

function toSrcRelative(file) {
    return path.relative(srcRoot, file).split(path.sep).join('/');
}

function readData() {
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
}

const twoLevelAreas = new Set(readData().twoLevelAreas || []);

function folderOf(file) {
    const segments = toSrcRelative(file).split('/');
    if (segments.length === 1) {
        return ROOT_FOLDER;
    }
    return twoLevelAreas.has(segments[0]) && segments.length > 2 ? `${segments[0]}/${segments[1]}` : segments[0];
}

function resolveRelative(fromFile, specifier) {
    const base = path.resolve(path.dirname(fromFile), specifier.replace(/\.js$/, ''));
    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function specifierOf(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        return node.moduleSpecifier.text;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
        return node.moduleReference.expression.text;
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        if (isDynamicImport || isRequire) {
            return node.arguments[0].text;
        }
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        return node.argument.literal.text;
    }
    return undefined;
}

/** File graph: every src file, the src files it imports, and whether it imports `vscode` itself. */
function buildFileGraph() {
    const graph = new Map();
    const importsVscode = new Set();
    for (const file of collectSourceFiles()) {
        const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        const dependencies = new Set();
        const visit = (node) => {
            const specifier = specifierOf(node);
            if (specifier === 'vscode') {
                importsVscode.add(file);
            } else if (specifier && specifier.startsWith('.')) {
                const resolved = resolveRelative(file, specifier);
                if (resolved) {
                    dependencies.add(resolved);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        graph.set(file, dependencies);
    }
    return { graph, importsVscode };
}

/** Files from which no import path reaches `vscode`. */
function vscodeFreeFiles({ graph, importsVscode }) {
    const bound = new Set(importsVscode);
    let changed = true;
    while (changed) {
        changed = false;
        for (const [file, dependencies] of graph) {
            if (!bound.has(file) && [...dependencies].some((dependency) => bound.has(dependency))) {
                bound.add(file);
                changed = true;
            }
        }
    }
    return [...graph.keys()].filter((file) => !bound.has(file)).map(toSrcRelative);
}

/** `{ "<from>": { "<to>": [ "a.ts -> b.ts", … ] } }` for every cross-folder import. */
function folderEdges({ graph }) {
    const edges = {};
    for (const [file, dependencies] of graph) {
        for (const dependency of dependencies) {
            const from = folderOf(file);
            const to = folderOf(dependency);
            if (from !== to) {
                edges[from] ??= {};
                (edges[from][to] ??= []).push(`${toSrcRelative(file)} -> ${toSrcRelative(dependency)}`);
            }
        }
    }
    return edges;
}

/** Folders that import each other, as sorted `a<->b` keys. */
function twoWayPairs(edges) {
    const pairs = [];
    for (const from of Object.keys(edges)) {
        for (const to of Object.keys(edges[from])) {
            if (from < to && edges[to]?.[from]) {
                pairs.push(`${from}<->${to}`);
            }
        }
    }
    return pairs.sort();
}

function sourceFolders({ graph }) {
    return [...new Set([...graph.keys()].map(folderOf))].sort();
}

function measure() {
    const fileGraph = buildFileGraph();
    const edges = folderEdges(fileGraph);
    return {
        folders: sourceFolders(fileGraph),
        edges,
        twoWayPairs: twoWayPairs(edges),
        vscodeFree: vscodeFreeFiles(fileGraph),
        fileCount: fileGraph.graph.size,
    };
}

module.exports = { measure, readData, folderOf, dataPath, ROOT_FOLDER };

if (require.main === module) {
    const measured = measure();
    const mayImport = {};
    for (const folder of measured.folders) {
        mayImport[folder] = Object.keys(measured.edges[folder] || {}).sort();
    }
    process.stdout.write(`${JSON.stringify({
        mayImport,
        twoWayPairs: measured.twoWayPairs,
        vscodeFree: `${measured.vscodeFree.length} of ${measured.fileCount}`,
    }, null, 2)}\n`);
}
