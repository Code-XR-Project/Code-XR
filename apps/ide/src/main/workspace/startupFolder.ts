/**
 * Which folder a new IDE launch opens (#151): the `--folder` argument when
 * there is one, otherwise the folder worked on last (the head of the recent
 * list, #14), so the project and its XR scene (#139) come back on their own.
 * The smoke run never reopens anything: it must not depend on, or touch,
 * what a person did before.
 */
export type StartupFolder =
    | { readonly kind: 'argument'; readonly folder: string }
    | { readonly kind: 'last'; readonly folder: string }
    | { readonly kind: 'none' };

export function chooseStartupFolder(argument: string | null | undefined, recent: readonly string[], isSmoke: boolean): StartupFolder {
    if (argument) {
        return { kind: 'argument', folder: argument };
    }
    const last = recent[0];
    if (!isSmoke && last) {
        return { kind: 'last', folder: last };
    }
    return { kind: 'none' };
}
