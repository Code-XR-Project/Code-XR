import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MODIFIED_ON_DISK, type DirEntry, type ReplaceResult, type SearchMatch, type SearchQuery, type FileContent, type SaveResult, type WorkspaceInfo } from '../../shared/api.ts';
import { EXCLUDED_NAMES, isIgnored, parseGitignore, type IgnoreRule } from './ignoreRules.ts';
import { childPath, isInside, parentPath, parseWorkspacePath, resolveInWorkspace, validateEntryName } from './workspacePath.ts';
import { foldersToWatch, WorkspaceWatcher } from './watcher.ts';
import { listWorkspaceFiles, type FileIndex } from './fileIndex.ts';
import { searchWorkspace, type SearchStats } from './textSearch.ts';
import { replaceInText, type CompiledQuery } from '../../shared/searchText.ts';

/** Files above this are not sent to the editor (Monaco slows down well before). */
export const MAX_EDITOR_FILE_BYTES = 5 * 1024 * 1024;
/** A NUL byte in the first chunk marks a file as binary, as git does. */
const BINARY_SNIFF_BYTES = 8000;
/** #179: the largest image the Markdown preview inlines. */
export const MAX_PREVIEW_IMAGE_BYTES = 8 * 1024 * 1024;
/**
 * Raster images only: an SVG is a document that can carry script and
 * external references, and the preview has no reason to take that on.
 */
const IMAGE_TYPES: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    ico: 'image/x-icon', avif: 'image/avif',
};
/** #256: the largest document the PDF viewer reads (pdf.js keeps it in memory). */
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
/** #256: the documents a viewer tab may read whole, by extension. */
const DOCUMENT_TYPES = new Set(['pdf']);

