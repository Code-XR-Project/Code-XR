import path from 'node:path';
import type { HostIconData, IconData } from '../../shared/extensionViewsProtocol.ts';
import { imageDataUrl } from './contributions.ts';

/**
 * #261: the icons of tree items that name a file. The host sends the file's
 * absolute path; the main process reads it only when it lies inside one of
 * `roots` (the extensions' folders and the workspace folder) and hands the
 * renderer a `data:` URL, so the renderer never gets a path to load nor a
 * way to read any other file.
 */

function inside(file: string, roots: readonly string[]): boolean {
    const resolved = path.resolve(file);
    return roots.some((root) => {
        const relative = path.relative(root, resolved);
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
}

export function inlineIcon(icon: HostIconData, roots: readonly string[], cache: Map<string, string | null>): IconData | undefined {
    if (icon.kind !== 'iconFile') {
        return icon;
    }
    const read = (file: string | undefined): string | null => {
        if (typeof file !== 'string' || !inside(file, roots)) {
            return null;
        }
        if (!cache.has(file)) {
            if (cache.size > 500) {
                cache.clear();
            }
            cache.set(file, imageDataUrl(file));
        }
        return cache.get(file) ?? null;
    };
    const light = read(icon.file);
    const dark = icon.darkFile ? read(icon.darkFile) : light;
    return light || dark ? { kind: 'image', light: (light ?? dark) as string, dark: (dark ?? light) as string } : undefined;
}

/** Replaces the `icon` of every item of a `treeChildren` answer (dropping the ones it may not read). */
export function inlineTreeIcons(result: unknown, roots: readonly string[], cache: Map<string, string | null>): unknown {
    if (typeof result !== 'object' || result === null || !Array.isArray((result as { items?: unknown }).items)) {
        return result;
    }
    const items = (result as { items: Record<string, unknown>[] }).items.map((item) => {
        if (typeof item !== 'object' || item === null || typeof item['icon'] !== 'object' || item['icon'] === null) {
            return item;
        }
        const icon = inlineIcon(item['icon'] as HostIconData, roots, cache);
        const rest: Record<string, unknown> = { ...item };
        delete rest['icon'];
        return icon ? { ...rest, icon } : rest;
    });
    return { ...(result as object), items };
}
