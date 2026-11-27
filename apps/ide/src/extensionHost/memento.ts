import fs from 'node:fs';
import path from 'node:path';

/**
 * `ExtensionContext.globalState` / `workspaceState` (#259): a key-value store
 * per extension, kept in a JSON file in the extension's storage folder and
 * written a moment after the last change (and on shutdown).
 */
export class FileMemento {
    private readonly file: string | null;
    private values: Record<string, unknown>;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private syncKeys: readonly string[] = [];

    /** `file` null keeps the values in memory only (no folder open, for the workspace state). */
    constructor(file: string | null) {
        this.file = file;
        this.values = {};
        if (file) {
            try {
                const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                    this.values = parsed as Record<string, unknown>;
                }
            } catch {
                // First use, or a damaged file: start empty.
            }
        }
    }

    keys(): readonly string[] {
        return Object.keys(this.values);
    }

    get<T>(key: string, defaultValue?: T): T | undefined {
        const value = this.values[key];
        return value === undefined ? defaultValue : structuredClone(value) as T;
    }

    update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            delete this.values[key];
        } else {
            this.values[key] = structuredClone(value);
        }
        this.schedule();
        return Promise.resolve();
    }

    /** Settings Sync does not exist here; kept so extensions can call it. */
    setKeysForSync(keys: readonly string[]): void {
        this.syncKeys = [...keys];
    }

    get keysForSync(): readonly string[] {
        return this.syncKeys;
    }

    private schedule(): void {
        if (!this.file || this.timer) {
            return;
        }
        this.timer = setTimeout(() => this.flush(), 200);
    }

    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.file) {
            return;
        }
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const temp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(this.values));
            fs.renameSync(temp, this.file);
        } catch (error) {
            console.error(`Could not save the extension state to ${this.file}:`, error);
        }
    }
}
