/**
 * #256: the DOM-free half of the custom editor seam (editor/customEditor.ts):
 * the resolver registry and the file-type helpers, which the unit tests run
 * under Node.
 */

/** The resolvers in registration order: the first one that answers wins. */
export class CustomEditorRegistry<T extends { readonly id: string }> {
    private readonly resolvers: ((id: string) => T | null)[] = [];

    /** Adds a resolver; the returned function removes it. */
    register(resolver: (id: string) => T | null): () => void {
        this.resolvers.push(resolver);
        return () => {
            const index = this.resolvers.indexOf(resolver);
            if (index >= 0) {
                this.resolvers.splice(index, 1);
            }
        };
    }

    resolve(id: string): T | null {
        for (const resolver of this.resolvers) {
            const input = resolver(id);
            if (input) {
                return input;
            }
        }
        return null;
    }
}

/** The extension of a workspace path, lower case, without the dot ('' when it has none). */
export function extensionOf(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** #256: the images the image viewer shows (the ones `workspace.readImage` serves). SVG opens as text. */
export const VIEWER_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);

/** True for an id that names another kind of tab (`chat:...`) rather than a workspace path. */
export function isSchemeId(id: string): boolean {
    return /^[a-z][a-z0-9-]*:/i.test(id);
}

/** #288: what a comparison tab compares, decoded from its id. */
export type CompareTarget =
    | { readonly kind: 'saved'; readonly path: string }
    | { readonly kind: 'files'; readonly left: string; readonly right: string };

const COMPARE_SAVED_PREFIX = 'compare-saved:';
const COMPARE_FILES_PREFIX = 'compare:';

/** The id of "Compare with Saved" on `path`. */
export function compareSavedId(path: string): string {
    return `${COMPARE_SAVED_PREFIX}${path}`;
}

/** The id of a comparison of two files (left is the original). Each path is encoded, so a `|` in a name cannot split it. */
export function compareFilesId(left: string, right: string): string {
    return `${COMPARE_FILES_PREFIX}${encodeURIComponent(left)}|${encodeURIComponent(right)}`;
}

export function parseCompareId(id: string): CompareTarget | null {
    if (id.startsWith(COMPARE_SAVED_PREFIX)) {
        const path = id.slice(COMPARE_SAVED_PREFIX.length);
        return path ? { kind: 'saved', path } : null;
    }
    if (id.startsWith(COMPARE_FILES_PREFIX)) {
        const parts = id.slice(COMPARE_FILES_PREFIX.length).split('|');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
            return null;
        }
        try {
            return { kind: 'files', left: decodeURIComponent(parts[0]), right: decodeURIComponent(parts[1]) };
        } catch {
            return null;
        }
    }
    return null;
}
