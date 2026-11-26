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
