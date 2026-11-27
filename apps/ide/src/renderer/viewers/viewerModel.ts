/**
 * #256: the pure parts of the PDF and image viewers: zoom steps, the matches
 * of a find over page texts, and the size line. Kept free of the DOM so the
 * unit tests run them under Node.
 */

/** The zoom levels the + and - buttons step through (1 is 100 %). */
export const ZOOM_STEPS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
export const MIN_ZOOM = ZOOM_STEPS[0] ?? 0.25;
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 5;

export function clampZoom(zoom: number): number {
    return Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1;
}

/** The next step above (`direction` 1) or below (-1) `zoom`, which need not be a step itself (a fit). */
export function stepZoom(zoom: number, direction: 1 | -1): number {
    const epsilon = 1e-6;
    if (direction > 0) {
        return ZOOM_STEPS.find((step) => step > zoom + epsilon) ?? MAX_ZOOM;
    }
    return [...ZOOM_STEPS].reverse().find((step) => step < zoom - epsilon) ?? MIN_ZOOM;
}

/** The zoom that makes `contentWidth` fill `availableWidth` (a margin each side), within the limits. */
export function fitZoom(contentWidth: number, availableWidth: number, margin = 16): number {
    if (contentWidth <= 0 || availableWidth <= 2 * margin) {
        return 1;
    }
    return clampZoom((availableWidth - 2 * margin) / contentWidth);
}

export function zoomLabel(zoom: number): string {
    return `${Math.round(zoom * 100)}%`;
}

/** A match of the find: page index (from 0) and the character offset in that page's text. */
export interface PageMatch {
    readonly page: number;
    readonly offset: number;
}

/** At most this many matches are listed (a one-letter query on a book would list them all). */
export const MAX_FIND_MATCHES = 1000;

/** Every case-insensitive occurrence of `query` in `pages`, in reading order. */
export function findInPages(pages: readonly string[], query: string): PageMatch[] {
    const needle = query.toLocaleLowerCase();
    const matches: PageMatch[] = [];
    if (needle.length === 0) {
        return matches;
    }
    pages.forEach((text, page) => {
        const haystack = text.toLocaleLowerCase();
        let offset = haystack.indexOf(needle);
        while (offset >= 0 && matches.length < MAX_FIND_MATCHES) {
            matches.push({ page, offset });
            offset = haystack.indexOf(needle, offset + needle.length);
        }
    });
    return matches;
}

/**
 * The items of a page's text that a match from `offset` spanning `length`
 * characters touches, given each item's length in order (the page's text is
 * the items joined). Returns item indexes.
 */
export function itemsInRange(itemLengths: readonly number[], offset: number, length: number): number[] {
    const hit: number[] = [];
    let start = 0;
    itemLengths.forEach((itemLength, index) => {
        const end = start + itemLength;
        if (itemLength > 0 && end > offset && start < offset + length) {
            hit.push(index);
        }
        start = end;
    });
    return hit;
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The decoded size of a base64 `data:` URL's payload. */
export function dataUrlBytes(url: string): number {
    const comma = url.indexOf(',');
    const payload = comma >= 0 ? url.slice(comma + 1) : '';
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}
