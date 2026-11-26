/** Vite's `?worker` imports (Monaco's workers, #14): the default export constructs the bundled worker. */
declare module '*?worker' {
    const WorkerConstructor: new () => Worker;
    export default WorkerConstructor;
}
