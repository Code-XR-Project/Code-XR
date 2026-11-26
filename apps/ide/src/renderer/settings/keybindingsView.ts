import type { CodeXRApi, KeybindingsReport } from '../../shared/api.ts';
import { withCommandKey, withCommandReset, type UserKeybinding } from '../../shared/keybindings.ts';
import { strokeFromEvent, type KeyPlatform } from '../commands/keybindings.ts';
import { el, icon } from '../dom.ts';
import { conflictsOf, createKeyRecorder, keybindingRows, type KeybindingRow, type KeybindingSource } from './keybindingsModel.ts';

/**
 * The Keyboard Shortcuts view (#18, part 3), a side-bar pane beside Settings:
 * a filter and one row per command with its keys. Change records a new key
 * (one stroke, or two for a chord) and says which command it would take the
 * key from; Remove leaves the command without a key; Reset brings back the
 * built-in ones. Every change rewrites the user's rules through the main
 * process, which stores them in `keybindings.json`; the view redraws from
 * what comes back. Built with DOM APIs only.
 *
 * While a key is being recorded, the application menu's keys are suspended
 * (`onRecording`), or pressing Ctrl+S to bind it would also save; the
 * workbench's own handler skips the recorder (`data-keybinding-recorder`).
 */

const RESET = 'M4 12a8 8 0 1 0 3-6.2M4 4v5h5';
const EDIT = 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4';
const REMOVE = 'M6 6l12 12M18 6L6 18';

export interface KeybindingsView {
    show(report: KeybindingsReport): void;
    /** Redraws from the registry (a command came or went, or the rules changed). */
    refresh(): void;
    focus(): void;
}

export interface KeybindingsViewHooks {
    onError(message: string): void;
    /** Goes back to the Settings view. */
    openSettings(): void;
    /** A recording starts (true) or ends (false): the menu's keys are freed meanwhile. */
    onRecording(recording: boolean): void;
    formatKey(key: string): string;
}

