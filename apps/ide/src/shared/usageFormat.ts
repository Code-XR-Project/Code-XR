import type { TokenUsage } from './agents.ts';

/**
 * How token usage and costs read everywhere (A13): the estimate from the
 * price table and the cost a provider reported are always two figures.
 */

/** Adds two usages, keeping estimated and reported costs apart. */
export function addUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
    const sum = (x: number | undefined, y: number | undefined): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
    const estimatedCost = sum(a?.estimatedCost, b.estimatedCost);
    const reportedCost = sum(a?.reportedCost, b.reportedCost);
    return {
        inputTokens: (a?.inputTokens ?? 0) + b.inputTokens,
        outputTokens: (a?.outputTokens ?? 0) + b.outputTokens,
        ...(estimatedCost !== undefined ? { estimatedCost } : {}),
        ...(reportedCost !== undefined ? { reportedCost } : {}),
    };
}

export function usd(value: number): string {
    if (value === 0) {
        return '$0';
    }
    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function tokens(value: number): string {
    return value >= 10_000 ? `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k` : String(value);
}

/** "1200 in / 80 out tokens · est. $0.0042 · reported $0.0040". */
export function formatUsage(usage: TokenUsage): string {
    return [
        `${tokens(usage.inputTokens)} in / ${tokens(usage.outputTokens)} out tokens`,
        ...(usage.estimatedCost !== undefined ? [`est. ${usd(usage.estimatedCost)}`] : []),
        ...(usage.reportedCost !== undefined ? [`reported ${usd(usage.reportedCost)}`] : []),
    ].join(' · ');
}
