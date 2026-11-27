import type { MetricChangeView, TurnMetricDeltaView } from '../../shared/agentSession.ts';
import { normalize, type FileMetrics } from '../agents/tools/analysisQueries.ts';

/**
 * What one agent turn did to the project's measurements (AF9, #274): the
 * metric records of the analysis before the turn and after it, compared file
 * by file for the paths the turn changed, plus project totals. Pure: the
 * records come from `readMetrics` (an XR analysis' `data.json`, one record per
 * analysed file, paths relative to the analysed folder).
 */

/** The metrics a delta reports per file: size, structure and complexity. */
export const DELTA_METRICS = [
    'codeLines', 'totalLines', 'functionCount', 'classCount',
    'maxComplexity', 'cyclomaticComplexityNumber', 'highComplexityFunctions', 'criticalComplexityFunctions',
    'maxCognitiveComplexity', 'averageMaintainabilityIndex',
] as const;

export type DeltaMetric = typeof DELTA_METRICS[number];

export interface MetricChange {
    readonly before: number | null;
    readonly after: number | null;
    /** `after - before`, a missing side counting as 0 (a new file adds all its lines). */
    readonly delta: number;
}

/**
 * - `added` / `removed`: the analysis gained or lost the file;
 * - `changed` / `unchanged`: in both, with or without a metric change;
 * - `not-analysed`: a changed path the analysis never measured (a README, a
 *   language it does not cover, an ignored folder).
 */
export type FileDeltaStatus = 'added' | 'removed' | 'changed' | 'unchanged' | 'not-analysed';

export interface FileMetricDelta {
    readonly path: string;
    readonly status: FileDeltaStatus;
    readonly language?: string;
    /** Only the metrics that moved (every present one for an added or removed file). */
    readonly metrics: Partial<Record<DeltaMetric, MetricChange>>;
}

export interface MetricTotals {
    readonly files: number;
    readonly codeLines: number;
    readonly totalLines: number;
    readonly functionCount: number;
    readonly classCount: number;
    readonly highComplexityFunctions: number;
    readonly criticalComplexityFunctions: number;
    /** The highest `maxComplexity` of any file, or null when no record has one. */
    readonly maxComplexity: number | null;
    /** The mean of the files' mean complexity (`cyclomaticComplexityNumber`), or null. */
    readonly avgComplexity: number | null;
}

/**
 * - `ok`: both analyses were readable;
 * - `no-baseline`: there was no analysis before the turn (only `totals.after`);
 * - `no-analysis`: there is no analysis after it (nothing to compare).
 */
export type MetricDeltaStatus = 'ok' | 'no-baseline' | 'no-analysis';

