import { filterProblems, groupProblems, PROBLEM_SEVERITIES, problemCounts, type Problem, type ProblemOrigin, type ProblemSeverity } from '../../shared/problems.ts';
import { el, fileIcon, icon } from '../dom.ts';
import type { PanelHost } from '../panel/panelHost.ts';

/**
 * The Problems view of the bottom panel (#173): what the editor's languages
 * report on the open files and the Code-XR metric checks of the analysed
 * functions, in one list grouped by file. A row opens its file at the
 * problem. The list (shared/problems.ts) is pure; this view only draws it.
 */

export const PROBLEM_ICONS: Record<ProblemSeverity, string> = {
    error: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M9 9l6 6M15 9l-6 6',
    warning: 'M12 4L2.5 20h19zM12 10v4.5M12 17.2v.3',
    info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 11v6M12 7.6v.3',
};
const CHEVRON = 'M9 6l6 6-6 6';
const COLLAPSE = 'M7 10l5-5 5 5M7 19l5-5 5 5';
const SEVERITY_LABEL: Record<ProblemSeverity, string> = { error: 'Errors', warning: 'Warnings', info: 'Infos' };

export interface ProblemsView {
    show(): void;
    /** The languages' markers on the open files (replaces the previous ones). */
    setEditorProblems(problems: readonly Problem[]): void;
    /** The metric problems of the last analysis; `measured` false while none has run. */
    setMetricProblems(problems: readonly Problem[], measured: boolean): void;
    /** Moves the focus into the filter (View: Focus Problems). */
    focusFilter(): void;
}

export interface ProblemsHooks {
    open(problem: Problem): void;
    /** The totals changed (the status bar's counts). */
    onCounts(counts: Record<ProblemSeverity, number>): void;
}

