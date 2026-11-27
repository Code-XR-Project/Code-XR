/**
 * The question asked when a window with unsaved editors is closed (#14), as
 * plain data so the wording and the button order are unit-tested without
 * Electron. Buttons follow the platform convention used by VS Code.
 */
export type ClosePromptChoice = 'save' | 'discard' | 'cancel';

export interface ClosePrompt {
    readonly options: {
        readonly type: 'warning';
        readonly title: string;
        readonly message: string;
        readonly detail: string;
        readonly buttons: string[];
        readonly defaultId: number;
        readonly cancelId: number;
        readonly noLink: true;
    };
    /** The choice for each button index. */
    readonly choices: readonly ClosePromptChoice[];
}

export function closePrompt(unsavedCount: number): ClosePrompt {
    const what = unsavedCount === 1 ? 'the changes to 1 file' : `the changes to ${unsavedCount} files`;
    return {
        options: {
            type: 'warning',
            title: 'Unsaved changes',
            message: `Do you want to save ${what} before closing?`,
            detail: "Your changes will be lost if you don't save them.",
            buttons: ['Save All', "Don't Save", 'Cancel'],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
        },
        choices: ['save', 'discard', 'cancel'],
    };
}
