import type { GalleryExtension, InstalledExtension } from '../../shared/extensions.ts';

/** Pure helpers of the Extensions view (#255), unit-tested in Node. */

/** `1234567` -> `1.2M`, `45300` -> `45.3K`. */
export function compactCount(value: number): string {
    if (value >= 1_000_000) {
        return `${trim(value / 1_000_000)}M`;
    }
    if (value >= 1_000) {
        return `${trim(value / 1_000)}K`;
    }
    return String(Math.max(0, Math.round(value)));
}

function trim(value: number): string {
    return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}

/** What an installed extension's row says about it. */
export function installedStateLabel(extension: InstalledExtension): string {
    if (extension.state === 'disabled') {
        return 'Disabled';
    }
    if (extension.state === 'restricted') {
        return 'Disabled in Restricted Mode';
    }
    if (extension.activation === 'failed') {
        return 'Failed to activate';
    }
    if (extension.activation === 'active') {
        return 'Active';
    }
    return extension.engineWarning ? `Enabled (asks for VS Code ${extension.engine})` : 'Enabled';
}

/** The action a registry result offers. */
export function rowAction(gallery: GalleryExtension, installed: InstalledExtension | undefined, busy: boolean): { kind: 'busy' | 'install' | 'update' | 'installed' } {
    if (busy) {
        return { kind: 'busy' };
    }
    if (!installed) {
        return { kind: 'install' };
    }
    return { kind: newer(gallery.version, installed.version) ? 'update' : 'installed' };
}

function newer(a: string, b: string): boolean {
    const parse = (v: string): number[] => v.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < 3; i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d !== 0) {
            return d > 0;
        }
    }
    return false;
}

/** Whether an installed extension matches the search text (name, id, publisher, description). */
export function matchesInstalled(extension: InstalledExtension, text: string): boolean {
    const needle = text.trim().toLowerCase();
    if (needle === '') {
        return true;
    }
    return [extension.displayName, extension.id, extension.publisher, extension.description, ...extension.categories].some((field) => field.toLowerCase().includes(needle));
}
