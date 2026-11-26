import { cleanUserKeybindings, formatKeybindingsFile, parseKeybindingsFile } from '../../shared/keybindings.ts';
import type { KeybindingsReport } from '../../shared/api.ts';
import type { SettingsStorage } from './settingsService.ts';

/**
 * The user's keybinding rules (#18, part 3): `keybindings.json` in the IDE's
 * user-data folder (shared/keybindings.ts holds the format). Read on every
 * request, so a hand edit takes effect the next time the IDE asks; written
 * only with rules that pass validation, through the same temporary-file and
 * rename as the settings.
 */
export class KeybindingsService {
    private readonly storage: SettingsStorage;
    private readonly file: string | null;

    constructor(storage: SettingsStorage, file: string | null) {
        this.storage = storage;
        this.file = file;
    }

    async snapshot(): Promise<KeybindingsReport> {
        const { entries, errors } = parseKeybindingsFile(await this.storage.read());
        return { entries, errors, file: this.file };
    }

    /** Replaces every rule. A malformed rule rejects the whole change: nothing is written. */
    async update(entries: unknown): Promise<KeybindingsReport> {
        const cleaned = cleanUserKeybindings(entries);
        if (cleaned.errors.length > 0) {
            throw new Error(cleaned.errors[0]);
        }
        await this.storage.write(formatKeybindingsFile(cleaned.entries));
        return { entries: cleaned.entries, errors: [], file: this.file };
    }
}