export function imageMimeType(path: string): string | null {
    const dot = path.lastIndexOf('.');
    return dot > path.lastIndexOf('/') ? IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null : null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * One open project folder (#14). Every path it takes comes from the renderer
 * and is workspace-relative; every file it touches is checked, by real path,
 * to be inside the folder, so neither `..` nor a symlink can lead out.
 */
export class Workspace {
    readonly root: string;
    private readonly realRoot: string;
    private readonly rules: readonly IgnoreRule[];
    private watcher: WorkspaceWatcher | null = null;

    private constructor(root: string, realRoot: string, rules: readonly IgnoreRule[]) {
        this.root = root;
        this.realRoot = realRoot;
        this.rules = rules;
    }

    static async open(folder: string): Promise<Workspace> {
        const root = path.resolve(folder);
        const stat = await fs.stat(root);
        if (!stat.isDirectory()) {
            throw new Error(`Not a folder: ${root}`);
        }
        const realRoot = await fs.realpath(root);
        const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
        return new Workspace(root, realRoot, parseGitignore(gitignore));
    }

    get info(): WorkspaceInfo {
        return { root: this.root, name: path.basename(this.root) || this.root };
    }

    async listDirectory(relativePath: unknown): Promise<DirEntry[]> {
        const parent = parseWorkspacePath(relativePath).join('/');
        const absolute = await this.realPathInside(relativePath);
        const dirents = await fs.readdir(absolute, { withFileTypes: true });
        const entries: DirEntry[] = [];
        for (const dirent of dirents) {
            if (EXCLUDED_NAMES.has(dirent.name)) {
                continue;
            }
            const kind = await this.kindOf(absolute, dirent);
            if (!kind) {
                continue;
            }
            const entryPath = childPath(parent, dirent.name);
            entries.push({ name: dirent.name, path: entryPath, kind, ignored: isIgnored(entryPath, kind === 'directory', this.rules) });
        }
        return entries.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'directory' ? -1 : 1));
    }

    /**
     * #167: an entry's path for the clipboard, absolute or relative to the
     * folder, with the OS's separators. The path is parsed like any other
     * (no `..`, no absolute path), so nothing outside the folder is named.
     */
    displayPath(relativePath: unknown, kind: unknown): string {
        if (kind !== 'absolute' && kind !== 'relative') {
            throw new Error('Unknown path kind.');
        }
        const segments = parseWorkspacePath(relativePath);
        return kind === 'absolute' ? path.join(this.root, ...segments) : segments.join(path.sep);
    }

    /**
     * #176: the absolute path of a file of the folder, for "Run Current File".
     * The real path, so a symlink cannot point the interpreter outside.
     */
    async runnableFile(relativePath: unknown): Promise<string> {
        const real = await this.realPathInside(relativePath);
        if (!(await fs.stat(real)).isFile()) {
            throw new Error('Not a file.');
        }
        return real;
    }

    /** #164: every file for quick open, from the real root so a symlinked root lists like the explorer. */
    listFiles(): Promise<FileIndex> {
        return listWorkspaceFiles(this.realRoot, this.rules);
    }

    /** #165: searches every file quick open lists (searchService.ts batches the results). */
    search(query: SearchQuery, compiled: CompiledQuery, onFile: (path: string, matches: SearchMatch[], total: number) => void, signal: AbortSignal): Promise<SearchStats> {
        return searchWorkspace(this.realRoot, this.rules, query, compiled, onFile, signal);
    }

    /**
     * #165: replaces every match in each file, through readFile/writeFile so
     * the paths are checked like any other, and a file that changed between
     * the read and the write is reported instead of overwritten.
     */
    async replaceInFiles(query: SearchQuery, compiled: CompiledQuery, replacement: string, paths: readonly string[]): Promise<ReplaceResult> {
        let files = 0;
        let replacements = 0;
        const failed: { path: string; message: string }[] = [];
        for (const file of paths) {
            try {
                const content = await this.readFile(file);
                if (content.kind !== 'text') {
                    continue;
                }
                const result = replaceInText(content.text, new RegExp(compiled.regex.source, compiled.regex.flags), replacement, query.isRegex);
                if (result.count === 0) {
                    continue;
                }
                await this.writeFile(file, result.text, content.mtimeMs);
                files++;
                replacements += result.count;
            } catch (error) {
                failed.push({ path: file, message: String(error).includes(MODIFIED_ON_DISK) ? 'changed on disk during the replace' : String(error) });
            }
        }
        return { files, replacements, failed };
    }

    async readFile(relativePath: unknown): Promise<FileContent> {
        const entryPath = parseWorkspacePath(relativePath).join('/');
        const absolute = await this.realPathInside(relativePath);
        const stat = await fs.stat(absolute);
        if (!stat.isFile()) {
            throw new Error(`Not a file: ${entryPath}`);
        }
        if (stat.size > MAX_EDITOR_FILE_BYTES) {
            return { kind: 'too-large', path: entryPath, size: stat.size };
        }
        const bytes = await fs.readFile(absolute);
        if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
            return { kind: 'binary', path: entryPath, size: stat.size };
        }
        return { kind: 'text', path: entryPath, text: bytes.toString('utf8'), mtimeMs: stat.mtimeMs };
    }

    /** #179: an image of the folder as a data: URL (the renderer's CSP allows data: images only). */
    async readImage(relativePath: unknown): Promise<string | null> {
        const mime = imageMimeType(parseWorkspacePath(relativePath).join('/'));
        if (!mime) {
            return null;
        }
        const absolute = await this.realPathInside(relativePath);
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size > MAX_PREVIEW_IMAGE_BYTES) {
            return null;
        }
        return `data:${mime};base64,${(await fs.readFile(absolute)).toString('base64')}`;
    }

    /**
     * #256: a document of the folder (a PDF) as bytes, for a viewer tab. Null
     * for another kind of file or one over `MAX_DOCUMENT_BYTES`.
     */
    async readDocument(relativePath: unknown): Promise<Uint8Array | null> {
        const name = parseWorkspacePath(relativePath).join('/');
        const dot = name.lastIndexOf('.');
        if (dot <= name.lastIndexOf('/') || !DOCUMENT_TYPES.has(name.slice(dot + 1).toLowerCase())) {
            return null;
        }
        const absolute = await this.realPathInside(relativePath);
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) {
            return null;
        }
        return new Uint8Array(await fs.readFile(absolute));
    }

    /**
     * Overwrites an existing file with `text` (UTF-8). Refuses a folder, a text
     * over the editor limit, and, when `expectedMtimeMs` is given, a file whose
     * modification time moved since it was read (`MODIFIED_ON_DISK`). Creating
     * files is a separate, explicit operation.
     */
    async writeFile(relativePath: unknown, text: unknown, expectedMtimeMs?: unknown): Promise<SaveResult> {
        if (typeof text !== 'string') {
            throw new Error('File content must be a string.');
        }
        if (Buffer.byteLength(text, 'utf8') > MAX_EDITOR_FILE_BYTES) {
            throw new Error('File is too large to save from the editor.');
        }
        if (expectedMtimeMs !== undefined && typeof expectedMtimeMs !== 'number') {
            throw new Error('expectedMtimeMs must be a number.');
        }
        const absolute = await this.realPathInside(relativePath);
        const before = await fs.stat(absolute);
        if (!before.isFile()) {
            throw new Error(`Not a file: ${parseWorkspacePath(relativePath).join('/')}`);
        }
        if (expectedMtimeMs !== undefined && before.mtimeMs !== expectedMtimeMs) {
            throw new Error(MODIFIED_ON_DISK);
        }
        await fs.writeFile(absolute, text, 'utf8');
        return { mtimeMs: (await fs.stat(absolute)).mtimeMs };
    }

    /**
     * Creates an empty file or a folder named `name` in the folder `parent`
     * and returns its workspace path. Never overwrites: an existing entry of
     * that name (in any case, on a case-insensitive disk) is refused.
     */
    async createEntry(parent: unknown, name: unknown, kind: unknown): Promise<string> {
        if (kind !== 'file' && kind !== 'directory') {
            throw new Error('kind must be "file" or "directory".');
        }
        const entryName = this.checkCreatableName(name);
        const folder = await this.realPathInside(parent);
        if (!(await fs.stat(folder)).isDirectory()) {
            throw new Error(`Not a folder: ${String(parent)}`);
        }
        const target = path.join(folder, entryName);
        if (kind === 'directory') {
            await fs.mkdir(target).catch((error: NodeJS.ErrnoException) => { throw existsError(error, entryName); });
        } else {
            await fs.writeFile(target, '', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { throw existsError(error, entryName); });
        }
        return childPath(parseWorkspacePath(parent).join('/'), entryName);
    }

    /**
     * Renames the entry at `relativePath` within its folder and returns the new
     * workspace path. A symlink is renamed as a link. Refuses the root, and a
     * name already taken by another entry (a change of case alone is allowed).
     */
    async rename(relativePath: unknown, newName: unknown): Promise<string> {
        const source = await this.entryPathInside(relativePath);
        const name = this.checkCreatableName(newName);
        const target = path.join(path.dirname(source), name);
        const existing = await fs.lstat(target).catch(() => null);
        if (existing) {
            const same = await fs.lstat(source);
            if (existing.ino !== same.ino || existing.dev !== same.dev) {
                throw new Error(`${name} already exists.`);
            }
        }
        await fs.rename(source, target);
        return childPath(parentPath(relativePath), name);
    }

    /**
     * Moves the entry at `relativePath` to the OS trash through `trashItem`
     * (Electron's `shell.trashItem`; injected so this class stays Node-only).
     * Never deletes outright, and never the root.
     */
    async trash(relativePath: unknown, trashItem: (absolute: string) => Promise<void>): Promise<void> {
        await trashItem(await this.entryPathInside(relativePath));
    }

    /**
     * #285: copies the entry at `from` (a file, or a folder with everything in
     * it) into the folder `toFolder` and returns the copy's workspace path.
     * Both ends are checked by real path; a folder is never pasted into itself
     * or below itself. A name already taken gets " copy", then " copy 2"...
     * before the extension, as VS Code does, so nothing is ever overwritten.
     * The copy is planned whole first and refused over `limits`, so a refused
     * copy writes nothing.
     */
    async copyEntry(from: unknown, toFolder: unknown, limits: CopyLimits = COPY_LIMITS): Promise<string> {
        const entry = await this.entryPathInside(from);
        const source = await fs.realpath(entry);
        if (!isInside(this.realRoot, source)) {
            throw new Error(`Path leaves the workspace: ${String(from)}`);
        }
        const name = path.basename(entry);
        if (EXCLUDED_NAMES.has(name)) {
            throw new Error(`${name} is hidden by the explorer; copy it outside the IDE.`);
        }
        const folder = await this.folderInside(toFolder);
        const stat = await fs.stat(source);
        if (stat.isDirectory() && isInside(source, folder)) {
            throw new Error('A folder cannot be pasted into itself or a folder inside it.');
        }
        const plan = await this.planCopy(source, stat, limits);
        const copyName = await freeCopyName(folder, name, stat.isDirectory());
        await writeCopy(plan, path.join(folder, copyName));
        return childPath(parseWorkspacePath(toFolder).join('/'), copyName);
    }

    /**
     * #285: moves the entry at `from` into the folder `toFolder` (cut and
     * paste) and returns its new workspace path. A symlink moves as a link,
     * as in `rename`. Refuses the root, a folder moved into itself or below
     * itself, and a name already taken in `toFolder` (never overwrites).
     * Moving into the folder it is already in changes nothing.
     */
    async moveEntry(from: unknown, toFolder: unknown, limits: CopyLimits = COPY_LIMITS): Promise<string> {
        const source = await this.entryPathInside(from);
        const folder = await this.folderInside(toFolder);
        const name = path.basename(source);
        const destination = childPath(parseWorkspacePath(toFolder).join('/'), name);
        if (path.dirname(source) === folder) {
            return destination;
        }
        if (EXCLUDED_NAMES.has(name)) {
            throw new Error(`${name} is hidden by the explorer; move it outside the IDE.`);
        }
        const stat = await fs.lstat(source);
        if (stat.isDirectory() && isInside(await fs.realpath(source), folder)) {
            throw new Error('A folder cannot be moved into itself or a folder inside it.');
        }
        const target = path.join(folder, name);
        if (await fs.lstat(target).catch(() => null)) {
            throw new Error(`${name} already exists in ${parseWorkspacePath(toFolder).join('/') || 'the top folder'}.`);
        }
        try {
            await fs.rename(source, target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
                throw error;
            }
            // Another disk (behind a symlinked folder): copy, then remove the original.
            const real = await fs.realpath(source);
            await writeCopy(await this.planCopy(real, await fs.stat(real), limits), target);
            await fs.rm(source, { recursive: true });
        }
        return destination;
    }

    /**
     * #285: the real, absolute path of an entry for the OS file manager
     * (`shell.showItemInFolder`); refuses anything that leads outside.
     */
    revealablePath(relativePath: unknown): Promise<string> {
        return this.realPathInside(relativePath);
    }

    /**
     * #285: the folder a terminal opened on an entry starts in: the folder
     * itself, or a file's folder. Real path, checked inside the workspace.
     */
    async terminalFolder(relativePath: unknown): Promise<string> {
        const real = await this.realPathInside(relativePath);
        return (await fs.stat(real)).isDirectory() ? real : path.dirname(real);
    }

    /**
     * Walks what a copy will write, before anything is written: every entry
     * and its size, refused over `limits`. A symlink inside a copied folder is
     * copied as what it points to when that stays inside the workspace (as the
     * explorer shows it) and is not a folder above it (a loop); any other link
     * is left out.
     */
    private async planCopy(source: string, stat: { isDirectory(): boolean; isFile(): boolean; size: number }, limits: CopyLimits): Promise<CopyPlan> {
        const plan: CopyPlan = { items: [], bytes: 0 };
        const add = (item: CopyItem, size: number): void => {
            plan.items.push(item);
            plan.bytes += size;
            if (plan.items.length > limits.maxEntries) {
                throw new Error(`The copy would hold more than ${limits.maxEntries} files and folders; copy it outside the IDE.`);
            }
            if (plan.bytes > limits.maxBytes) {
                throw new Error(`The copy would be larger than ${Math.round(limits.maxBytes / (1024 * 1024))} MB; copy it outside the IDE.`);
            }
        };
        if (!stat.isDirectory()) {
            if (!stat.isFile()) {
                throw new Error('Only files and folders can be copied.');
            }
            add({ relative: [], kind: 'file', source }, stat.size);
            return plan;
        }
        add({ relative: [], kind: 'directory', source }, 0);
        const walk = async (folder: string, relative: readonly string[], ancestors: readonly string[]): Promise<void> => {
            for (const dirent of await fs.readdir(folder, { withFileTypes: true })) {
                let real = path.join(folder, dirent.name);
                if (dirent.isSymbolicLink()) {
                    real = await fs.realpath(real).catch(() => '');
                    if (!real || !isInside(this.realRoot, real) || ancestors.some((ancestor) => isInside(real, ancestor))) {
                        continue;
                    }
                }
                const entryStat = await fs.stat(real).catch(() => null);
                const childRelative = [...relative, dirent.name];
                if (entryStat?.isDirectory()) {
                    add({ relative: childRelative, kind: 'directory', source: real }, 0);
                    await walk(real, childRelative, [...ancestors, real]);
                } else if (entryStat?.isFile()) {
                    add({ relative: childRelative, kind: 'file', source: real }, entryStat.size);
                }
            }
        };
        await walk(source, [], [source]);
        return plan;
    }

    /**
     * Watches the folders behind `entries` (expanded folders, open files) and
     * calls `onChange` with the workspace paths that changed. Replaces the
     * previous set; the first call decides the listener.
     */
    setWatched(entries: unknown, onChange: (paths: readonly string[]) => void): void {
        if (!Array.isArray(entries) || entries.length > 10_000) {
            throw new Error('Watched entries must be an array of at most 10000 items.');
        }
        const parsed = entries.map((entry: unknown) => {
            const candidate = entry as { path?: unknown; kind?: unknown } | null;
            if (!candidate || typeof candidate.path !== 'string' || (candidate.kind !== 'file' && candidate.kind !== 'directory')) {
                throw new Error('Each watched entry needs a path and a kind.');
            }
            return { path: candidate.path, kind: candidate.kind as 'file' | 'directory' };
        });
        this.watcher ??= new WorkspaceWatcher(this.root, this.realRoot, onChange);
        this.watcher.setFolders(foldersToWatch(parsed));
    }

    /** Stops every watcher (window closed, or another folder opened). */
    dispose(): void {
        this.watcher?.dispose();
        this.watcher = null;
    }

    /**
     * The path of an entry itself (not resolved if it is a symlink) whose
     * parent folder is really inside the workspace. Refuses the root.
     */
    private async entryPathInside(relativePath: unknown): Promise<string> {
        const segments = parseWorkspacePath(relativePath);
        const name = segments.at(-1);
        if (name === undefined) {
            throw new Error('The workspace folder itself cannot be renamed, moved, copied or deleted here.');
        }
        const entry = path.join(await this.realPathInside(parentPath(relativePath)), name);
        await fs.lstat(entry);
        return entry;
    }

    /** The real path of a workspace folder; refused when it is not a folder. */
    private async folderInside(relativePath: unknown): Promise<string> {
        const folder = await this.realPathInside(relativePath);
        if (!(await fs.stat(folder)).isDirectory()) {
            throw new Error(`Not a folder: ${String(relativePath)}`);
        }
        return folder;
    }

    private checkCreatableName(name: unknown): string {
        const valid = validateEntryName(name);
        if (EXCLUDED_NAMES.has(valid)) {
            throw new Error(`${valid} is hidden by the explorer; create it outside the IDE.`);
        }
        return valid;
    }

    /** The real path of a workspace path; throws if it (or a symlink on the way) leads outside. */
    private async realPathInside(relativePath: unknown): Promise<string> {
        const real = await fs.realpath(resolveInWorkspace(this.root, relativePath));
        if (!isInside(this.realRoot, real)) {
            throw new Error(`Path leaves the workspace: ${String(relativePath)}`);
        }
        return real;
    }

    /** File or folder; a symlink counts as its target only when the target stays inside. Anything else is skipped. */
    private async kindOf(folder: string, dirent: { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): Promise<DirEntry['kind'] | null> {
        if (dirent.isDirectory()) {
            return 'directory';
        }
        if (dirent.isFile()) {
            return 'file';
        }
        if (!dirent.isSymbolicLink()) {
            return null;
        }
        try {
            const target = await fs.realpath(path.join(folder, dirent.name));
            if (!isInside(this.realRoot, target)) {
                return null;
            }
            const stat = await fs.stat(target);
            return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
        } catch {
            return null;
        }
    }
}

