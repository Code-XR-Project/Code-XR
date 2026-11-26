import type { SceneBounds } from '../../shared/api.ts';

/**
 * Pure checks for the analysis scene view (#16): which URLs it may show and
 * which bounds the renderer may ask for. Kept free of Electron so they are
 * unit-tested.
 */

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The origin of a scene served by Code-XR's own local server, or null for
 * anything else. Only http(s) on a loopback host with an explicit port: the
 * scene view must never become a general browser.
 */
export function localSceneOrigin(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !LOCAL_HOSTS.has(parsed.hostname) || parsed.port === '') {
        return null;
    }
    if (parsed.username !== '' || parsed.password !== '') {
        return null;
    }
    return parsed.origin;
}

/** Whole, non-negative pixels, or null when the renderer sent something that is not a rectangle. */
export function sanitizeBounds(value: unknown): SceneBounds | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const numbers = [record['x'], record['y'], record['width'], record['height']];
    if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return null;
    }
    const [x, y, width, height] = (numbers as number[]).map((n) => Math.max(0, Math.round(n)));
    if (width === 0 || height === 0) {
        return null;
    }
    return { x: x!, y: y!, width: Math.min(width!, 16384), height: Math.min(height!, 16384) };
}

/** The analysed folder or file's own name (#155: the header's target). */
export function targetName(target: string): string {
    const parts = target.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? target;
}

/** A short title for the scene's header: the analysed folder's name. */
export function sceneTitle(folder: string): string {
    return `XR · ${targetName(folder)}`;
}
