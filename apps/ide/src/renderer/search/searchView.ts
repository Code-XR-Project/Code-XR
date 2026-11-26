import type { CodeXRApi, SearchDoneEvent, SearchFileEvent, SearchMatch, SearchQuery } from '../../shared/api.ts';
import { compileQuery, replaceInText } from '../../shared/searchText.ts';
import { el, fileIcon, icon } from '../dom.ts';
import { searchSummary } from './searchModel.ts';

/**
 * The Search view (#165): find text in every file of the workspace and
 * replace it. The main process walks and reads the files and streams the
 * files with matches; this view lists them grouped by file, with the line
 * around each match. Replace All edits open files in their editors (one
 * undoable edit, the tab becomes unsaved) and the others on disk.
 */

export interface SearchView {
    /** Shows the view's query field, filled with `text` when given. */
    focus(text?: string): void;
    /** Another folder opened: forget the results. */
    reset(): void;
}

export interface SearchViewHooks {
    openMatch(path: string, match: SearchMatch): void;
    /** Open editors: replace there and report the paths handled. */
    replaceInOpenFiles(paths: readonly string[], replace: (text: string) => { text: string; count: number }): { handled: string[]; replacements: number };
    confirm(message: string): boolean;
    onStatus(message: string): void;
}

const ICONS = {
    chevron: 'M9 6l6 6-6 6',
    caseSensitive: 'M3 18L7.5 6 12 18M4.7 14h5.6M15 13.5a3 3 0 1 1 6 0V18m0-4.5a3 3 0 1 0-6 1.5',
    wholeWord: 'M3 17V7M21 17V7M6 15l2-6 2 6 2-6 2 6M16 15l2-6',
    regex: 'M16 4v8M12.5 6l7 4M12.5 10l7-4M6 18h.01M5 18a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
    replaceAll: 'M4 7h11M4 7l3-3M4 7l3 3M20 17H9M20 17l-3-3M20 17l-3 3',
    clear: 'M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    collapse: 'M8 8l4 4 4-4M8 14l4 4 4-4',
};

const DEBOUNCE_MS = 300;

