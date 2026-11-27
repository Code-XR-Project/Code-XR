import fs from 'node:fs';
import path from 'node:path';
import { readJsonc } from './extensionStore.ts';

/**
 * The extensions' own settings (#259): what `getConfiguration().update()`
 * writes and what the host reads back, by full key. They live in
 * `<extensions>/settings.json`, apart from the IDE's settings, whose schema
 * only knows the IDE's keys and plain values; an extension's settings can
 * be any JSON. The file accepts comments, so the person can edit it by hand.
 */
export class ExtensionSettingsStore {
    private readonly file: string;
    private data: Record<string, unknown> = {};
    private loadedMtime = -1;

    constructor(file: string) {
        this.file = file;
        this.load();
    }

    private load(): void {
        try {
            const stat = fs.statSync(this.file);
            if (stat.mtimeMs === this.loadedMtime) {
                return;
            }
            const parsed = readJsonc(this.file);
            this.data = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
            this.loadedMtime = stat.mtimeMs;
        } catch {
            this.data = {};
        }
    }

    /** The values, re-read when the file changed on disk. */
    values(): Record<string, unknown> {
        this.load();
        return structuredClone(this.data);
    }

    update(key: string, value: unknown): void {
        this.load();
        if (value === undefined) {
            delete this.data[key];
        } else {
            this.data[key] = structuredClone(value);
        }
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 4)}\n`);
        fs.renameSync(temp, this.file);
        this.loadedMtime = fs.statSync(this.file).mtimeMs;
    }
}
