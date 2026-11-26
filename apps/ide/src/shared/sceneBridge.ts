/**
 * The contract between an analysis page in the scene view and the IDE (#16):
 * the page may ask for one thing, to open a file of the analysed project in
 * the editor, optionally at a line. Shared by the scene preload, the main
 * process and the tests; pure.
 */
export const SCENE_OPEN_IN_EDITOR_CHANNEL = 'codexr:scene:open-in-editor';

export interface SceneEditorTarget {
    /** Relative to the analysed folder, or absolute (a LivePanel row carries the absolute path). */
    readonly path: string;
    /** 1-based. */
    readonly line?: number | undefined;
}

const MAX_PATH_LENGTH = 4096;

/** The target if `value` is a well-formed request, else null. */
export function toSceneEditorTarget(value: unknown): SceneEditorTarget | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const { path, line } = value as { path?: unknown; line?: unknown };
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes('\0')) {
        return null;
    }
    const lineNumber = typeof line === 'number' && Number.isInteger(line) && line > 0 && line < 10_000_000 ? line : undefined;
    return lineNumber === undefined ? { path } : { path, line: lineNumber };
}
