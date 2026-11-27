/** Vite's `?worker` imports (Monaco's workers, #14): the default export constructs the bundled worker. */
declare module '*?worker' {
    const WorkerConstructor: new () => Worker;
    export default WorkerConstructor;
}

/** Vite's `?url` imports: the default export is the URL of the bundled asset (the Code-XR logo on the welcome view). */
declare module '*?url' {
    const url: string;
    export default url;
}

/** #261: Monaco's codicon table (an internal module without types): registering it fills the map below. */
declare module 'monaco-editor/base/common/codicons.js' {
    export const Codicon: Readonly<Record<string, { readonly id: string }>>;
}

declare module 'monaco-editor/base/common/codiconsUtil.js' {
    /** Codicon id (`refresh`, `git-commit`) -> its character in the codicon font. */
    export function getCodiconFontCharacters(): Readonly<Record<string, number>>;
}
