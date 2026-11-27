import type { DebugBreakpoint, DebugScope, DebugStackFrame, DebugVariable, LaunchConfiguration } from '../../shared/debug.ts';
import { el, icon } from '../dom.ts';
import './debug.css';

/**
 * #180: the Run and Debug view of the side bar, VS Code's sections kept:
 * the configuration to start, Variables (a tree loaded as it is expanded,
 * whose open nodes stay open from one stop to the next), Watch, Call Stack
 * and Breakpoints. It only draws; debugController.ts holds the session.
 */

export const DEBUG_ICONS = {
    start: 'M7 4l13 8-13 8z',
    continue: 'M5 4v16M9 4l11 8-11 8z',
    pause: 'M8 5v14M16 5v14',
    stepOver: 'M4 13a8 8 0 0 1 15-4M19 3v6h-6M12 19a1.5 1.5 0 1 0 0.01 0',
    stepInto: 'M12 3v11M7 9l5 5 5-5M12 19a1.5 1.5 0 1 0 0.01 0',
    stepOut: 'M12 14V3M7 8l5-5 5 5M12 19a1.5 1.5 0 1 0 0.01 0',
    restart: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    stop: 'M6 6h12v12H6z',
    gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
    add: 'M12 5v14M5 12h14',
    remove: 'M6 6l12 12M18 6L6 18',
    removeAll: 'M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 13h10l1-13',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
} as const;

/** The pick for "the active file, with its language's debugger". */
export const CURRENT_FILE_CHOICE = '';

export interface DebugViewHooks {
    start(): void;
    configure(): void;
    selectConfiguration(name: string): void;
    /** Children of a variable or scope; rejected while nothing is paused. */
    variables(reference: number): Promise<readonly DebugVariable[]>;
    selectFrame(frame: DebugStackFrame): void;
    addWatch(expression: string): void;
    removeWatch(index: number): void;
    openBreakpoint(path: string, line: number): void;
    removeBreakpoint(path: string, line: number): void;
    removeAllBreakpoints(): void;
}

export interface WatchRow {
    readonly expression: string;
    /** Null while nothing is paused (or not evaluated yet). */
    readonly value: { readonly text: string; readonly failed: boolean; readonly reference: number } | null;
}

export interface DebugView {
    setConfigurations(configurations: readonly LaunchConfiguration[], selected: string): void;
    /** A line under the start button: why nothing can start, or what the session is doing. */
    setStatus(text: string, tone: 'muted' | 'warning' | 'error'): void;
    setRunning(running: boolean): void;
    setScopes(scopes: readonly DebugScope[] | null): void;
    setWatches(rows: readonly WatchRow[]): void;
    setFrames(frames: readonly DebugStackFrame[], selected: number | null, threadLabel: string | null): void;
    setBreakpoints(breakpoints: readonly DebugBreakpoint[]): void;
}

