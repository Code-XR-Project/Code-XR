import fs from 'node:fs/promises';
import path from 'node:path';
import { MODIFIED_ON_DISK, type DirEntry, type FileContent, type SaveResult, type WorkspaceInfo } from '../../shared/api.ts';
import { EXCLUDED_NAMES, isIgnored, parseGitignore, type IgnoreRule } from './ignoreRules.ts';
import { childPath, isInside, parseWorkspacePath, resolveInWorkspace } from './workspacePath.ts';
import { foldersToWatch, WorkspaceWatcher } from './watcher.ts';

/** Files above this are not sent to the editor (Monaco slows down well before). */
export const MAX_EDITOR_FILE_BYTES = 5 * 1024 * 1024;
/** A NUL byte in the first chunk marks a file as binary, as git does. */
const BINARY_SNIFF_BYTES = 8000;

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
