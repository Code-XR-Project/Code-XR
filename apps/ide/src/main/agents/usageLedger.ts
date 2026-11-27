import type { BudgetSettings, ModelPrice, TokenUsage, UsageGroup, UsageSummary } from '../../shared/agents.ts';
import type { JsonKeyValueStore } from '../core/jsonStore.ts';
import { usd } from '../../shared/usageFormat.ts';

/**
 * Usage, cost and limits (A13): every model call is recorded here with its
 * agent, provider, model, tokens, the estimate from the person's price table
 * and the cost the provider reported, if any. The month's totals feed the
 * Usage section, and the budget is checked before every model call.
 *
 * Estimated and reported costs are kept apart everywhere. The budget alone
 * needs one number, so it counts each call once: its reported cost, or its
 * estimate when the provider reported nothing; that figure is labelled as
 * the budget's own.
 */

const PRICES = 'prices';
const BUDGET = 'budget';
/** Calls kept per month; past that the oldest are folded into one carry-over row. */
const MAX_CALLS_PER_MONTH = 20_000;
const MAX_PRICES = 200;
const DEFAULT_BUDGET: BudgetSettings = { monthlyUsd: 0, warnAt: 0.8, hardStop: false };

export interface UsageCall {
    readonly at: string;
    readonly agent: string;
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCost?: number;
    readonly reportedCost?: number;
    /** A carry-over row standing for this many folded calls. */
    readonly calls?: number;
}

export class BudgetReachedError extends Error {}

export class UsageLedger {
    private readonly store: JsonKeyValueStore;
    private readonly now: () => Date;

    constructor(store: JsonKeyValueStore, now: () => Date = () => new Date()) {
        this.store = store;
        this.now = now;
    }

    prices(): readonly ModelPrice[] {
        const value = this.store.get<unknown>(PRICES, []);
        return Array.isArray(value) ? value.filter(isPrice) : [];
    }

    budget(): BudgetSettings {
        const value = this.store.get<unknown>(BUDGET);
        return isBudget(value) ? value : DEFAULT_BUDGET;
    }

    async savePrices(input: unknown): Promise<UsageSummary> {
        if (!Array.isArray(input) || input.length > MAX_PRICES) {
            throw new Error('Invalid price table.');
        }
        const prices = input.map(parsePrice);
        const seen = new Set<string>();
        for (const price of prices) {
            if (seen.has(price.model)) {
                throw new Error(`${price.model} is in the table twice.`);
            }
            seen.add(price.model);
        }
        await this.store.update(PRICES, prices);
        return this.summary();
    }

    async saveBudget(input: unknown): Promise<UsageSummary> {
        if (!input || typeof input !== 'object') {
            throw new Error('Invalid budget.');
        }
        const record = input as Record<string, unknown>;
        const monthlyUsd = Number(record['monthlyUsd']);
        const warnAt = Number(record['warnAt']);
        if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0 || monthlyUsd > 1_000_000) {
            throw new Error('The monthly budget must be a number of dollars, 0 for none.');
        }
        if (!Number.isFinite(warnAt) || warnAt < 0.1 || warnAt > 1) {
            throw new Error('Warn at must be between 10% and 100%.');
        }
        await this.store.update(BUDGET, { monthlyUsd, warnAt, hardStop: record['hardStop'] === true });
        return this.summary();
    }

    /** Tokens times the price table, or undefined when the model has no price. */
    estimate(model: string, inputTokens: number, outputTokens: number): number | undefined {
        const price = priceFor(this.prices(), model);
        return price ? (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000 : undefined;
    }

    /** Records one model call; returns its usage with the estimate filled in. */
    async record(call: { readonly agent: string; readonly provider: string; readonly model: string; readonly inputTokens: number; readonly outputTokens: number; readonly reportedCost?: number }): Promise<TokenUsage> {
        const estimatedCost = this.estimate(call.model, call.inputTokens, call.outputTokens);
        const row: UsageCall = {
            at: this.now().toISOString(),
            agent: call.agent,
            provider: call.provider,
            model: call.model,
            inputTokens: call.inputTokens,
            outputTokens: call.outputTokens,
            ...(estimatedCost !== undefined ? { estimatedCost } : {}),
            ...(call.reportedCost !== undefined ? { reportedCost: call.reportedCost } : {}),
        };
        const key = monthKey(this.now());
        let calls = [...this.calls(key), row];
        if (calls.length > MAX_CALLS_PER_MONTH) {
            calls = fold(calls, calls.length - MAX_CALLS_PER_MONTH + 1);
        }
        await this.store.update(key, calls);
        return {
            inputTokens: call.inputTokens,
            outputTokens: call.outputTokens,
            ...(estimatedCost !== undefined ? { estimatedCost } : {}),
            ...(call.reportedCost !== undefined ? { reportedCost: call.reportedCost } : {}),
        };
    }

    /** Throws before a model call when the budget is spent and set to stop. */
    assertWithinBudget(): void {
        const budget = this.budget();
        if (budget.monthlyUsd <= 0 || !budget.hardStop) {
            return;
        }
        const spent = budgetSpend(this.calls(monthKey(this.now())));
        if (spent >= budget.monthlyUsd) {
            throw new BudgetReachedError(`The monthly budget of ${usd(budget.monthlyUsd)} is reached (${usd(spent)} this month). Raise it in Agents > Usage and budget to keep chatting.`);
        }
    }

    summary(): UsageSummary {
        const month = monthKey(this.now());
        const calls = this.calls(month);
        const budget = this.budget();
        const spend = budgetSpend(calls);
        const state: UsageSummary['budgetState'] = budget.monthlyUsd <= 0 ? 'none'
            : spend >= budget.monthlyUsd ? 'reached'
                : spend >= budget.monthlyUsd * budget.warnAt ? 'warning' : 'ok';
        return {
            month: month.slice('month:'.length),
            total: group('Total', calls),
            byAgent: groupBy(calls, (call) => call.agent),
            byProvider: groupBy(calls, (call) => call.provider),
            byModel: groupBy(calls, (call) => call.model),
            prices: this.prices(),
            budget,
            budgetSpend: spend,
            budgetState: state,
        };
    }

    private calls(key: string): readonly UsageCall[] {
        const value = this.store.get<unknown>(key, []);
        return Array.isArray(value) ? value.filter(isCall) : [];
    }
}

