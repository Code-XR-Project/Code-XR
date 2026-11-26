import fs from 'node:fs/promises';
import path from 'node:path';
import {
    cleanSettings, formatSettingsFile, parseSettingsFile, resolveSettings, settingDefinition, stripJsonComments, validSettingValue,
    type SettingScope, type SettingValues,
} from '../../shared/settings.ts';
import type { SettingsReport } from '../../shared/api.ts';
import type { Workspace } from '../workspace/workspace.ts';

/**
 * Settings storage (#18, part 2). The user's settings are one JSON file in
 * the IDE's user-data folder, read once and kept in memory; the folder's are
 * `.codexr/settings.json` in the open folder, read through the workspace
 * (so its path checks apply) every time they are asked for, which is how an
 * edit made in the editor takes effect. Writes keep keys this version does
 * not know (a newer IDE's), go through a temporary file and a rename, and
 * only ever store values the schema accepts.
 */

export const FOLDER_SETTINGS_DIR = '.codexr';
export const FOLDER_SETTINGS_PATH = `${FOLDER_SETTINGS_DIR}/settings.json`;

export interface SettingsStorage {
    read(): Promise<string | null>;
    write(text: string): Promise<void>;
}

/** The user's settings file; in the smoke run, memory only. */
export function fileStorage(file: string): SettingsStorage {
    let writing: Promise<void> = Promise.resolve();
    return {
        read: () => fs.readFile(file, 'utf8').catch(() => null),
        write(text) {
            writing = writing.catch(() => undefined).then(async () => {
                await fs.mkdir(path.dirname(file), { recursive: true });
                const temporary = `${file}.${process.pid}.tmp`;
                await fs.writeFile(temporary, text, 'utf8');
                await fs.rename(temporary, file);
            });
            return writing;
        },
    };
}

export function memoryStorage(): SettingsStorage {
    let text: string | null = null;
    return { read: async () => text, write: async (next) => { text = next; } };
}

/** Everything a settings file holds, known keys or not (written back as is). */
function rawObject(text: string | null): Record<string, unknown> {
    if (!text || text.trim() === '') {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(stripJsonComments(text));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
    } catch {
        return {};
    }
}

function applyChange(raw: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
    const next = { ...raw };
    if (value === null || value === undefined) {
        delete next[key];
        return next;
    }
    const valid = validSettingValue(key, value);
    if (valid === undefined) {
        throw new Error(`Not a valid value for ${key}.`);
    }
    next[key] = valid;
    return next;
}


export class SettingsService {
    private userRaw: Record<string, unknown> = {};
    private userError: string | null = null;
    private readonly loaded: Promise<void>;
    private readonly storage: SettingsStorage;

    constructor(storage: SettingsStorage) {
        this.storage = storage;
        this.loaded = this.reloadUser();
    }

    async reloadUser(): Promise<void> {
        const text = await this.storage.read();
        const parsed = parseSettingsFile(text ?? '');
        this.userError = parsed.error === null ? null : `Your settings file could not be read: ${parsed.error}`;
        this.userRaw = rawObject(text);
    }

    private get user(): SettingValues {
        return cleanSettings(this.userRaw);
    }

    async snapshot(workspace: Workspace | null): Promise<SettingsReport> {
        await this.loaded;
        const errors = this.userError ? [this.userError] : [];
        let folder: SettingValues | null = null;
        if (workspace) {
            const text = await readFolderFile(workspace);
            const parsed = parseSettingsFile(text ?? '');
            folder = parsed.values;
            if (parsed.error) {
                errors.push(`${FOLDER_SETTINGS_PATH} could not be read: ${parsed.error}`);
            }
        }
        return { ...resolveSettings(this.user, folder), errors };
    }

    /** Sets (or with null, removes) `key` in one scope and returns the new snapshot. */
    async update(workspace: Workspace | null, scope: unknown, key: unknown, value: unknown): Promise<SettingsReport> {
        await this.loaded;
        if (typeof key !== 'string' || !settingDefinition(key)) {
            throw new Error('Unknown setting.');
        }
        if (scope === 'user') {
            this.userRaw = applyChange(this.userRaw, key, value);
            await this.storage.write(formatSettingsFile(this.userRaw));
        } else if (scope === 'folder') {
            if (!workspace) {
                throw new Error('Open a folder to change its settings.');
            }
            const text = await readFolderFile(workspace);
            if (text !== null && parseSettingsFile(text).error) {
                throw new Error(`${FOLDER_SETTINGS_PATH} could not be read; fix it in the editor first.`);
            }
            await writeFolderFile(workspace, formatSettingsFile(applyChange(rawObject(text), key, value)));
        } else {
            throw new Error('Unknown settings scope.');
        }
        return this.snapshot(workspace);
    }

    /** Creates the folder's settings file if needed and returns its workspace path, for the editor. */
    async ensureFolderFile(workspace: Workspace): Promise<string> {
        if ((await readFolderFile(workspace)) === null) {
            await writeFolderFile(workspace, '{\n}\n');
        }
        return FOLDER_SETTINGS_PATH;
    }
}

async function readFolderFile(workspace: Workspace): Promise<string | null> {
    try {
        const content = await workspace.readFile(FOLDER_SETTINGS_PATH);
        return content.kind === 'text' ? content.text : null;
    } catch {
        return null;
    }
}

async function writeFolderFile(workspace: Workspace, text: string): Promise<void> {
    await workspace.createEntry('', FOLDER_SETTINGS_DIR, 'directory').catch(() => undefined);
    await workspace.createEntry(FOLDER_SETTINGS_DIR, 'settings.json', 'file').catch(() => undefined);
    await workspace.writeFile(FOLDER_SETTINGS_PATH, text);
}

export type { SettingScope };
