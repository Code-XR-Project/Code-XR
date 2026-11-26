import { safeStorage } from 'electron';
import type { SecretCipher } from './keyVault.ts';

/**
 * Electron's `safeStorage` as the vault's cipher: Keychain on macOS, DPAPI on
 * Windows, libsecret or kwallet on Linux. On Linux the backend is reported so
 * the vault can refuse the `basic_text` fallback (no keyring available).
 */
export function electronCipher(): SecretCipher {
    return {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        backend: () => {
            if (process.platform === 'darwin') {
                return 'keychain';
            }
            if (process.platform === 'win32') {
                return 'dpapi';
            }
            return safeStorage.getSelectedStorageBackend();
        },
        encrypt: (plain) => safeStorage.encryptString(plain),
        decrypt: (cipher) => safeStorage.decryptString(cipher),
    };
}
