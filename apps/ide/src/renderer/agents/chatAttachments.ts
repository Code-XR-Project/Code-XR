import type { ChatAttachment } from '../../shared/agents.ts';
import { el, icon } from '../dom.ts';

/**
 * The composer's attachments (A6): chips above the message box, filled by
 * typing `@` (project files, plus `@selection` for the editor's selection) or
 * by the paperclip button. Only paths travel to the main process, which reads
 * and checks the files itself.
 */

export interface AttachmentSources {
    /** Quick open's file list: git-ignored files are already left out. */
    listFiles(): Promise<readonly string[]>;
    /** The selection in the active editor, if any. */
    activeSelection(): ChatAttachment | null;
    onStatus(message: string): void;
}

export interface AttachmentBar {
    readonly chips: HTMLElement;
    readonly popup: HTMLElement;
    readonly attachButton: HTMLButtonElement;
    items(): readonly ChatAttachment[];
    clear(): void;
    /** Puts back an attachment of a message that failed to send. */
    restore(item: ChatAttachment): void;
    /** Wires `@` autocomplete into the message box; returns true when it handled a key. */
    handleKey(event: KeyboardEvent): boolean;
}

const MAX_SUGGESTIONS = 8;
const SELECTION = '@selection';
const PAPERCLIP = 'M8 12l6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l7-7';

export function labelOf(item: ChatAttachment): string {
    return item.kind === 'file' ? item.path : `${item.path}:${item.startLine}-${item.endLine}`;
}

export function createAttachmentBar(input: HTMLTextAreaElement, sources: AttachmentSources): AttachmentBar {
    let items: ChatAttachment[] = [];
    let files: readonly string[] | null = null;
    let suggestions: string[] = [];
    let selected = 0;
    let warned = false;

    const chips = el('div', { className: 'chat-chips', attrs: { 'aria-label': 'Attached', 'data-testid': 'agents-chips' } });
    const popup = el('ul', { className: 'chat-mention', attrs: { role: 'listbox', id: 'chat-mention', hidden: '', 'aria-label': 'Attach a file' } });
    input.setAttribute('aria-controls', 'chat-mention');
    input.setAttribute('aria-autocomplete', 'list');

    const renderChips = (): void => {
        chips.hidden = items.length === 0;
        chips.replaceChildren(...items.map((item, index) => {
            const remove = el('button', { className: 'chat-chip-remove', text: '×', attrs: { type: 'button', 'aria-label': `Remove ${labelOf(item)}` } });
            remove.addEventListener('click', () => {
                items = items.filter((_, other) => other !== index);
                renderChips();
                input.focus();
            });
            return el('span', { className: 'chat-chip', attrs: { title: labelOf(item) } }, [el('span', { className: 'chat-chip-label', text: labelOf(item) }), remove]);
        }));
    };
    const add = (item: ChatAttachment): void => {
        if (!items.some((existing) => labelOf(existing) === labelOf(item))) {
            items = [...items, item];
            renderChips();
        }
    };
    const addSelection = (): void => {
        const selection = sources.activeSelection();
        if (selection) {
            add(selection);
        } else {
            sources.onStatus('Select some code in the editor first.');
        }
    };

    /** The `@word` right before the cursor, if any. */
    const mentionAt = (): { start: number; query: string } | null => {
        const before = input.value.slice(0, input.selectionStart);
        const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
        return match ? { start: before.length - (match[1] ?? '').length - 1, query: match[1] ?? '' } : null;
    };
    const close = (): void => {
        popup.hidden = true;
        suggestions = [];
        input.removeAttribute('aria-activedescendant');
    };
    const renderPopup = (): void => {
        popup.replaceChildren(...suggestions.map((value, index) => {
            const row = el('li', { className: 'chat-mention-row', text: value === SELECTION ? '@selection (the editor selection)' : value, attrs: { role: 'option', id: `chat-mention-${index}`, 'aria-selected': String(index === selected) } });
            row.addEventListener('mousedown', (event) => {
                event.preventDefault();
                pick(index);
            });
            return row;
        }));
        popup.hidden = suggestions.length === 0;
        if (!popup.hidden) {
            input.setAttribute('aria-activedescendant', `chat-mention-${selected}`);
        }
    };
    const update = async (): Promise<void> => {
        const mention = mentionAt();
        if (!mention) {
            close();
            return;
        }
        if (files === null) {
            try {
                files = await sources.listFiles();
            } catch {
                // No folder open: only @selection can be offered; try again next time.
                if (!warned) {
                    warned = true;
                    sources.onStatus('Open a folder to attach its files.');
                }
            }
        }
        const query = mention.query.toLowerCase();
        const matches = (files ?? []).filter((file) => file.toLowerCase().includes(query))
            .sort((a, b) => Number(!a.toLowerCase().split('/').pop()?.startsWith(query)) - Number(!b.toLowerCase().split('/').pop()?.startsWith(query)) || a.length - b.length);
        suggestions = [...(SELECTION.slice(1).startsWith(query) ? [SELECTION] : []), ...matches].slice(0, MAX_SUGGESTIONS);
        selected = 0;
        renderPopup();
    };
    const pick = (index: number): void => {
        const value = suggestions[index];
        const mention = mentionAt();
        if (!value || !mention) {
            close();
            return;
        }
        const end = input.selectionStart;
        input.value = `${input.value.slice(0, mention.start)}${input.value.slice(end)}`;
        input.setSelectionRange(mention.start, mention.start);
        if (value === SELECTION) {
            addSelection();
        } else {
            add({ kind: 'file', path: value });
        }
        close();
        input.focus();
    };

    input.addEventListener('input', () => void update());
    input.addEventListener('blur', close);

    const attachButton = el('button', { className: 'icon-button', attrs: { type: 'button', title: 'Attach a file or the selection (@)', 'aria-label': 'Attach a file or the selection' } }, [icon(PAPERCLIP)]);
    attachButton.addEventListener('click', () => {
        if (sources.activeSelection()) {
            addSelection();
            return;
        }
        const at = input.selectionStart;
        const spacer = at > 0 && !/\s$/.test(input.value.slice(0, at)) ? ' ' : '';
        input.setRangeText(`${spacer}@`, at, input.selectionEnd, 'end');
        input.focus();
        void update();
    });

    renderChips();
    return {
        chips,
        popup,
        attachButton,
        items: () => items,
        restore: add,
        clear: () => {
            items = [];
            files = null;
            renderChips();
        },
        handleKey(event) {
            if (popup.hidden) {
                return false;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
                renderPopup();
            } else if (event.key === 'Enter' || event.key === 'Tab') {
                pick(selected);
            } else if (event.key === 'Escape') {
                close();
            } else {
                return false;
            }
            event.preventDefault();
            event.stopPropagation();
            return true;
        },
    };
}
