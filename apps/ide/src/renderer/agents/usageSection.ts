import type { AgentsApi, ModelPrice, UsageGroup, UsageSummary } from '../../shared/agents.ts';
import { tokens, usd } from '../../shared/usageFormat.ts';
import { el } from '../dom.ts';

/**
 * The "Usage and budget" section of the Agents view (A13): this month's
 * tokens and costs per agent, provider and model, the monthly budget and the
 * price table. Estimated cost (tokens × the table) and reported cost (what a
 * provider such as OpenRouter says it billed) are always separate columns.
 */

export interface UsageSection {
    readonly element: HTMLElement;
    refresh(): Promise<void>;
}

const errorText = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** The line a chat shows under its composer when the budget needs attention. */
export function budgetNote(summary: UsageSummary): string {
    const { budget, budgetSpend } = summary;
    if (summary.budgetState === 'reached') {
        return budget.hardStop
            ? `Monthly budget reached (${usd(budgetSpend)} of ${usd(budget.monthlyUsd)}): new answers are blocked until you raise it.`
            : `Monthly budget passed: ${usd(budgetSpend)} of ${usd(budget.monthlyUsd)}.`;
    }
    if (summary.budgetState === 'warning') {
        return `${Math.round((budgetSpend / budget.monthlyUsd) * 100)}% of this month's budget used (${usd(budgetSpend)} of ${usd(budget.monthlyUsd)}).`;
    }
    return '';
}