/** #285: the most one copy may write, so a paste cannot fill the disk by mistake. */
export interface CopyLimits {
    readonly maxEntries: number;
    readonly maxBytes: number;
}
export const COPY_LIMITS: CopyLimits = { maxEntries: 10_000, maxBytes: 512 * 1024 * 1024 };

interface CopyItem {
    /** Segments below the copied entry (empty for the entry itself). */
    readonly relative: readonly string[];
    readonly kind: 'file' | 'directory';
    /** The real path to read from. */
    readonly source: string;
}

interface CopyPlan {
    readonly items: CopyItem[];
    bytes: number;
}

/** Writes a planned copy at `target`, each folder before its contents, never over an existing entry. */
async function writeCopy(plan: CopyPlan, target: string): Promise<void> {
    for (const item of plan.items) {
        const destination = path.join(target, ...item.relative);
        if (item.kind === 'directory') {
            await fs.mkdir(destination);
        } else {
            await fs.copyFile(item.source, destination, fsConstants.COPYFILE_EXCL);
        }
    }
}

/**
 * #285: a free name for a copy in `folder`: the name itself, then " copy",
 * " copy 2", " copy 3"... before a file's extension (`a.txt`, `a copy.txt`,
 * `a copy 2.txt`), as VS Code names them; a name that already ends in
 * " copy" or " copy N" counts on from there. A dotfile (`.env`) and a folder
 * have no extension.
 */
export async function freeCopyName(folder: string, name: string, isDirectory: boolean): Promise<string> {
    const dot = isDirectory ? -1 : name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot) : '';
    const base = dot > 0 ? name.slice(0, dot) : name;
    const counted = /^(.+) copy(?: (\d+))?$/.exec(base);
    const stem = counted?.[1] ?? base;
    let next = counted ? Number(counted[2] ?? '1') + 1 : 1;
    let candidate = name;
    for (let attempt = 0; attempt < 10_000; attempt++) {
        if (!(await fs.lstat(path.join(folder, candidate)).catch(() => null))) {
            return candidate === name ? name : validateEntryName(candidate);
        }
        candidate = `${stem} copy${next >= 2 ? ` ${next}` : ''}${extension}`;
        next++;
    }
    throw new Error(`No free name for a copy of ${name}.`);
}

function existsError(error: NodeJS.ErrnoException, name: string): Error {
    return error.code === 'EEXIST' ? new Error(`${name} already exists.`) : error;
}
