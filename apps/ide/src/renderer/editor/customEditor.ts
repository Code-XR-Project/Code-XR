/**
 * #256: custom editor tabs. A custom tab sits in a group's tab strip like a
 * file tab (preview, keep, close, drag to the other group, split, session
 * restore) but shows a DOM element of its own instead of a Monaco editor.
 * The PDF and image viewers are custom tabs over a file; the agent-first
 * layout opens its chats through the same seam.
 *
 * A tab's id is its key everywhere a file tab uses its path: a file viewer's
 * id is the file's workspace path, any other id carries a prefix of its own
 * (`chat:<session>`), so it never collides with a file. Each tab gets its own
 * view: a document open in both groups is two views over the same input.
 */

/** What a view can ask of the tab that holds it. */
export interface CustomEditorContext {
    /** The tab's id. */
    readonly id: string;
    /** Renames the tab (a chat that got its title). */
    setTitle(title: string): void;
    /** Shows the tab's dot. It is only a mark: Save does not reach a custom tab, so `canClose` must ask on its own. */
    setDirty(dirty: boolean): void;
    /** Closes this tab (after `canClose`). */
    close(): void;
    /** A one-line message for the status bar. */
    status(message: string): void;
}

/** One tab's view of a custom input. */
export interface CustomEditorView {
    /** Placed in the group while its tab is active, removed (not destroyed) while another tab is. */
    readonly element: HTMLElement;
    /** The tab became the visible one of its group (after the element is in the document). */
    onShow?(): void;
    /** Another tab of the group became visible (before the element leaves the document). */
    onHide?(): void;
    /** Takes the keyboard focus when the tab is activated by the person. */
    focus?(): void;
    /** False keeps the tab open; asked once per close, never for a close the workspace forces. */
    canClose?(): boolean;
    /** A file viewer's file changed on disk, or is gone. */
    fileChanged?(state: 'changed' | 'deleted'): void;
    /** The tab closed for good. */
    dispose?(): void;
}

/** What `openCustom` takes, and what a resolver hands back for a saved id. */
export interface CustomEditorInput {
    readonly id: string;
    readonly title: string;
    /** The file name whose icon the tab shows (the title when absent). */
    readonly iconName?: string;
    /** Set for a viewer of a workspace file (the id is then that path): the tab follows the file on disk and is watched. */
    readonly filePath?: string;
    create(context: CustomEditorContext): CustomEditorView;
}

/** Turns an id (a saved tab, a file being opened) into an input, or null when it is not this resolver's. */
export type CustomEditorResolver = (id: string) => CustomEditorInput | null;
