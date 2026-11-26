/**
 * Closing the editor panels that show a server, as seen from the core (#13, step 7).
 *
 * `ServerControl` closes a lateral panel when its server stops. The panels
 * themselves are editor UI (the extension: `platform/webview/panelManager.ts`),
 * so the core only knows this callback, which the application registers at
 * start-up from `extension.ts`. A host with no panels (the IDE for now, the
 * unit tests) registers nothing, and closing is then a no-op: there is no
 * panel to leave behind.
 */
export interface ServerPanelCloser {
    /** Closes the panels of these servers; returns how many were closed. */
    closeServerPanels(serverIds: readonly string[]): number;
}

let current: ServerPanelCloser | null = null;

/** Registers the panel closer. Called once at start-up; a later call replaces it (tests). */
export function setServerPanelCloser(closer: ServerPanelCloser | null): void {
    current = closer;
}

/** Closes the panels of these servers through the registered closer; 0 when none is registered. */
export function closeServerPanels(serverIds: readonly string[]): number {
    return current ? current.closeServerPanels(serverIds) : 0;
}
