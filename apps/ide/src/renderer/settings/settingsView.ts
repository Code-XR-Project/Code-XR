import type { CodeXRApi, SettingsReport } from '../../shared/api.ts';
import { resolveSettings, type SettingDefinition, type SettingScope, type SettingValue } from '../../shared/settings.ts';
import { el, icon } from '../dom.ts';
import { parseControlValue, settingRows, type SettingRow } from './settingsModel.ts';

/**
 * The Settings view (#18, part 2), a side-bar pane like VS Code's settings
 * editor in miniature: a filter, User / Folder tabs, one row per setting with
 * its control, a mark on what this scope sets itself and a reset. Changes go
 * to the main process, which validates and stores them; the view redraws
 * from what it sends back. Built with DOM APIs only.
 */

const RESET = 'M4 12a8 8 0 1 0 3-6.2M4 4v5h5';

export interface SettingsView {
    /** Shows a new snapshot (from the main process). */
    show(report: SettingsReport): void;
    focus(): void;
}

export interface SettingsViewHooks {
    onError(message: string): void;
    /** Opens `.codexr/settings.json` in the editor. */
    openFolderFile(): void;
    /** Opens the Keyboard Shortcuts view (#18, part 3). */
    openKeybindings(): void;
}

export function createSettingsView(container: HTMLElement, api: CodeXRApi['settings'], hooks: SettingsViewHooks): SettingsView {
    let report: SettingsReport = { ...resolveSettings({}, null), errors: [] };
    let scope: SettingScope = 'user';
    let filter = '';

    const search = el('input', {
        className: 'search-input settings-filter',
        attrs: { type: 'search', placeholder: 'Search settings', 'aria-label': 'Search settings', 'data-testid': 'settings-filter', spellcheck: 'false' },
    });
    const scopeButton = (id: SettingScope, label: string): HTMLButtonElement => {
        const button = el('button', { className: 'settings-scope', text: label, attrs: { type: 'button', role: 'tab', 'data-scope': id, 'data-testid': `settings-scope-${id}` } });
        button.addEventListener('click', () => {
            scope = id;
            render();
        });
        return button;
    };
    const userTab = scopeButton('user', 'User');
    const folderTab = scopeButton('folder', 'Folder');
    const openFile = el('button', { className: 'link-button settings-open-file', text: 'Edit .codexr/settings.json', attrs: { type: 'button', 'data-testid': 'settings-open-file' } });
    openFile.addEventListener('click', () => hooks.openFolderFile());
    const keybindings = el('button', { className: 'link-button', text: 'Keyboard Shortcuts', attrs: { type: 'button', 'data-testid': 'settings-open-keybindings' } });
    keybindings.addEventListener('click', () => hooks.openKeybindings());
    const errors = el('div', { className: 'settings-errors', attrs: { role: 'status' } });
    const list = el('div', { className: 'settings-list', attrs: { 'data-testid': 'settings-list' } });
    const scopeNote = el('p', { className: 'muted small settings-scope-note' });

    container.replaceChildren(
        el('h2', { className: 'side-bar-title', text: 'Settings' }),
        el('div', { className: 'settings-head' }, [
            search,
            el('div', { className: 'settings-scopes', attrs: { role: 'tablist', 'aria-label': 'Settings scope' } }, [userTab, folderTab]),
            scopeNote,
            openFile,
            keybindings,
        ]),
        errors,
        list,
    );
    search.addEventListener('input', () => {
        filter = search.value;
        render();
    });

    function update(setting: SettingDefinition, value: SettingValue | null): void {
        api.update(scope, setting.key, value).then(show, (error: unknown) => {
            hooks.onError(`Could not change ${setting.title}: ${String(error).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')}`);
            render();
        });
    }

    function control(row: SettingRow): HTMLElement {
        const { setting } = row;
        const id = `setting-${setting.key.replace(/[^a-zA-Z0-9]/g, '-')}`;
        switch (setting.type) {
            case 'boolean': {
                const box = el('input', { attrs: { type: 'checkbox', id, 'data-key': setting.key } });
                box.checked = row.value === true;
                box.addEventListener('change', () => update(setting, box.checked));
                return box;
            }
            case 'enum': {
                const select = el('select', { className: 'settings-select', attrs: { id, 'data-key': setting.key } },
                    setting.options.map((option, index) => el('option', { text: setting.optionLabels?.[index] ?? option, attrs: { value: option } })));
                select.value = String(row.value);
                select.addEventListener('change', () => update(setting, select.value));
                return select;
            }
            case 'number':
            case 'string': {
                const input = el('input', {
                    className: 'settings-input',
                    attrs: {
                        id,
                        'data-key': setting.key,
                        type: setting.type === 'number' ? 'number' : 'text',
                        spellcheck: 'false',
                        ...(setting.type === 'number' ? { min: String(setting.min), max: String(setting.max), step: setting.integer ? '1' : 'any' } : {}),
                    },
                });
                input.value = String(row.value);
                const commit = (): void => {
                    const value = parseControlValue(setting, input.value);
                    if (value === null) {
                        input.setAttribute('aria-invalid', 'true');
                        input.title = setting.type === 'number' ? `A number from ${setting.min} to ${setting.max}.` : 'Too long.';
                        return;
                    }
                    input.removeAttribute('aria-invalid');
                    input.title = '';
                    if (value !== row.value || !row.modified) {
                        update(setting, value);
                    }
                };
                input.addEventListener('change', commit);
                input.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') { commit(); }
                });
                return input;
            }
        }
    }

    function renderRow(row: SettingRow): HTMLElement {
        const { setting } = row;
        const id = `setting-${setting.key.replace(/[^a-zA-Z0-9]/g, '-')}`;
        const reset = el('button', { className: 'icon-button settings-reset', attrs: { type: 'button', title: 'Reset this setting', 'aria-label': `Reset ${setting.title}` } }, [icon(RESET)]);
        reset.hidden = !row.modified;
        reset.addEventListener('click', () => update(setting, null));
        const title = el('label', { className: 'settings-title', attrs: { for: id } }, [
            el('span', { className: 'settings-category', text: `${setting.category}: ` }),
            document.createTextNode(setting.title),
        ]);
        return el('div', { className: row.modified ? 'settings-row is-modified' : 'settings-row', attrs: { 'data-key': setting.key, 'data-testid': 'settings-row' } }, [
            el('div', { className: 'settings-row-head' }, [title, reset]),
            el('p', { className: 'settings-description muted small', text: setting.description }),
            ...(row.note ? [el('p', { className: 'settings-note small', text: row.note })] : []),
            el('div', { className: 'settings-control' }, [control(row)]),
            el('code', { className: 'settings-key muted small', text: setting.key }),
        ]);
    }

    function render(): void {
        const hasFolder = report.folder !== null;
        if (!hasFolder && scope === 'folder') {
            scope = 'user';
        }
        folderTab.disabled = !hasFolder;
        folderTab.title = hasFolder ? 'Settings of the open folder, in .codexr/settings.json' : 'Open a folder to give it its own settings';
        for (const tab of [userTab, folderTab]) {
            const selected = tab.dataset['scope'] === scope;
            tab.setAttribute('aria-selected', String(selected));
            tab.classList.toggle('is-active', selected);
        }
        scopeNote.textContent = scope === 'user'
            ? 'Yours, in every folder. A folder\'s own settings win over these.'
            : 'This folder\'s, in .codexr/settings.json: they travel with the project.';
        openFile.hidden = scope !== 'folder';
        errors.replaceChildren(...report.errors.map((message) => el('p', { className: 'settings-error small', text: message })));
        const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.id : null;
        const groups = settingRows(report, scope, filter);
        list.replaceChildren(...(groups.length === 0
            ? [el('p', { className: 'muted side-note', text: 'No setting matches.' })]
            : groups.map((group) => el('section', { className: 'settings-group' }, [
                el('h3', { className: 'side-bar-subtitle', text: group.category }),
                ...group.rows.map(renderRow),
            ]))));
        if (focused) {
            (list.querySelector(`#${CSS.escape(focused)}`) as HTMLElement | null)?.focus();
        }
    }

    function show(next: SettingsReport): void {
        report = next;
        render();
    }
    render();

    return {
        show,
        focus: () => search.focus(),
    };
}
