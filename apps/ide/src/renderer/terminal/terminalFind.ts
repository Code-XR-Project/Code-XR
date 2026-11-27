import { el, icon } from '../dom.ts';

/**
 * The terminal's find widget (#286): a small bar over the top-right corner
 * of the terminal, opened with Ctrl+F (Cmd+F on macOS) while a terminal has
 * focus. It searches the active terminal's scrollback through xterm.js's
 * search addon: Enter / Shift+Enter for the next and previous match, a
 * case-sensitive toggle, the "n of m" count, Escape to close.
 *
 * One widget serves the whole panel; switching terminal tabs moves it to
 * the new one (`setTarget`).
 */

const ICONS = {
    caseSensitive: 'M3 18L7.5 6 12 18M4.7 14h5.6M15 13.5a3 3 0 1 1 6 0V18m0-4.5a3 3 0 1 0-6 1.5',
    previous: 'M12 19V5M5 12l7-7 7 7',
    next: 'M12 5v14M5 12l7 7 7-7',
    close: 'M6 6l12 12M18 6L6 18',
} as const;

export interface TerminalFindOptions {
    readonly caseSensitive: boolean;
}

/** The most matches the search addon highlights, and so counts. */
export const FIND_HIGHLIGHT_LIMIT = 1000;

/** What the widget searches: the active terminal. */
export interface TerminalFindTarget {
    find(term: string, options: TerminalFindOptions, direction: 'next' | 'previous', incremental?: boolean): void;
    clearFind(): void;
    selection(): string;
    focus(): void;
}

export interface TerminalFind {
    readonly isOpen: boolean;
    /** Shows the widget on the target and focuses its input (the terminal's one-line selection fills it). */
    open(target: TerminalFindTarget): void;
    /** Hides it and clears the highlights; `refocus` puts the focus back in the terminal. */
    close(refocus?: boolean): void;
    /** Another terminal became active (null: none is left). */
    setTarget(target: TerminalFindTarget | null): void;
    /** The search addon's results for the target. */
    setResults(target: TerminalFindTarget, index: number, count: number): void;
}

/** "3 of 12", "No results", or "12 of 1000+" past the highlight limit. */
export function findCountText(index: number, count: number, limit: number, hasTerm: boolean): string {
    if (!hasTerm) {
        return '';
    }
    if (count === 0) {
        return 'No results';
    }
    const total = count >= limit ? `${limit}+` : String(count);
    return `${index >= 0 ? index + 1 : '?'} of ${total}`;
}

export function createTerminalFind(parent: HTMLElement): TerminalFind {
    let target: TerminalFindTarget | null = null;
    let caseSensitive = false;

    const input = el('input', {
        className: 'terminal-find-input',
        attrs: { type: 'text', placeholder: 'Find', 'aria-label': 'Find in terminal', spellcheck: 'false', 'data-testid': 'terminal-find-input' },
    });
    const button = (label: string, path: string, testId: string): HTMLButtonElement =>
        el('button', { className: 'icon-button terminal-find-button', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(path)]);
    const caseButton = button('Match Case', ICONS.caseSensitive, 'terminal-find-case');
    caseButton.setAttribute('aria-pressed', 'false');
    const count = el('span', { className: 'terminal-find-count', attrs: { 'aria-live': 'polite', 'data-testid': 'terminal-find-count' } });
    const previous = button('Previous Match (Shift+Enter)', ICONS.previous, 'terminal-find-previous');
    const next = button('Next Match (Enter)', ICONS.next, 'terminal-find-next');
    const close = button('Close (Escape)', ICONS.close, 'terminal-find-close');
    const widget = el('div', {
        className: 'terminal-find',
        attrs: { role: 'search', 'aria-label': 'Find in terminal', hidden: '', 'data-testid': 'terminal-find' },
    }, [input, caseButton, count, previous, next, close]);
    parent.append(widget);

    function run(direction: 'next' | 'previous', incremental = false): void {
        if (!target) {
            return;
        }
        if (input.value === '') {
            target.clearFind();
            count.textContent = '';
            return;
        }
        target.find(input.value, { caseSensitive }, direction, incremental);
    }

    function hide(refocus: boolean): void {
        if (widget.hidden) {
            return;
        }
        widget.hidden = true;
        target?.clearFind();
        count.textContent = '';
        if (refocus) {
            target?.focus();
        }
    }

    input.addEventListener('input', () => run('next', true));
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            run(event.shiftKey ? 'previous' : 'next');
        } else if (event.key === 'Escape') {
            event.preventDefault();
            hide(true);
        }
    });
    // Escape from the buttons too: the whole widget is one control.
    widget.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && event.target !== input) {
            event.preventDefault();
            hide(true);
        }
    });
    caseButton.addEventListener('click', () => {
        caseSensitive = !caseSensitive;
        caseButton.setAttribute('aria-pressed', String(caseSensitive));
        run('next', true);
    });
    previous.addEventListener('click', () => run('previous'));
    next.addEventListener('click', () => run('next'));
    close.addEventListener('click', () => hide(true));

    return {
        get isOpen() { return !widget.hidden; },
        open(next) {
            if (target && target !== next) {
                target.clearFind();
            }
            target = next;
            const selected = next.selection();
            if (selected !== '' && !selected.includes('\n')) {
                input.value = selected;
            }
            widget.hidden = false;
            input.focus();
            input.select();
            run('next', true);
        },
        close: (refocus = false) => hide(refocus),
        setTarget(next) {
            if (next === target) {
                return;
            }
            target?.clearFind();
            target = next;
            if (!next) {
                hide(false);
            } else if (!widget.hidden) {
                run('next', true);
            }
        },
        setResults(from, index, total) {
            if (from === target && !widget.hidden) {
                count.textContent = findCountText(index, total, FIND_HIGHLIGHT_LIMIT, input.value !== '');
            }
        },
    };
}
