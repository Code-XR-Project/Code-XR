import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Recently opened folders (#14), most recent first, kept in a small JSON file
 * in the IDE's user-data folder. The list is the only set of paths the
 * renderer may ask to open without the folder picker, so a compromised page
 * cannot open an arbitrary folder by name.
 */
export const MAX_RECENT_FOLDERS = 10;

/** `folder` moved to the front of `list`, without duplicates (case-insensitively on Windows and macOS), capped. */
export function withRecent(list: readonly string[], folder: string, platform: string = process.platform): string[] {
    const key = (p: string): string => (platform === 'linux' ? p : p.toLowerCase());
    const resolved = path.resolve(folder);
    return [resolved, ...list.filter((p) => key(p) !== key(resolved))].slice(0, MAX_RECENT_FOLDERS);
}

/** Parses the stored file, dropping anything that is not an absolute path string. */
export function parseRecent(text: string): string[] {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return [];
    }
    const folders = (data as { folders?: unknown } | null)?.folders;
    return Array.isArray(folders)
        ? folders.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)).slice(0, MAX_RECENT_FOLDERS)
        : [];
}

export class RecentFolders {
    private list: string[] = [];
    private readonly file: string;
    private readonly onChange: (list: readonly string[]) => void;

    constructor(file: string, onChange: (list: readonly string[]) => void = () => {}) {
        this.file = file;
        this.onChange = onChange;
    }

    async load(): Promise<void> {
        this.list = parseRecent(await fs.readFile(this.file, 'utf8').catch(() => ''));
        this.onChange(this.list);
    }

    get folders(): readonly string[] {
        return this.list;
    }

    has(folder: unknown): folder is string {
        return typeof folder === 'string' && this.list.includes(folder);
    }

    async add(folder: string): Promise<void> {
        await this.update(withRecent(this.list, folder));
    }

    /** Drops a folder that could no longer be opened. */
    async remove(folder: string): Promise<void> {
        await this.update(this.list.filter((p) => p !== folder));
    }

    async clear(): Promise<void> {
        await this.update([]);
    }

    private async update(next: string[]): Promise<void> {
        this.list = next;
        this.onChange(this.list);
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(this.file, `${JSON.stringify({ folders: this.list }, null, 2)}\n`, 'utf8');
    }
}
