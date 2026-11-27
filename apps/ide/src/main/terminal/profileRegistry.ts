import { randomUUID } from 'node:crypto';
import type { TerminalProfile, TerminalProfileList } from '../../shared/api.ts';
import { customProfileName, isValidArgs, MAX_CUSTOM_PROFILES, parseCustomProfiles, profileList, type ProfileDetectionDeps, detectProfiles } from './shellProfiles.ts';

/** The two settings this needs from a key-value store (`JsonKeyValueStore` in the app). */
export interface SettingsStore {
    get(key: string): unknown;
    update(key: string, value: unknown): Promise<void>;
}

const DEFAULT_KEY = 'defaultProfile';
const CUSTOM_KEY = 'customProfiles';

/**
 * The terminal profiles of this machine (#137): detected ones, re-detected on
 * every listing so a shell installed while the IDE runs shows up, plus custom
 * ones; and the default, saved in `terminal-settings.json` in the user-data
 * folder. `resolve` is the only way the terminal service turns a profile id
 * from the renderer into an executable.
 */
export class ProfileRegistry {
    private readonly store: SettingsStore;
    private readonly detection: ProfileDetectionDeps;

    constructor(store: SettingsStore, detection: ProfileDetectionDeps) {
        this.store = store;
        this.detection = detection;
    }

    private custom(): TerminalProfile[] {
        return parseCustomProfiles(this.store.get(CUSTOM_KEY), this.detection.platform);
    }

    async list(): Promise<TerminalProfileList> {
        return profileList(await detectProfiles(this.detection), this.custom(), this.store.get(DEFAULT_KEY));
    }

    /** The profile for `id` (null: the default). Throws for anything not listed. */
    async resolve(id: unknown): Promise<TerminalProfile> {
        const list = await this.list();
        const wanted = id === null || id === undefined ? list.defaultProfileId : id;
        const profile = typeof wanted === 'string' ? list.profiles.find((candidate) => candidate.id === wanted) : undefined;
        if (!profile) {
            throw new Error(list.profiles.length === 0 ? 'No shell was found on this machine.' : 'Unknown terminal profile.');
        }
        return profile;
    }

    async setDefault(id: unknown): Promise<TerminalProfileList> {
        const profile = await this.resolve(typeof id === 'string' ? id : '');
        await this.store.update(DEFAULT_KEY, profile.id);
        return this.list();
    }

    /** Saves a custom profile. Only called with a path from a native dialog and arguments the person confirmed. */
    async addCustom(file: string, args: readonly string[]): Promise<TerminalProfileList> {
        const custom = this.custom();
        if (custom.length >= MAX_CUSTOM_PROFILES) {
            throw new Error(`At most ${MAX_CUSTOM_PROFILES} custom profiles.`);
        }
        if (!isValidArgs([...args])) {
            throw new Error('Invalid arguments.');
        }
        const profile = { id: `custom-${randomUUID()}`, name: customProfileName(file, this.detection.platform), path: file, args: [...args] };
        await this.store.update(CUSTOM_KEY, [...custom.map(({ id, name, path, args: a }) => ({ id, name, path, args: a })), profile]);
        return this.list();
    }

    async removeCustom(id: unknown): Promise<TerminalProfileList> {
        const custom = this.custom();
        if (typeof id !== 'string' || !custom.some((profile) => profile.id === id)) {
            throw new Error('Unknown custom profile.');
        }
        await this.store.update(CUSTOM_KEY, custom.filter((profile) => profile.id !== id).map(({ id: i, name, path, args }) => ({ id: i, name, path, args })));
        if (this.store.get(DEFAULT_KEY) === id) {
            await this.store.update(DEFAULT_KEY, undefined);
        }
        return this.list();
    }
}

/** A store that keeps nothing on disk: the smoke run must leave no trace in the person's profile. */
export function memoryStore(): SettingsStore {
    const data = new Map<string, unknown>();
    return {
        get: (key) => data.get(key),
        update: (key, value) => {
            if (value === undefined) {
                data.delete(key);
            } else {
                data.set(key, value);
            }
            return Promise.resolve();
        },
    };
}