export interface MetricDeltaReport {
    readonly status: MetricDeltaStatus;
    readonly files: readonly FileMetricDelta[];
    readonly totals: {
        readonly before: MetricTotals | null;
        readonly after: MetricTotals | null;
        /** after - before for each total both sides have; empty unless `ok`. */
        readonly delta: Partial<Record<keyof MetricTotals, number>>;
    };
    /** One line for a chat or a header: what moved, or that nothing did. */
    readonly summary: string;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function numeric(record: FileMetrics | undefined, metric: string): number | null {
    const value = record?.[metric];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function byPath(records: readonly FileMetrics[]): Map<string, FileMetrics> {
    return new Map(records.map((record) => [normalize(record.relativePath), record]));
}

export function metricTotals(records: readonly FileMetrics[]): MetricTotals {
    const sum = (metric: string): number => round(records.reduce((total, record) => total + (numeric(record, metric) ?? 0), 0));
    const values = (metric: string): number[] => records.map((record) => numeric(record, metric)).filter((value): value is number => value !== null);
    const maxima = values('maxComplexity');
    const means = values('cyclomaticComplexityNumber');
    return {
        files: records.length,
        codeLines: sum('codeLines'),
        totalLines: sum('totalLines'),
        functionCount: sum('functionCount'),
        classCount: sum('classCount'),
        highComplexityFunctions: sum('highComplexityFunctions'),
        criticalComplexityFunctions: sum('criticalComplexityFunctions'),
        maxComplexity: maxima.length > 0 ? Math.max(...maxima) : null,
        avgComplexity: means.length > 0 ? round(means.reduce((a, b) => a + b, 0) / means.length) : null,
    };
}

function fileDelta(file: string, before: FileMetrics | undefined, after: FileMetrics | undefined): FileMetricDelta {
    const metrics: Partial<Record<DeltaMetric, MetricChange>> = {};
    for (const metric of DELTA_METRICS) {
        const was = numeric(before, metric);
        const now = numeric(after, metric);
        if ((was === null && now === null) || (before && after && was === now)) {
            continue;
        }
        metrics[metric] = { before: was, after: now, delta: round((now ?? 0) - (was ?? 0)) };
    }
    const status: FileDeltaStatus = !before ? 'added' : !after ? 'removed' : Object.keys(metrics).length > 0 ? 'changed' : 'unchanged';
    const language = after?.language ?? before?.language;
    return language === undefined ? { path: file, status, metrics } : { path: file, status, language, metrics };
}

/** The record paths a changed path stands for: the file itself, or every analysed file under a changed folder. */
function expand(changed: string, before: Map<string, FileMetrics>, after: Map<string, FileMetrics>): string[] {
    if (before.has(changed) || after.has(changed)) {
        return [changed];
    }
    const prefix = `${changed}/`;
    const inside = new Set([...before.keys(), ...after.keys()].filter((file) => changed !== '' && file.startsWith(prefix)));
    return [...inside].sort();
}

function sameRecord(a: FileMetrics, b: FileMetrics): boolean {
    return DELTA_METRICS.every((metric) => numeric(a, metric) === numeric(b, metric));
}

function totalsDelta(before: MetricTotals, after: MetricTotals): Partial<Record<keyof MetricTotals, number>> {
    const delta: Partial<Record<keyof MetricTotals, number>> = {};
    for (const key of Object.keys(after) as (keyof MetricTotals)[]) {
        const was = before[key];
        const now = after[key];
        if (was !== null && now !== null) {
            delta[key] = round(now - was);
        }
    }
    return delta;
}

const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));

function describe(files: readonly FileMetricDelta[], before: MetricTotals, after: MetricTotals, delta: Partial<Record<keyof MetricTotals, number>>): string {
    const count = (status: FileDeltaStatus): number => files.filter((file) => file.status === status).length;
    const moved = files.filter((file) => file.status !== 'unchanged' && file.status !== 'not-analysed');
    const parts: string[] = [];
    if (delta.codeLines) {
        parts.push(`code lines ${signed(delta.codeLines)} (${before.codeLines} -> ${after.codeLines})`);
    }
    if (delta.functionCount) {
        parts.push(`functions ${signed(delta.functionCount)}`);
    }
    if (before.maxComplexity !== after.maxComplexity) {
        parts.push(`max complexity ${before.maxComplexity ?? '-'} -> ${after.maxComplexity ?? '-'}`);
    }
    if (before.avgComplexity !== after.avgComplexity) {
        parts.push(`avg complexity ${before.avgComplexity ?? '-'} -> ${after.avgComplexity ?? '-'}`);
    }
    if (delta.highComplexityFunctions) {
        parts.push(`high-complexity functions ${signed(delta.highComplexityFunctions)}`);
    }
    if (delta.criticalComplexityFunctions) {
        parts.push(`critical functions ${signed(delta.criticalComplexityFunctions)}`);
    }
    if (moved.length === 0 && parts.length === 0) {
        return 'No metric changes.';
    }
    const kinds = (['added', 'removed', 'changed'] as const).filter((status) => count(status) > 0).map((status) => `${count(status)} ${status}`);
    const head = `${moved.length} ${moved.length === 1 ? 'file' : 'files'}${kinds.length > 0 ? ` (${kinds.join(', ')})` : ''}`;
    return parts.length > 0 ? `${head}: ${parts.join(', ')}` : head;
}