/** The store key of a month, in local time ("month:2026-11"). */
export function monthKey(date: Date): string {
    return `month:${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** The longest matching row: an exact id first, then the longest `prefix*`. */
export function priceFor(prices: readonly ModelPrice[], model: string): ModelPrice | undefined {
    const exact = prices.find((price) => price.model === model);
    if (exact) {
        return exact;
    }
    return prices
        .filter((price) => price.model.endsWith('*') && model.startsWith(price.model.slice(0, -1)))
        .sort((a, b) => b.model.length - a.model.length)[0];
}


function budgetSpend(calls: readonly UsageCall[]): number {
    return calls.reduce((sum, call) => sum + (call.reportedCost ?? call.estimatedCost ?? 0), 0);
}

function group(name: string, calls: readonly UsageCall[]): UsageGroup {
    let result: UsageGroup = { name, calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, reportedCost: 0, unpricedCalls: 0 };
    for (const call of calls) {
        result = {
            name,
            calls: result.calls + (call.calls ?? 1),
            inputTokens: result.inputTokens + call.inputTokens,
            outputTokens: result.outputTokens + call.outputTokens,
            estimatedCost: result.estimatedCost + (call.estimatedCost ?? 0),
            reportedCost: result.reportedCost + (call.reportedCost ?? 0),
            unpricedCalls: result.unpricedCalls + (call.estimatedCost === undefined && call.reportedCost === undefined ? call.calls ?? 1 : 0),
        };
    }
    return result;
}

function groupBy(calls: readonly UsageCall[], key: (call: UsageCall) => string): readonly UsageGroup[] {
    const groups = new Map<string, UsageCall[]>();
    for (const call of calls) {
        const name = key(call);
        groups.set(name, [...(groups.get(name) ?? []), call]);
    }
    return [...groups].map(([name, members]) => group(name, members))
        .sort((a, b) => (b.reportedCost + b.estimatedCost) - (a.reportedCost + a.estimatedCost) || (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
}

/** Folds the oldest `count` calls into carry-over rows, one per agent/provider/model. */
function fold(calls: readonly UsageCall[], count: number): UsageCall[] {
    const old = calls.slice(0, count);
    const rows = new Map<string, UsageCall>();
    for (const call of old) {
        const key = `${call.agent}\u0000${call.provider}\u0000${call.model}`;
        const previous = rows.get(key);
        const sum = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
        const estimatedCost = sum(previous?.estimatedCost, call.estimatedCost);
        const reportedCost = sum(previous?.reportedCost, call.reportedCost);
        rows.set(key, {
            at: call.at,
            agent: call.agent,
            provider: call.provider,
            model: call.model,
            inputTokens: (previous?.inputTokens ?? 0) + call.inputTokens,
            outputTokens: (previous?.outputTokens ?? 0) + call.outputTokens,
            ...(estimatedCost !== undefined ? { estimatedCost } : {}),
            ...(reportedCost !== undefined ? { reportedCost } : {}),
            calls: (previous?.calls ?? 0) + (call.calls ?? 1),
        });
    }
    return [...rows.values(), ...calls.slice(count)];
}

function parsePrice(value: unknown): ModelPrice {
    if (!value || typeof value !== 'object') {
        throw new Error('Invalid price row.');
    }
    const record = value as Record<string, unknown>;
    const model = typeof record['model'] === 'string' ? record['model'].trim() : '';
    const inputPerMillion = Number(record['inputPerMillion']);
    const outputPerMillion = Number(record['outputPerMillion']);
    if (!model || model.length > 200) {
        throw new Error('Each price needs a model id.');
    }
    if (![inputPerMillion, outputPerMillion].every((price) => Number.isFinite(price) && price >= 0 && price <= 10_000)) {
        throw new Error(`Prices for ${model} must be dollars per million tokens.`);
    }
    return { model, inputPerMillion, outputPerMillion };
}

function isPrice(value: unknown): value is ModelPrice {
    try {
        parsePrice(value);
        return true;
    } catch {
        return false;
    }
}

function isBudget(value: unknown): value is BudgetSettings {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record['monthlyUsd'] === 'number' && typeof record['warnAt'] === 'number' && typeof record['hardStop'] === 'boolean';
}

function isCall(value: unknown): value is UsageCall {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record['agent'] === 'string' && typeof record['provider'] === 'string' && typeof record['model'] === 'string'
        && typeof record['inputTokens'] === 'number' && typeof record['outputTokens'] === 'number';
}