export function createProblemsView(host: PanelHost, hooks: ProblemsHooks): ProblemsView {
    let editorProblems: readonly Problem[] = [];
    let metricProblems: readonly Problem[] = [];
    let measured = false;
    const severities = new Set<ProblemSeverity>(PROBLEM_SEVERITIES);
    let origin: ProblemOrigin | 'all' = 'all';
    const collapsed = new Set<string>();
    let frame = 0;

    const filter = el('input', {
        className: 'problems-filter',
        attrs: { type: 'text', placeholder: 'Filter (e.g. text, !exclude)', 'aria-label': 'Filter problems', spellcheck: 'false', 'data-testid': 'problems-filter' },
    });
    const toggles = new Map<ProblemSeverity, { readonly button: HTMLButtonElement; readonly count: HTMLElement }>();
    const toggleBar = el('span', { className: 'problems-toggles' });
    for (const severity of PROBLEM_SEVERITIES) {
        const count = el('span', { text: '0' });
        const toggle = el('button', {
            className: `problems-toggle is-${severity}`,
            attrs: { type: 'button', 'aria-pressed': 'true', title: `Show ${SEVERITY_LABEL[severity]}`, 'data-testid': `problems-toggle-${severity}` },
        }, [icon(PROBLEM_ICONS[severity]), count]);
        toggle.addEventListener('click', () => {
            if (severities.has(severity)) { severities.delete(severity); } else { severities.add(severity); }
            toggle.setAttribute('aria-pressed', String(severities.has(severity)));
            render();
        });
        toggles.set(severity, { button: toggle, count });
        toggleBar.append(toggle);
    }
    const originPicker = el('select', { className: 'problems-origin', attrs: { 'aria-label': 'Problem source', 'data-testid': 'problems-origin' } }, [
        el('option', { text: 'All sources', attrs: { value: 'all' } }),
        el('option', { text: 'Code-XR metrics', attrs: { value: 'metrics' } }),
        el('option', { text: 'Editor', attrs: { value: 'editor' } }),
    ]);
    const collapseButton = el('button', { className: 'icon-button', attrs: { type: 'button', title: 'Collapse All', 'aria-label': 'Collapse All', 'data-testid': 'problems-collapse' } }, [icon(COLLAPSE)]);
    const list = el('div', { className: 'problems-list', attrs: { role: 'tree', 'aria-label': 'Problems', 'data-testid': 'problems-list' } });
    const message = el('p', { className: 'muted problems-message', attrs: { 'data-testid': 'problems-message' } });
    const body = el('div', { className: 'problems-body', attrs: { 'data-testid': 'problems-body' } }, [message, list]);

    host.register({
        id: 'problems',
        label: 'Problems',
        body,
        center: el('div', { className: 'problems-center' }, [filter, toggleBar, originPicker]),
        actions: [collapseButton],
    });

    function all(): Problem[] {
        return [...editorProblems, ...metricProblems];
    }

    function schedule(): void {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(render);
    }

    function render(): void {
        cancelAnimationFrame(frame);
        const everything = all();
        const counts = problemCounts(everything);
        for (const [severity, toggle] of toggles) {
            toggle.count.textContent = String(counts[severity]);
        }
        const total = counts.error + counts.warning + counts.info;
        host.setBadge('problems', total > 0 ? String(total) : null);
        hooks.onCounts(counts);

        const shown = filterProblems(everything, { text: filter.value, severities, origin });
        const groups = groupProblems(shown);
        message.textContent = total === 0
            ? (measured ? 'No problems have been detected in the workspace.' : 'No problems have been detected in the open files. Analyse the project to check its functions against the metric limits.')
            : shown.length === 0 ? `No problems match the filter (${total} hidden).` : '';
        message.hidden = message.textContent === '';
        const focusedKey = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.problems-list [data-key]')?.dataset['key'];
        const rows: HTMLElement[] = [];
        for (const group of groups) {
            const isCollapsed = collapsed.has(group.path);
            rows.push(groupRow(group.path, group.problems.length, isCollapsed));
            if (!isCollapsed) {
                group.problems.forEach((problem, index) => rows.push(problemRow(problem, `${group.path}#${index}`)));
            }
        }
        list.replaceChildren(...rows);
        const first = rows[0];
        const restored = focusedKey ? rows.find((row) => row.dataset['key'] === focusedKey) : undefined;
        for (const row of rows) { row.tabIndex = -1; }
        (restored ?? first)?.setAttribute('tabindex', '0');
        restored?.focus();
    }

    function groupRow(path: string, count: number, isCollapsed: boolean): HTMLElement {
        const name = path.slice(path.lastIndexOf('/') + 1);
        const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const row = el('div', {
            className: isCollapsed ? 'problems-file is-collapsed' : 'problems-file',
            attrs: { role: 'treeitem', 'aria-level': '1', 'aria-expanded': String(!isCollapsed), title: path, 'data-path': path, 'data-key': path },
        }, [
            icon(CHEVRON, 'problems-chevron'),
            fileIcon(name, 'file'),
            el('span', { className: 'problems-file-name', text: name }),
            el('span', { className: 'problems-file-folder muted', text: folder }),
            el('span', { className: 'problems-count', text: String(count) }),
        ]);
        const flip = (): void => {
            if (collapsed.has(path)) { collapsed.delete(path); } else { collapsed.add(path); }
            render();
        };
        row.addEventListener('click', flip);
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ' || (event.key === 'ArrowLeft' && !isCollapsed) || (event.key === 'ArrowRight' && isCollapsed)) {
                event.preventDefault();
                flip();
            }
        });
        return row;
    }

    function problemRow(problem: Problem, key: string): HTMLElement {
        const where = `[Ln ${problem.startLine}, Col ${problem.startColumn}]`;
        const origin = problem.code ? `${problem.source}(${problem.code})` : problem.source;
        const row = el('div', {
            className: `problems-row is-${problem.severity}`,
            attrs: { role: 'treeitem', 'aria-level': '2', title: `${problem.message} ${origin} ${where}`, 'data-key': key, 'data-origin': problem.origin },
        }, [
            icon(PROBLEM_ICONS[problem.severity], 'problems-severity'),
            el('span', { className: 'problems-text', text: problem.message }),
            el('span', { className: 'problems-source muted', text: origin }),
            el('span', { className: 'problems-where muted', text: where }),
        ]);
        row.setAttribute('aria-label', `${problem.severity}: ${problem.message} ${origin} ${where}`);
        row.addEventListener('click', () => hooks.open(problem));
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                hooks.open(problem);
            } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                collapsed.add(problem.path);
                render();
                list.querySelector<HTMLElement>(`.problems-file[data-key="${CSS.escape(problem.path)}"]`)?.focus();
            }
        });
        return row;
    }

    // Up and down move between rows, as in a tree.
    list.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
            return;
        }
        const rows = [...list.querySelectorAll<HTMLElement>('[data-key]')];
        const index = rows.indexOf(event.target as HTMLElement);
        const next = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows.at(-1)
            : rows[Math.min(Math.max(index + (event.key === 'ArrowDown' ? 1 : -1), 0), rows.length - 1)];
        if (next) {
            event.preventDefault();
            for (const row of rows) { row.tabIndex = -1; }
            next.tabIndex = 0;
            next.focus();
        }
    });
    filter.addEventListener('input', schedule);
    filter.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            list.querySelector<HTMLElement>('[data-key]')?.focus();
        } else if (event.key === 'Escape' && filter.value) {
            event.stopPropagation();
            filter.value = '';
            render();
        }
    });
    originPicker.addEventListener('change', () => {
        origin = originPicker.value as ProblemOrigin | 'all';
        render();
    });
    collapseButton.addEventListener('click', () => {
        for (const group of groupProblems(all())) { collapsed.add(group.path); }
        render();
    });
    render();

    return {
        show(): void {
            host.show('problems');
        },
        setEditorProblems(problems: readonly Problem[]): void {
            editorProblems = problems;
            schedule();
        },
        setMetricProblems(problems: readonly Problem[], wasMeasured: boolean): void {
            metricProblems = problems;
            measured = wasMeasured;
            schedule();
        },
        focusFilter(): void {
            host.show('problems');
            filter.focus();
        },
    };
}