export function createKeybindingsView(
    container: HTMLElement,
    api: CodeXRApi['keybindings'],
    source: KeybindingSource,
    platform: KeyPlatform,
    hooks: KeybindingsViewHooks,
): KeybindingsView {
    let report: KeybindingsReport = { entries: [], errors: [], file: null };
    let filter = '';
    let recordingId: string | null = null;

    const search = el('input', {
        className: 'search-input settings-filter',
        attrs: { type: 'search', placeholder: 'Search keybindings', 'aria-label': 'Search keybindings', 'data-testid': 'keybindings-filter', spellcheck: 'false' },
    });
    const back = el('button', { className: 'link-button', text: 'Settings', attrs: { type: 'button', 'data-testid': 'keybindings-back' } });
    back.addEventListener('click', () => hooks.openSettings());
    const fileNote = el('p', { className: 'muted small settings-scope-note', attrs: { 'data-testid': 'keybindings-file' } });
    const errors = el('div', { className: 'settings-errors', attrs: { role: 'status' } });
    const list = el('div', { className: 'settings-list keybindings-list', attrs: { 'data-testid': 'keybindings-list' } });

    container.replaceChildren(
        el('h2', { className: 'side-bar-title', text: 'Keyboard Shortcuts' }),
        el('div', { className: 'settings-head' }, [search, fileNote, back]),
        errors,
        list,
    );
    search.addEventListener('input', () => {
        filter = search.value;
        render();
    });

    function save(entries: UserKeybinding[], what: string): void {
        api.update(entries).then(show, (error: unknown) => {
            hooks.onError(`Could not change ${what}: ${String(error).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')}`);
            render();
        });
    }

    function stopRecording(): void {
        if (recordingId !== null) {
            recordingId = null;
            hooks.onRecording(false);
        }
    }

    function recorderRow(row: KeybindingRow): HTMLElement {
        const recorder = createKeyRecorder();
        const input = el('input', {
            className: 'settings-input keybinding-recorder',
            attrs: {
                type: 'text', readonly: '', 'data-keybinding-recorder': '', 'data-testid': 'keybinding-recorder',
                'aria-label': `New key for ${row.label}`, placeholder: 'Press the keys, then Enter',
            },
        });
        const hint = el('p', { className: 'muted small settings-description', text: 'Enter saves, Escape cancels. Press a second key for a chord.' });
        const conflict = el('p', { className: 'settings-note small', attrs: { 'data-testid': 'keybinding-conflict', role: 'status' } });
        const update = (): void => {
            const value = recorder.value();
            input.value = value === null ? '' : hooks.formatKey(value);
            const others = value === null ? [] : conflictsOf(source, row.id, value, platform);
            conflict.textContent = others.length === 0 ? '' : `Now on ${others.map((command) => (command.category ? `${command.category}: ${command.title}` : command.title)).join(', ')}, which will lose it.`;
        };
        input.addEventListener('keydown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat) {
                return;
            }
            const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
            if (plain && event.key === 'Escape') {
                stopRecording();
                render();
                return;
            }
            if (plain && event.key === 'Enter') {
                const value = recorder.value();
                if (value !== null) {
                    stopRecording();
                    save(withCommandKey(report.entries, row.id, value), row.label);
                }
                return;
            }
            const stroke = strokeFromEvent(event, platform);
            if (stroke !== null) {
                recorder.press(stroke);
                update();
            }
        });
        input.addEventListener('blur', () => {
            // Clicking elsewhere cancels, as Escape does.
            if (recordingId === row.id) {
                stopRecording();
                render();
            }
        });
        queueMicrotask(() => input.focus());
        return el('div', { className: 'settings-row is-recording', attrs: { 'data-command': row.id, 'data-testid': 'keybinding-row' } }, [
            el('div', { className: 'settings-row-head' }, [el('span', { className: 'settings-title' }, labelNodes(row))]),
            el('div', { className: 'settings-control' }, [input]),
            hint,
            conflict,
        ]);
    }

    function labelNodes(row: KeybindingRow): Node[] {
        return [
            ...(row.category ? [el('span', { className: 'settings-category', text: `${row.category}: ` })] : []),
            document.createTextNode(row.title),
        ];
    }

    function renderRow(row: KeybindingRow): HTMLElement {
        if (row.id === recordingId) {
            return recorderRow(row);
        }
        const button = (path: string, label: string, testId: string, run: () => void): HTMLButtonElement => {
            const node = el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': `${label}: ${row.label}`, 'data-testid': testId } }, [icon(path)]);
            node.addEventListener('click', run);
            return node;
        };
        const change = button(EDIT, 'Change keybinding', 'keybinding-change', () => {
            recordingId = row.id;
            hooks.onRecording(true);
            render();
        });
        const remove = button(REMOVE, 'Remove keybinding', 'keybinding-remove', () => save(withCommandKey(report.entries, row.id, null), row.label));
        remove.hidden = row.keys.length === 0;
        const reset = button(RESET, 'Reset keybinding', 'keybinding-reset', () => save(withCommandReset(report.entries, row.id, row.defaults, platform), row.label));
        reset.hidden = !row.modified;
        const keys = row.labels.length === 0
            ? [el('span', { className: 'muted small', text: 'No key' })]
            : row.labels.map((label) => el('kbd', { className: 'quick-input-key', text: label }));
        return el('div', { className: row.modified ? 'settings-row is-modified' : 'settings-row', attrs: { 'data-command': row.id, 'data-testid': 'keybinding-row' } }, [
            el('div', { className: 'settings-row-head' }, [el('span', { className: 'settings-title' }, labelNodes(row)), change, remove, reset]),
            el('div', { className: 'keybinding-keys', attrs: { 'data-testid': 'keybinding-keys' } }, keys),
            el('code', { className: 'settings-key muted small', text: row.id }),
        ]);
    }

    function render(): void {
        fileNote.textContent = report.file
            ? `Yours, in every folder. Stored in ${report.file}, which you can also edit by hand.`
            : 'Yours, in every folder.';
        errors.replaceChildren(...report.errors.map((message) => el('p', { className: 'settings-error small', text: message })));
        const rows = keybindingRows(source, filter, hooks.formatKey);
        if (recordingId !== null && !rows.some((row) => row.id === recordingId)) {
            stopRecording();
        }
        list.replaceChildren(...(rows.length === 0
            ? [el('p', { className: 'muted side-note', text: 'No command matches.' })]
            : rows.map(renderRow)));
    }

    function show(next: KeybindingsReport): void {
        report = next;
        render();
    }
    render();

    return {
        show,
        refresh: render,
        focus: () => search.focus(),
    };
}
