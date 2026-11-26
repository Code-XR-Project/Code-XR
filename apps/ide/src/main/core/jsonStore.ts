import fs from 'node:fs';
import path from 'node:path';

/**
 * A small persistent key-value store in one JSON file: the IDE's stand-in for
 * VS Code's `globalState` (the core reads and writes a few flags through it,
 * #15). Reads are served from memory; each update rewrites the file through a
 * temporary file and a rename, so a crash never leaves it half written. A
 * missing or unreadable file starts empty.
 */
export class JsonKeyValueStore {
    private readonly file: string;
    private data: Record<string, unknown>;
    private writing: Promise<void> = Promise.resolve();

    constructor(file: string) {
        this.file = file;
        this.data = readObject(file);
    }

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        return Object.hasOwn(this.data, key) ? (this.data[key] as T) : defaultValue;
    }

    /** Sets `key` (undefined removes it) and resolves once the file is written. */
    update(key: string, value: unknown): Promise<void> {
        const next = { ...this.data };
        if (value === undefined) {
            delete next[key];
        } else {
            next[key] = JSON.parse(JSON.stringify(value)) as unknown;
        }
        this.data = next;
        const text = `${JSON.stringify(next, null, 2)}\n`;
        this.writing = this.writing.catch(() => undefined).then(async () => {
            await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
            const temporary = `${this.file}.${process.pid}.tmp`;
            await fs.promises.writeFile(temporary, text, 'utf8');
            await fs.promises.rename(temporary, this.file);
        });
        return this.writing;
    }

    keys(): readonly string[] {
        return Object.keys(this.data);
    }
}

function readObject(file: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
    } catch {
        return {};
    }
}