export function createDebugView(container: HTMLElement, hooks: DebugViewHooks): DebugView {
    const iconButton = (label: string, path: string, testId: string, run: () => void): HTMLButtonElement => {
        const button = el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(path)]);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            run();
        });
        return button;
    };

    const header = el('div', { className: 'side-bar-header' }, [
        el('h2', { className: 'side-bar-title', text: 'Run and Debug' }),
        el('div', { className: 'side-bar-actions' }, [iconButton('Open launch.json', DEBUG_ICONS.gear, 'debug-configure', hooks.configure)]),
    ]);
    const select = el('select', { className: 'debug-config', attrs: { 'aria-label': 'Debug configuration', 'data-testid': 'debug-config' } });
    select.addEventListener('change', () => hooks.selectConfiguration(select.value));
    const startButton = el('button', {
        className: 'icon-button debug-start',
        attrs: { type: 'button', title: 'Start Debugging (F5)', 'aria-label': 'Start Debugging', 'data-testid': 'debug-start' },
    }, [icon(DEBUG_ICONS.start)]);
    startButton.addEventListener('click', () => hooks.start());
    const status = el('p', { className: 'debug-status muted', attrs: { 'data-testid': 'debug-status', 'aria-live': 'polite' } });

    // ---- sections
    const section = (title: string, testId: string, actions: HTMLElement[] = []): { root: HTMLDetailsElement; body: HTMLElement } => {
        const body = el('div', { className: 'debug-section-body' });
        const summary = el('summary', { className: 'debug-section-title' }, [el('span', { text: title }), el('span', { className: 'debug-section-actions' }, actions)]);
        const root = el('details', { className: 'debug-section', attrs: { open: '', 'data-testid': testId } }, [summary, body]);
        return { root, body };
    };

    const variables = section('Variables', 'debug-variables');
    const watchInput = el('input', { className: 'debug-watch-input', attrs: { type: 'text', placeholder: 'Expression to watch', 'aria-label': 'Expression to watch', spellcheck: 'false', 'data-testid': 'debug-watch-input', hidden: '' } });
    const addWatchButton = iconButton('Add Expression', DEBUG_ICONS.add, 'debug-watch-add', () => {
        watch.root.open = true;
        watchInput.hidden = false;
        watchInput.focus();
    });
    const watch = section('Watch', 'debug-watch', [addWatchButton]);
    const watchList = el('ul', { className: 'debug-tree', attrs: { role: 'tree', 'aria-label': 'Watch' } });
    watch.body.append(watchList, watchInput);
    watchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            const expression = watchInput.value.trim();
            watchInput.value = '';
            watchInput.hidden = true;
            if (expression) {
                hooks.addWatch(expression);
            }
        } else if (event.key === 'Escape') {
            watchInput.value = '';
            watchInput.hidden = true;
        }
    });
    watchInput.addEventListener('blur', () => {
        if (!watchInput.value.trim()) {
            watchInput.hidden = true;
        }
    });
    const callStack = section('Call Stack', 'debug-call-stack');
    const breakpoints = section('Breakpoints', 'debug-breakpoints', [iconButton('Remove All Breakpoints', DEBUG_ICONS.removeAll, 'debug-breakpoints-clear', hooks.removeAllBreakpoints)]);

    container.replaceChildren(
        header,
        el('div', { className: 'debug-launch' }, [startButton, select]),
        status,
        variables.root,
        watch.root,
        callStack.root,
        breakpoints.root,
    );

    // ---- variables tree: what is open stays open across stops (keys are name paths).
    const expanded = new Set<string>();
    /** Bumped when a tree is redrawn, so children loaded for the old one are dropped. */
    const variablesTree = { generation: 0 };
    const watchTree = { generation: 0 };

    function variableRow(tree: { generation: number }, key: string, name: string, value: string | null, type: string | null, reference: number, depth: number, failed = false, extra: HTMLElement[] = []): HTMLLIElement {
        const twisty = el('span', { className: reference > 0 ? 'debug-twisty' : 'debug-twisty is-leaf', attrs: { 'aria-hidden': 'true' } });
        const label = el('span', { className: 'debug-var-name', text: name });
        const row = el('div', { className: 'debug-row', attrs: { title: type ? `${name}: ${type}` : name } }, [
            twisty,
            label,
            ...(value === null ? [] : [el('span', { className: 'debug-var-sep', text: ': ' }), el('span', { className: failed ? 'debug-var-value is-error' : 'debug-var-value', text: value })]),
            ...extra,
        ]);
        row.style.paddingLeft = `${8 + depth * 12}px`;
        const item = el('li', { className: 'debug-node', attrs: { role: 'treeitem', 'data-key': key } }, [row]);
        if (reference > 0) {
            item.setAttribute('aria-expanded', 'false');
            const children = el('ul', { className: 'debug-tree', attrs: { role: 'group' } });
            item.append(children);
            const generation = tree.generation;
            const open = (load: boolean): void => {
                item.setAttribute('aria-expanded', 'true');
                expanded.add(key);
                if (!load) {
                    return;
                }
                children.replaceChildren(el('li', { className: 'debug-loading muted', text: 'Loading…' }));
                hooks.variables(reference).then((list) => {
                    if (generation !== tree.generation) {
                        return;
                    }
                    children.replaceChildren(...(list.length === 0
                        ? [el('li', { className: 'debug-empty muted', text: 'No items' })]
                        : list.map((child) => variableRow(tree, `${key}/${child.name}`, child.name, child.value, child.type, child.variablesReference, depth + 1))));
                }, (error: unknown) => {
                    children.replaceChildren(el('li', { className: 'debug-empty muted', text: error instanceof Error ? error.message : String(error) }));
                });
            };
            row.addEventListener('click', () => {
                if (item.getAttribute('aria-expanded') === 'true') {
                    item.setAttribute('aria-expanded', 'false');
                    expanded.delete(key);
                    children.replaceChildren();
                } else {
                    open(true);
                }
            });
            if (expanded.has(key)) {
                open(true);
            }
        }
        return item;
    }

    function setScopes(scopes: readonly DebugScope[] | null): void {
        variablesTree.generation += 1;
        if (scopes === null) {
            variables.body.replaceChildren(el('p', { className: 'debug-empty muted', text: 'Not paused.' }));
            return;
        }
        const list = el('ul', { className: 'debug-tree', attrs: { role: 'tree', 'aria-label': 'Variables' } });
        for (const [index, scope] of scopes.entries()) {
            const key = `scope:${scope.name}`;
            // The first cheap scope and the locals open by themselves (until closed by hand).
            if ((index === 0 || /^Locals?$/.test(scope.name)) && !scope.expensive && !expanded.has(`closed:${key}`)) {
                expanded.add(key);
            }
            const item = variableRow(variablesTree, key, scope.name, null, null, scope.variablesReference, 0);
            item.classList.add('is-scope');
            item.querySelector('.debug-row')?.addEventListener('click', () => {
                if (item.getAttribute('aria-expanded') === 'false') {
                    expanded.add(`closed:${key}`);
                } else {
                    expanded.delete(`closed:${key}`);
                }
            });
            list.append(item);
        }
        variables.body.replaceChildren(list);
    }

    function setWatches(rows: readonly WatchRow[]): void {
        watchTree.generation += 1;
        watchList.replaceChildren(...rows.map((row, index) => {
            const remove = iconButton('Remove Expression', DEBUG_ICONS.remove, 'debug-watch-remove', () => hooks.removeWatch(index));
            remove.classList.add('debug-row-action');
            const value = row.value === null ? 'not available' : row.value.text;
            return variableRow(watchTree, `watch:${index}:${row.expression}`, row.expression, value, null, row.value?.reference ?? 0, 0, row.value?.failed ?? false, [remove]);
        }));
        if (rows.length === 0) {
            watchList.replaceChildren(el('li', { className: 'debug-empty muted', text: 'No expressions. Add one with +.' }));
        }
    }

    function setFrames(frames: readonly DebugStackFrame[], selected: number | null, threadLabel: string | null): void {
        if (frames.length === 0) {
            callStack.body.replaceChildren(el('p', { className: 'debug-empty muted', text: threadLabel ?? 'Not paused.' }));
            return;
        }
        const list = el('ul', { className: 'debug-tree', attrs: { role: 'listbox', 'aria-label': 'Call Stack' } });
        for (const frame of frames) {
            const where = frame.path ?? frame.sourceName ?? '';
            const file = where.split(/[\\/]/).pop() ?? where;
            const row = el('li', {
                className: ['debug-row', 'debug-frame', frame.id === selected ? 'is-selected' : '', frame.hint !== 'normal' ? 'is-subtle' : ''].filter(Boolean).join(' '),
                attrs: { role: 'option', 'aria-selected': String(frame.id === selected), title: frame.path ?? frame.sourceName ?? frame.name, 'data-testid': 'debug-frame' },
            }, [
                el('span', { className: 'debug-frame-name', text: frame.name }),
                el('span', { className: 'debug-frame-where muted', text: file ? `${file}:${frame.line}` : '' }),
            ]);
            row.addEventListener('click', () => hooks.selectFrame(frame));
            list.append(row);
        }
        callStack.body.replaceChildren(...(threadLabel ? [el('p', { className: 'debug-thread muted', text: threadLabel })] : []), list);
    }

    function setBreakpoints(list: readonly DebugBreakpoint[]): void {
        if (list.length === 0) {
            breakpoints.body.replaceChildren(el('p', { className: 'debug-empty muted', text: 'Click left of a line number to add a breakpoint.' }));
            return;
        }
        const items = el('ul', { className: 'debug-tree', attrs: { role: 'list', 'aria-label': 'Breakpoints' } });
        for (const breakpoint of list) {
            const name = breakpoint.path.split('/').pop() ?? breakpoint.path;
            const remove = iconButton('Remove Breakpoint', DEBUG_ICONS.remove, 'debug-breakpoint-remove', () => hooks.removeBreakpoint(breakpoint.path, breakpoint.line));
            remove.classList.add('debug-row-action');
            const row = el('li', {
                className: 'debug-row debug-breakpoint-row',
                attrs: { title: breakpoint.message ?? `${breakpoint.path}:${breakpoint.line}`, 'data-testid': 'debug-breakpoint-row' },
            }, [
                el('span', { className: breakpoint.verified === false ? 'debug-dot is-unverified' : 'debug-dot', attrs: { 'aria-hidden': 'true' } }),
                el('span', { className: 'debug-frame-name', text: name }),
                el('span', { className: 'debug-frame-where muted', text: `${breakpoint.path === name ? '' : `${breakpoint.path} `}${breakpoint.line}` }),
                remove,
            ]);
            row.addEventListener('click', () => hooks.openBreakpoint(breakpoint.path, breakpoint.line));
            items.append(row);
        }
        breakpoints.body.replaceChildren(items);
    }

    setScopes(null);
    setWatches([]);
    setFrames([], null, null);
    setBreakpoints([]);

    return {
        setConfigurations(configurations, selected): void {
            const options = [
                el('option', { text: 'Current file (Python or Node.js)', attrs: { value: CURRENT_FILE_CHOICE } }),
                ...configurations.map((configuration) => el('option', { text: configuration.name, attrs: { value: configuration.name } })),
            ];
            select.replaceChildren(...options);
            select.value = configurations.some((configuration) => configuration.name === selected) ? selected : CURRENT_FILE_CHOICE;
        },
        setStatus(text, tone): void {
            status.textContent = text;
            status.className = `debug-status ${tone === 'muted' ? 'muted' : `is-${tone}`}`;
            status.hidden = text === '';
        },
        setRunning(running): void {
            const label = running ? 'Continue (F5)' : 'Start Debugging (F5)';
            startButton.title = label;
            startButton.setAttribute('aria-label', label.replace(/ \(F5\)$/, ''));
        },
        setScopes,
        setWatches,
        setFrames,
        setBreakpoints,
    };
}