export function createSearchView(container: HTMLElement, api: CodeXRApi['workspace'], hooks: SearchViewHooks): SearchView {
    const toggle = (label: string, path: string, testId: string): HTMLButtonElement => {
        const button = el('button', { className: 'icon-button search-toggle', attrs: { type: 'button', title: label, 'aria-label': label, 'aria-pressed': 'false', 'data-testid': testId } }, [icon(path)]);
        button.addEventListener('click', () => {
            button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
            runSoon(0);
        });
        return button;
    };
    const iconButton = (label: string, path: string, testId: string, run: () => void): HTMLButtonElement => {
        const button = el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(path)]);
        button.addEventListener('click', run);
        return button;
    };

    const queryField = el('input', { className: 'search-input', attrs: { type: 'text', placeholder: 'Search', 'aria-label': 'Search', spellcheck: 'false', 'data-testid': 'search-query' } });
    const matchCase = toggle('Match Case', ICONS.caseSensitive, 'search-match-case');
    const wholeWord = toggle('Match Whole Word', ICONS.wholeWord, 'search-whole-word');
    const isRegex = toggle('Use Regular Expression', ICONS.regex, 'search-regex');
    const replaceField = el('input', { className: 'search-input', attrs: { type: 'text', placeholder: 'Replace', 'aria-label': 'Replace', spellcheck: 'false', 'data-testid': 'search-replace' } });
    const replaceAll = iconButton('Replace All', ICONS.replaceAll, 'search-replace-all', () => void runReplaceAll());
    const includeField = el('input', { className: 'search-input', attrs: { type: 'text', placeholder: 'e.g. src, *.ts', 'aria-label': 'Files to include', spellcheck: 'false', 'data-testid': 'search-include' } });
    const excludeField = el('input', { className: 'search-input', attrs: { type: 'text', placeholder: 'e.g. *.test.ts, docs', 'aria-label': 'Files to exclude', spellcheck: 'false', 'data-testid': 'search-exclude' } });
    const replaceToggle = el('button', { className: 'icon-button search-replace-toggle', attrs: { type: 'button', title: 'Toggle Replace', 'aria-label': 'Toggle Replace', 'aria-expanded': 'false' } }, [icon(ICONS.chevron)]);
    const replaceRow = el('div', { className: 'search-row' }, [replaceField, replaceAll]);
    replaceRow.hidden = true;
    replaceToggle.addEventListener('click', () => {
        replaceRow.hidden = !replaceRow.hidden;
        replaceToggle.setAttribute('aria-expanded', String(!replaceRow.hidden));
        renderResults();
    });

    const summary = el('p', { className: 'search-summary muted', attrs: { 'aria-live': 'polite', 'data-testid': 'search-summary' } });
    const results = el('div', { className: 'search-results', attrs: { role: 'tree', 'aria-label': 'Search results', 'data-testid': 'search-results' } });
    const header = el('div', { className: 'side-bar-header' }, [
        el('h2', { className: 'side-bar-title', text: 'Search' }),
        el('div', { className: 'side-bar-actions' }, [
            iconButton('Collapse All', ICONS.collapse, 'search-collapse', () => { for (const file of files.values()) { file.collapsed = true; } renderResults(); }),
            iconButton('Clear Search Results', ICONS.clear, 'search-clear', () => clear()),
        ]),
    ]);
    container.replaceChildren(header, el('div', { className: 'search-form' }, [
        el('div', { className: 'search-query-block' }, [
            replaceToggle,
            el('div', { className: 'search-fields' }, [
                el('div', { className: 'search-row' }, [queryField, el('span', { className: 'search-toggles' }, [matchCase, wholeWord, isRegex])]),
                replaceRow,
            ]),
        ]),
        el('label', { className: 'search-label small muted', text: 'files to include' }, [includeField]),
        el('label', { className: 'search-label small muted', text: 'files to exclude' }, [excludeField]),
    ]), summary, results);

    interface FileState { readonly path: string; readonly matches: readonly SearchMatch[]; readonly total: number; collapsed: boolean }
    const files = new Map<string, FileState>();
    let searchId = 0;
    let lastQuery: SearchQuery | null = null;
    let done: SearchDoneEvent | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let renderQueued = false;

    function query(): SearchQuery {
        return {
            pattern: queryField.value,
            isRegex: isRegex.getAttribute('aria-pressed') === 'true',
            matchCase: matchCase.getAttribute('aria-pressed') === 'true',
            wholeWord: wholeWord.getAttribute('aria-pressed') === 'true',
            include: includeField.value,
            exclude: excludeField.value,
        };
    }

    function runSoon(delay = DEBOUNCE_MS): void {
        clearTimeout(timer);
        timer = setTimeout(run, delay);
    }

    function run(): void {
        clearTimeout(timer);
        const current = query();
        searchId++;
        files.clear();
        done = null;
        if (current.pattern === '') {
            lastQuery = null;
            void api.cancelSearch(searchId - 1).catch(() => undefined);
            renderResults();
            return;
        }
        lastQuery = current;
        renderResults();
        api.search(searchId, current).catch((error: unknown) => {
            done = { searchId, files: 0, matches: 0, limitHit: false, cancelled: false, error: String(error) };
            renderResults();
        });
    }

    function clear(): void {
        queryField.value = '';
        replaceField.value = '';
        run();
        queryField.focus();
    }

    for (const field of [queryField, includeField, excludeField]) {
        field.addEventListener('input', () => runSoon());
        field.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                run();
            }
        });
    }
    replaceField.addEventListener('input', () => scheduleRender());
    replaceField.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void runReplaceAll();
        }
    });

    api.onSearchResult((event: SearchFileEvent) => {
        if (event.searchId !== searchId) {
            return;
        }
        files.set(event.path, { path: event.path, matches: event.matches, total: event.total, collapsed: false });
        scheduleRender();
    });
    api.onSearchDone((event: SearchDoneEvent) => {
        if (event.searchId !== searchId) {
            return;
        }
        done = event;
        scheduleRender();
    });

    function scheduleRender(): void {
        if (renderQueued) {
            return;
        }
        renderQueued = true;
        requestAnimationFrame(() => {
            renderQueued = false;
            renderResults();
        });
    }

    function matchCount(): number {
        let count = 0;
        for (const file of files.values()) { count += file.total; }
        return count;
    }

    function renderResults(): void {
        summary.textContent = searchSummary({
            hasQuery: lastQuery !== null,
            files: files.size,
            matches: matchCount(),
            done: done !== null,
            limitHit: done?.limitHit ?? false,
            error: done?.error ?? null,
        });
        replaceAll.disabled = files.size === 0;
        const replacement = replaceRow.hidden ? null : replaceField.value;
        const rows: HTMLElement[] = [];
        for (const file of files.values()) {
            rows.push(fileRow(file));
            if (!file.collapsed) {
                for (const match of file.matches) {
                    rows.push(matchRow(file.path, match, replacement));
                }
                if (file.total > file.matches.length) {
                    rows.push(el('div', { className: 'search-more muted small', text: `${file.total - file.matches.length} more matches in this file` }));
                }
            }
        }
        results.replaceChildren(...rows);
    }

    function fileRow(file: FileState): HTMLElement {
        const name = file.path.slice(file.path.lastIndexOf('/') + 1);
        const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
        const row = el('div', {
            className: file.collapsed ? 'search-file is-collapsed' : 'search-file',
            attrs: { role: 'treeitem', 'aria-expanded': String(!file.collapsed), tabindex: '0', title: file.path, 'data-path': file.path },
        }, [
            icon(ICONS.chevron, 'search-chevron'),
            fileIcon(name, 'file'),
            el('span', { className: 'search-file-name', text: name }),
            el('span', { className: 'search-file-folder muted', text: folder }),
            el('span', { className: 'search-count', text: String(file.total) }),
        ]);
        const flip = (): void => {
            file.collapsed = !file.collapsed;
            renderResults();
        };
        row.addEventListener('click', flip);
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); } });
        return row;
    }

    function matchRow(path: string, match: SearchMatch, replacement: string | null): HTMLElement {
        const before = match.preview.slice(0, match.previewStart);
        const found = match.preview.slice(match.previewStart, match.previewStart + match.length);
        const after = match.preview.slice(match.previewStart + match.length);
        const parts: Node[] = [document.createTextNode(before.trimStart())];
        if (replacement === null) {
            parts.push(el('mark', { text: found }));
        } else {
            parts.push(el('del', { text: found }), el('ins', { text: previewReplacement(found, replacement) }));
        }
        parts.push(document.createTextNode(after));
        const row = el('div', {
            className: 'search-match',
            attrs: { role: 'treeitem', tabindex: '0', title: `Line ${match.line}, column ${match.column}`, 'data-line': String(match.line) },
        }, [el('span', { className: 'search-line-number muted', text: String(match.line) }), el('span', { className: 'search-preview' }, parts)]);
        const open = (): void => hooks.openMatch(path, match);
        row.addEventListener('click', open);
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); open(); } });
        return row;
    }

    /** What a match becomes; for a regular expression, applied to the matched text alone (a preview). */
    function previewReplacement(found: string, replacement: string): string {
        if (!lastQuery?.isRegex) {
            return replacement;
        }
        const compiled = compileQuery(lastQuery);
        return 'error' in compiled ? replacement : replaceInText(found, compiled.regex, replacement, true).text;
    }

    async function runReplaceAll(): Promise<void> {
        const current = lastQuery;
        if (!current || files.size === 0) {
            return;
        }
        const replacement = replaceField.value;
        const count = matchCount();
        const paths = [...files.keys()];
        const noun = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
        if (!hooks.confirm(`Replace ${noun(count, 'occurrence')} across ${noun(paths.length, 'file')} with "${replacement}"?\n\nOpen files are changed in their editors (save them afterwards); the others are written to disk.`)) {
            return;
        }
        const compiled = compileQuery(current);
        if ('error' in compiled) {
            hooks.onStatus(compiled.error);
            return;
        }
        const inEditors = hooks.replaceInOpenFiles(paths, (text) => replaceInText(text, compiled.regex, replacement, current.isRegex));
        const handled = new Set(inEditors.handled);
        const onDisk = paths.filter((path) => !handled.has(path));
        let message: string;
        try {
            const result = onDisk.length > 0 ? await api.replaceInFiles(current, replacement, onDisk) : { files: 0, replacements: 0, failed: [] };
            const total = result.replacements + inEditors.replacements;
            message = `Replaced ${noun(total, 'occurrence')} in ${noun(result.files + inEditors.handled.length, 'file')}.`;
            if (result.failed.length > 0) {
                message += ` Not replaced in ${result.failed.map((failure) => `${failure.path} (${failure.message})`).join(', ')}.`;
            }
        } catch (error) {
            message = `Replace failed: ${String(error)}`;
        }
        hooks.onStatus(message);
        run();
    }

    renderResults();
    return {
        focus(text) {
            if (text) {
                queryField.value = text;
                run();
            }
            queryField.focus();
            queryField.select();
        },
        reset() {
            clearTimeout(timer);
            searchId++;
            files.clear();
            done = null;
            lastQuery = null;
            queryField.value = '';
            renderResults();
        },
    };
}
