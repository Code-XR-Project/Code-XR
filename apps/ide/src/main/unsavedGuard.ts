import { BrowserWindow, dialog, type WebContents } from 'electron';
import { IPC_EVENTS } from '../shared/api.ts';
import { closePrompt, type ClosePromptChoice } from './closePrompt.ts';
import { log } from './log.ts';

/**
 * Closing a window with unsaved editors asks first (#14). The renderer owns
 * the editors and reports how many files are dirty; the main process owns the
 * window and its `close` event. "Save All" asks the renderer to save, then
 * closes only if its next report says nothing is left unsaved.
 */
const unsaved = new Map<number, number>();
const closeAfterSave = new Set<number>();
const closeAllowed = new Set<number>();

export function reportUnsaved(contents: WebContents, count: unknown): void {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
        throw new Error('reportUnsaved expects a non-negative integer.');
    }
    unsaved.set(contents.id, count);
    const win = BrowserWindow.fromWebContents(contents);
    win?.setDocumentEdited(count > 0); // the macOS close-button dot
    if (closeAfterSave.delete(contents.id) && win && count === 0) {
        closeWithoutAsking(win);
    }
}

/** How many unsaved editors the window last reported. */
export function unsavedCount(contents: WebContents): number {
    return unsaved.get(contents.id) ?? 0;
}

export function guardWindowClose(win: BrowserWindow): void {
    const id = win.webContents.id;
    win.on('close', (event) => {
        const count = unsaved.get(id) ?? 0;
        if (closeAllowed.has(id) || count === 0) {
            return;
        }
        event.preventDefault();
        const prompt = closePrompt(count);
        dialog.showMessageBox(win, prompt.options).then(({ response }) => {
            handleChoice(win, prompt.choices[response] ?? 'cancel');
        }).catch((error: unknown) => log.error('Close prompt failed.', error));
    });
    win.webContents.once('destroyed', () => {
        unsaved.delete(id);
        closeAfterSave.delete(id);
        closeAllowed.delete(id);
    });
}

function handleChoice(win: BrowserWindow, choice: ClosePromptChoice): void {
    if (choice === 'discard') {
        closeWithoutAsking(win);
    } else if (choice === 'save') {
        closeAfterSave.add(win.webContents.id);
        win.webContents.send(IPC_EVENTS.command, 'file.saveAll');
    }
}

function closeWithoutAsking(win: BrowserWindow): void {
    closeAllowed.add(win.webContents.id);
    win.close();
}
