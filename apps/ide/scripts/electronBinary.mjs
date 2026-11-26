// Path of the Electron executable installed by the `electron` package, plus
// the flags every launch from these scripts needs.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** @returns {string} */
export function electronBinary() {
    // The package's main export is the path of the platform binary.
    return /** @type {string} */ (require('electron'));
}

/**
 * Chromium refuses to start as root without --no-sandbox (containers, some CI
 * images). That flag only switches off the OS-level sandbox of the Chromium
 * processes in that situation; the window's `sandbox: true` preference and the
 * startup assertion are unchanged. Never passed for a normal user.
 * @returns {string[]}
 */
export function launchFlags() {
    return typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [];
}
