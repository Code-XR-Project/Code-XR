/**
 * The Problems panel (#173): its filtering, grouping and counts. What a
 * problem is, the metric thresholds that turn a function into one and the
 * editor lens titles live in the extension's core
 * (core/metrics/functionMetrics.ts), shared with the VS Code extension.
 * Pure, unit-tested in Node.
 */

import type { Problem, ProblemOrigin, ProblemSeverity } from '@codexr/core/metrics/functionMetrics';

export {
    complexityBand, mergeFileMetrics, metricLensTitle, metricProblems, parseFunctionMetrics, METRICS_SOURCE,
} from '@codexr/core/metrics/functionMetrics';
export type {
    ComplexityBand, FileFunctionMetrics, FunctionMetric, FunctionMetricsSnapshot, MetricThresholds, Problem, ProblemOrigin, ProblemSeverity,
} from '@codexr/core/metrics/functionMetrics';

export const PROBLEM_SEVERITIES: readonly ProblemSeverity[] = ['error', 'warning', 'info'];

export interface ProblemFilter {
    /** Words that must all appear in the message, the path, the source or the code; "!word" excludes. */
    readonly text: string;
    readonly severities: ReadonlySet<ProblemSeverity>;
    readonly origin: ProblemOrigin | 'all';
}

export function filterProblems(problems: readonly Problem[], filter: ProblemFilter): Problem[] {
    const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean);
    const include = words.filter((word) => !word.startsWith('!'));
    const exclude = words.filter((word) => word.startsWith('!') && word.length > 1).map((word) => word.slice(1));
    return problems.filter((problem) => {
        if (!filter.severities.has(problem.severity) || (filter.origin !== 'all' && problem.origin !== filter.origin)) {
            return false;
        }
        const haystack = `${problem.message} ${problem.path} ${problem.source} ${problem.code ?? ''}`.toLowerCase();
        return include.every((word) => haystack.includes(word)) && !exclude.some((word) => haystack.includes(word));
    });
}

const SEVERITY_ORDER: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

export interface ProblemGroup {
    readonly path: string;
    readonly problems: readonly Problem[];
}

/** By file (the files in path order), each file's problems by severity, then position. */
export function groupProblems(problems: readonly Problem[]): ProblemGroup[] {
    const groups = new Map<string, Problem[]>();
    for (const problem of problems) {
        const list = groups.get(problem.path) ?? [];
        list.push(problem);
        groups.set(problem.path, list);
    }
    return [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, list]) => ({
            path,
            problems: list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.startLine - b.startLine || a.startColumn - b.startColumn),
        }));
}

export function problemCounts(problems: readonly Problem[]): Record<ProblemSeverity, number> {
    const counts: Record<ProblemSeverity, number> = { error: 0, warning: 0, info: 0 };
    for (const problem of problems) {
        counts[problem.severity]++;
    }
    return counts;
}