/**
 * Compares two analyses. `changedPaths` (relative to the analysed folder, a
 * folder standing for every file under it) limits the per-file list to what
 * the turn touched, so a touched file whose metrics did not move is listed as
 * `unchanged`; without it every file whose metrics differ is listed. The
 * totals always cover the whole project.
 */
export function computeMetricDelta(
    before: readonly FileMetrics[] | null | undefined,
    after: readonly FileMetrics[] | null | undefined,
    changedPaths?: readonly string[] | null,
): MetricDeltaReport {
    if (!after) {
        return { status: 'no-analysis', files: [], totals: { before: before ? metricTotals(before) : null, after: null, delta: {} }, summary: 'No analysis to measure the change with.' };
    }
    const afterTotals = metricTotals(after);
    if (!before) {
        return { status: 'no-baseline', files: [], totals: { before: null, after: afterTotals, delta: {} }, summary: `No analysis before the turn; the project now has ${afterTotals.files} analysed files.` };
    }
    const was = byPath(before);
    const now = byPath(after);
    const files: FileMetricDelta[] = [];
    if (changedPaths) {
        const seen = new Set<string>();
        for (const changed of [...new Set(changedPaths.map((file) => normalize(file)))].sort()) {
            const covered = expand(changed, was, now);
            if (covered.length === 0) {
                if (changed) {
                    files.push({ path: changed, status: 'not-analysed', metrics: {} });
                }
                continue;
            }
            for (const file of covered.filter((candidate) => !seen.has(candidate))) {
                seen.add(file);
                files.push(fileDelta(file, was.get(file), now.get(file)));
            }
        }
    } else {
        for (const file of [...new Set([...was.keys(), ...now.keys()])].sort()) {
            const a = was.get(file);
            const b = now.get(file);
            if (!a || !b || !sameRecord(a, b)) {
                files.push(fileDelta(file, a, b));
            }
        }
    }
    const beforeTotals = metricTotals(before);
    const delta = totalsDelta(beforeTotals, afterTotals);
    return { status: 'ok', files, totals: { before: beforeTotals, after: afterTotals, delta }, summary: describe(files, beforeTotals, afterTotals, delta) };
}

/** The report as text for an agent or a log: the summary, then one line per file. */
export function formatMetricDelta(report: MetricDeltaReport): string {
    const lines = [report.summary];
    for (const file of report.files) {
        const changes = Object.entries(file.metrics).map(([metric, change]) => `${metric} ${change.before ?? '-'} -> ${change.after ?? '-'} (${signed(change.delta)})`);
        lines.push(`- ${file.path} [${file.status}]${changes.length > 0 ? `: ${changes.join(', ')}` : ''}`);
    }
    return lines.join('\n');
}

/** The project totals a chat shows, in the order it shows them. */
const VIEW_TOTALS: readonly (keyof MetricTotals)[] = [
    'maxComplexity', 'avgComplexity', 'codeLines', 'functionCount', 'classCount', 'highComplexityFunctions', 'criticalComplexityFunctions', 'files',
];

/**
 * AF9: the report as the chat keeps it on a turn: serialisable, only what
 * moved, at most `maxFiles` files. Null when there is nothing to show (no
 * analysis on either side, or no metric moved), so a chat without a scene
 * stays quiet.
 */
export function toTurnMetricDeltaView(report: MetricDeltaReport, maxFiles = 30): TurnMetricDeltaView | null {
    const { before, after } = report.totals;
    if (report.status !== 'ok' || !before || !after) {
        return null;
    }
    const totals: MetricChangeView[] = VIEW_TOTALS.filter((key) => before[key] !== after[key]).map((key) => ({ metric: key, before: before[key], after: after[key] }));
    const moved = report.files.filter((file) => file.status === 'added' || file.status === 'removed' || file.status === 'changed');
    if (totals.length === 0 && moved.length === 0) {
        return null;
    }
    const files = moved.slice(0, maxFiles).map((file) => ({
        path: file.path,
        status: file.status,
        changes: Object.entries(file.metrics).map(([metric, change]) => ({ metric, before: change.before, after: change.after })),
    }));
    return { summary: report.summary, totals, files, moreFiles: moved.length - files.length };
}
