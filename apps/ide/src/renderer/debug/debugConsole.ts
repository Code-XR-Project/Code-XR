import { el, icon } from '../dom.ts';
import type { PanelHost } from '../panel/panelHost.ts';

/**
 * #180: the Debug Console, a view of the bottom panel. It shows what the
 * program printed (stdout, stderr) and what the debugger said, and its input
 * evaluates an expression in the selected frame of a paused session (or the
 * program's global scope while it runs), as VS Code's REPL does. Up and Down
 * walk the expressions typed before.
 */

const ICONS = {
    clear: 'M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 13h10l1-13',
} as const;

/** Text the console keeps; the oldest goes first. */
const MAX_CONSOLE_CHARS = 1_000_000;
const MAX_HISTORY = 100;

export type ConsoleCategory = 'stdout' | 'stderr' | 'console' | 'important' | 'input' | 'result' | 'error';

export interface DebugConsole {
    append(category: ConsoleCategory, text: string): void;
    clear(): void;
    show(): void;
    /** Whether the input can evaluate (a session is running). */
    setEnabled(enabled: boolean): void;
}

export function createDebugConsole(host: PanelHost, evaluate: (expression: string) => Promise<{ text: string; failed: boolean }>): DebugConsole {
    const lines = el('div', { className: 'debug-console-lines', attrs: { role: 'log', 'aria-live': 'polite', tabindex: '0', 'data-testid': 'debug-console-lines' } });
    const input = el('input', {
        className: 'debug-console-input',
        attrs: { type: 'text', 'aria-label': 'Evaluate an expression', placeholder: 'Start a debug session to evaluate expressions', spellcheck: 'false', disabled: '', 'data-testid': 'debug-console-input' },
    });
    const prompt = el('span', { className: 'debug-console-prompt', text: '>', attrs: { 'aria-hidden': 'true' } });
    const body = el('div', { className: 'debug-console', attrs: { 'data-testid': 'debug-console' } }, [lines, el('div', { className: 'debug-console-row' }, [prompt, input])]);
    const clearButton = el('button', { className: 'icon-button', attrs: { type: 'button', title: 'Clear Console', 'aria-label': 'Clear Console', 'data-testid': 'debug-console-clear' } }, [icon(ICONS.clear)]);
    clearButton.addEventListener('click', () => clear());
    host.register({ id: 'debug', label: 'Debug Console', body, actions: [clearButton], onShow: () => scrollToEnd() });

    let size = 0;
    /** The open line of a stream (output that has not ended with a newline yet). */
    let open: { element: HTMLElement; category: ConsoleCategory } | null = null;
    const history: string[] = [];
    let historyIndex = 0;

    function scrollToEnd(): void {
        lines.scrollTop = lines.scrollHeight;
    }

    function trim(): void {
        while (size > MAX_CONSOLE_CHARS && lines.firstChild) {
            size -= lines.firstChild.textContent?.length ?? 0;
            if (open?.element === lines.firstChild) {
                open = null;
            }
            lines.firstChild.remove();
        }
    }

    function append(category: ConsoleCategory, text: string): void {
        if (!text) {
            return;
        }
        const atEnd = lines.scrollTop + lines.clientHeight >= lines.scrollHeight - 4;
        const streamed = category === 'stdout' || category === 'stderr' || category === 'console';
        const parts = text.split(/(?<=\n)/);
        for (const part of parts) {
            if (streamed && open && open.category === category) {
                open.element.textContent += part;
            } else {
                const element = el('div', { className: `debug-console-line is-${category}`, text: part });
                lines.append(element);
                open = streamed ? { element, category } : null;
            }
            if (part.endsWith('\n')) {
                open = null;
            }
            size += part.length;
        }
        trim();
        if (atEnd) {
            scrollToEnd();
        }
    }

    function clear(): void {
        lines.replaceChildren();
        size = 0;
        open = null;
    }

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            const expression = input.value.trim();
            if (!expression) {
                return;
            }
            event.preventDefault();
            input.value = '';
            if (history[history.length - 1] !== expression) {
                history.push(expression);
                if (history.length > MAX_HISTORY) {
                    history.shift();
                }
            }
            historyIndex = history.length;
            open = null;
            append('input', `> ${expression}\n`);
            void evaluate(expression).then(({ text, failed }) => append(failed ? 'error' : 'result', `${text}\n`));
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            if (history.length === 0) {
                return;
            }
            event.preventDefault();
            historyIndex = Math.max(0, Math.min(history.length, historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
            input.value = history[historyIndex] ?? '';
        }
    });

    return {
        append,
        clear,
        show: () => {
            host.show('debug');
            if (!input.disabled) {
                input.focus();
            }
        },
        setEnabled(enabled: boolean): void {
            input.disabled = !enabled;
            input.placeholder = enabled ? 'Evaluate an expression' : 'Start a debug session to evaluate expressions';
        },
    };
}
