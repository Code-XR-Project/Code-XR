import fs from 'node:fs';
import path from 'node:path';
import type { KeyStorage, SecretStoreStatus } from '../../shared/agents.ts';

/**
 * The slice of Electron's `safeStorage` the vault needs, as an interface so
 * the tests can run without Electron (see electronCipher.ts for the real one).
 */
export interface SecretCipher {
    /** True when strings can be encrypted with an OS-backed key. */
    isAvailable(): boolean;
    /** The backend name, for the settings page and for refusing `basic_text`. */
    backend(): string;
    encrypt(plain: string): Buffer;
    decrypt(cipher: Buffer): string;
}

/**
 * Electron on Linux falls back to `basic_text` when there is no keyring: the
 * "encryption" then uses a hard-coded password, which is obfuscation, not
 * protection. The vault treats it like no store at all.
 */
const WEAK_BACKENDS: ReadonlySet<string> = new Set(['basic_text', 'unknown']);

interface VaultFile {
    readonly version: 1;
    /** Provider id -> base64 ciphertext. */
    readonly keys: Record<string, string>;
}

/**
 * Stores provider API keys (#A1). With a real OS secret store, keys are
 * encrypted with it and written to one JSON file of ciphertexts; without one,
 * they are held in memory for this run only and never touch the disk. The
 * plaintext never leaves the main process: callers outside it only get
 * `hint()` and `storageOf()`.
 */
export class KeyVault {
    private readonly file: string;
    private readonly cipher: SecretCipher;
    private encrypted: Record<string, string>;
    private readonly sessionKeys = new Map<string, string>();
    private writing: Promise<void> = Promise.resolve();

    constructor(file: string, cipher: SecretCipher) {
        this.file = file;
        this.cipher = cipher;
        this.encrypted = readVault(file);
    }

    status(): SecretStoreStatus {
        return { available: this.canPersist(), backend: this.cipher.backend() };
    }

    /** Saves a key; resolves once it is on disk (or held, when no store exists). */
    async set(providerId: string, apiKey: string): Promise<KeyStorage> {
        const key = apiKey.trim();
        if (!key) {
            await this.delete(providerId);
            return 'none';
        }
        if (!this.canPersist()) {
            this.sessionKeys.set(providerId, key);
            if (Object.hasOwn(this.encrypted, providerId)) {
                await this.write({ ...this.encrypted, [providerId]: undefined });
            }
            return 'session-only';
        }
        this.sessionKeys.delete(providerId);
        const cipherText = this.cipher.encrypt(key).toString('base64');
        await this.write({ ...this.encrypted, [providerId]: cipherText });
        return 'os-encrypted';
    }

    /** The plaintext key, for the provider adapters in the main process only. */
    get(providerId: string): string | undefined {
        const session = this.sessionKeys.get(providerId);
        if (session !== undefined) {
            return session;
        }
        const stored = this.encrypted[providerId];
        if (stored === undefined || !this.cipher.isAvailable()) {
            return undefined;
        }
        try {
            return this.cipher.decrypt(Buffer.from(stored, 'base64'));
        } catch {
            // Encrypted by another OS user or machine: unreadable, ask again.
            return undefined;
        }
    }

    storageOf(providerId: string): KeyStorage {
        if (this.sessionKeys.has(providerId)) {
            return 'session-only';
        }
        return Object.hasOwn(this.encrypted, providerId) ? 'os-encrypted' : 'none';
    }

    /** The last four characters of the key, or '' when there is none. */
    hint(providerId: string): string {
        const key = this.get(providerId);
        return key && key.length > 8 ? key.slice(-4) : '';
    }

    async delete(providerId: string): Promise<void> {
        this.sessionKeys.delete(providerId);
        if (Object.hasOwn(this.encrypted, providerId)) {
            await this.write({ ...this.encrypted, [providerId]: undefined });
        }
    }

    private canPersist(): boolean {
        return this.cipher.isAvailable() && !WEAK_BACKENDS.has(this.cipher.backend());
    }

    private write(next: Record<string, string | undefined>): Promise<void> {
        const keys: Record<string, string> = {};
        for (const [id, value] of Object.entries(next)) {
            if (value !== undefined) {
                keys[id] = value;
            }
        }
        this.encrypted = keys;
        const body: VaultFile = { version: 1, keys };
        const text = `${JSON.stringify(body, null, 2)}\n`;
        this.writing = this.writing.catch(() => undefined).then(async () => {
            await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
            const temporary = `${this.file}.${process.pid}.tmp`;
            // 0o600: on POSIX, only this user may read even the ciphertext.
            await fs.promises.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
            await fs.promises.rename(temporary, this.file);
        });
        return this.writing;
    }
}

function readVault(file: string): Record<string, string> {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VaultFile>;
        const keys = parsed && typeof parsed.keys === 'object' && parsed.keys !== null ? parsed.keys : {};
        return Object.fromEntries(Object.entries(keys).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
        return {};
    }
}