function monthName(month: string): string {
    const [year, number] = month.split('-').map(Number);
    return new Date(year ?? 2000, (number ?? 1) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function createUsageSection(api: AgentsApi, callbacks: { onStatus(message: string): void }): UsageSection {
    const overview = el('div', { className: 'agents-usage-overview', attrs: { 'data-testid': 'agents-usage' } });
    const breakdown = el('div');
    const budgetSlot = el('div');
    const pricesSlot = el('div');
    const element = el('section', { className: 'agents-section', attrs: { 'aria-labelledby': 'agents-usage-heading' } }, [
        el('h3', { className: 'side-bar-subtitle', text: 'Usage and budget', attrs: { id: 'agents-usage-heading' } }),
        overview,
        breakdown,
        budgetSlot,
        pricesSlot,
    ]);

    async function refresh(): Promise<void> {
        render(await api.usage());
    }

    function render(summary: UsageSummary): void {
        const { total } = summary;
        const note = budgetNote(summary);
        overview.replaceChildren(
            el('p', { className: 'small', text: `${monthName(summary.month)}: ${total.calls} model call${total.calls === 1 ? '' : 's'}, ${tokens(total.inputTokens)} in / ${tokens(total.outputTokens)} out tokens.` }),
            el('dl', { className: 'agents-usage-figures small' }, [
                el('dt', { text: 'Estimated' }),
                el('dd', { text: usd(total.estimatedCost), attrs: { title: 'Tokens × your price table' } }),
                el('dt', { text: 'Reported by providers' }),
                el('dd', { text: usd(total.reportedCost), attrs: { title: 'What providers such as OpenRouter said they billed' } }),
                ...(total.unpricedCalls > 0 ? [el('dt', { text: 'Unknown cost' }), el('dd', { text: `${total.unpricedCalls} call${total.unpricedCalls === 1 ? '' : 's'}: add the model to the price table` })] : []),
            ]),
            ...(summary.budget.monthlyUsd > 0 ? [el('p', {
                className: 'muted small',
                text: `Budget: ${usd(summary.budgetSpend)} of ${usd(summary.budget.monthlyUsd)} counted (each call's reported cost, or its estimate when none was reported).`,
            })] : []),
            ...(note ? [el('p', { className: `small agents-budget-note is-${summary.budgetState}`, text: note, attrs: { role: 'status' } })] : []),
        );
        breakdown.replaceChildren(...(total.calls > 0 ? [
            groupTable('By agent', summary.byAgent),
            groupTable('By provider', summary.byProvider),
            groupTable('By model', summary.byModel),
        ] : []));
        budgetSlot.replaceChildren(budgetForm(summary));
        pricesSlot.replaceChildren(priceTable(summary.prices));
    }

    function groupTable(label: string, groups: readonly UsageGroup[]): HTMLElement {
        // A list rather than a table: the side bar is too narrow for four columns.
        return el('details', { className: 'agents-usage-group' }, [
            el('summary', { className: 'small', text: label }),
            el('ul', { className: 'agents-usage-list' }, groups.map((group) => el('li', {}, [
                el('span', { className: 'agents-usage-name small', text: group.name }),
                el('span', { className: 'muted small', text: [
                    `${tokens(group.inputTokens)} in / ${tokens(group.outputTokens)} out`,
                    `est. ${group.unpricedCalls > 0 && group.estimatedCost === 0 ? '?' : usd(group.estimatedCost)}`,
                    `reported ${usd(group.reportedCost)}`,
                ].join(' · ') }),
            ]))),
        ]);
    }

    function budgetForm(summary: UsageSummary): HTMLElement {
        const amount = el('input', { className: 'agents-input', attrs: { id: 'usage-budget', type: 'number', min: '0', step: 'any', placeholder: 'No budget' } });
        amount.value = summary.budget.monthlyUsd > 0 ? String(summary.budget.monthlyUsd) : '';
        const warn = el('input', { className: 'agents-input', attrs: { id: 'usage-warn', type: 'number', min: '10', max: '100', step: '5' } });
        warn.value = String(Math.round(summary.budget.warnAt * 100));
        const stop = el('input', { attrs: { id: 'usage-stop', type: 'checkbox' } });
        stop.checked = summary.budget.hardStop;
        const error = el('p', { className: 'error small', attrs: { hidden: '', role: 'alert' } });
        const save = el('button', { className: 'secondary-button', text: 'Save budget', attrs: { type: 'submit' } });
        const form = el('form', { className: 'agents-form agents-budget-form', attrs: { 'aria-label': 'Monthly budget', 'data-testid': 'usage-budget-form' } }, [
            el('div', { className: 'agents-field' }, [el('label', { text: 'Monthly budget (USD)', attrs: { for: 'usage-budget' } }), amount]),
            el('div', { className: 'agents-field' }, [el('label', { text: 'Warn at (% of the budget)', attrs: { for: 'usage-warn' } }), warn]),
            el('label', { className: 'agents-tool' }, [stop, el('span', { text: 'Stop new answers once the budget is spent' })]),
            error,
            el('div', { className: 'env-actions' }, [save]),
        ]);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            save.disabled = true;
            error.hidden = true;
            api.saveBudget({ monthlyUsd: Number(amount.value || 0), warnAt: Number(warn.value || 80) / 100, hardStop: stop.checked }).then((next) => {
                callbacks.onStatus('Saved the budget.');
                render(next);
            }, (failure: unknown) => {
                error.hidden = false;
                error.textContent = errorText(failure);
            }).finally(() => { save.disabled = false; });
        });
        return form;
    }

    function priceTable(prices: readonly ModelPrice[]): HTMLElement {
        const rows = el('tbody');
        const addRow = (price?: ModelPrice): void => {
            const input = (value: string, label: string, numeric: boolean): HTMLInputElement => {
                const node = el('input', { className: 'agents-input', attrs: { type: numeric ? 'number' : 'text', 'aria-label': label, ...(numeric ? { min: '0', step: 'any' } : { spellcheck: 'false', placeholder: 'model-id or prefix*' }) } });
                node.value = value;
                return node;
            };
            const remove = el('button', { className: 'link-button small', text: 'Remove', attrs: { type: 'button' } });
            const row = el('tr', { attrs: { 'data-price-row': '' } }, [
                el('td', {}, [input(price?.model ?? '', 'Model', false)]),
                el('td', {}, [input(price ? String(price.inputPerMillion) : '', 'Input USD per million tokens', true)]),
                el('td', {}, [input(price ? String(price.outputPerMillion) : '', 'Output USD per million tokens', true)]),
                el('td', {}, [remove]),
            ]);
            remove.addEventListener('click', () => row.remove());
            rows.append(row);
        };
        for (const price of prices) {
            addRow(price);
        }
        const add = el('button', { className: 'link-button small', text: 'Add a model', attrs: { type: 'button', 'data-action': 'add-price' } });
        add.addEventListener('click', () => addRow());
        const error = el('p', { className: 'error small', attrs: { hidden: '', role: 'alert' } });
        const save = el('button', { className: 'secondary-button', text: 'Save prices', attrs: { type: 'submit' } });
        const form = el('form', { className: 'agents-form', attrs: { 'aria-label': 'Price table', 'data-testid': 'usage-prices-form' } }, [
            el('p', { className: 'muted small agents-help', text: 'USD per million tokens, from your provider\'s pricing page. Used for the estimate only; a trailing * matches every model id that starts with the rest.' }),
            el('div', { className: 'agents-usage-scroll' }, [
                el('table', { className: 'agents-usage-table agents-price-table small' }, [
                    el('thead', {}, [el('tr', {}, ['Model', 'Input', 'Output', ''].map((head) => el('th', { text: head, attrs: { scope: 'col' } })))]),
                    rows,
                ]),
            ]),
            add,
            error,
            el('div', { className: 'env-actions' }, [save]),
        ]);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const table = [...rows.querySelectorAll('tr')].map((row) => {
                const [model, input, output] = [...row.querySelectorAll('input')].map((node) => node.value.trim());
                return { model: model ?? '', inputPerMillion: Number(input || 0), outputPerMillion: Number(output || 0) };
            }).filter((price) => price.model !== '');
            save.disabled = true;
            error.hidden = true;
            api.savePrices(table).then((next) => {
                callbacks.onStatus('Saved the price table. New answers use it; past estimates stay as they were.');
                render(next);
            }, (failure: unknown) => {
                error.hidden = false;
                error.textContent = errorText(failure);
            }).finally(() => { save.disabled = false; });
        });
        return el('details', { className: 'agents-usage-group' }, [
            el('summary', { className: 'small', text: `Price table (${prices.length} model${prices.length === 1 ? '' : 's'})` }),
            form,
        ]);
    }

    return { element, refresh };
}
