/**
 * Per-function metrics and the checks built on them, shared by the Code-XR
 * IDE (its Problems panel, CodeLens and complexity strip, #173 and #178) and
 * the VS Code extension (the same warnings as diagnostics, the same lenses).
 *
 * Pure on purpose: no `vscode`, no Node, no imports at all, because the IDE
 * also loads it in its sandboxed renderer. Each app keeps only a thin
 * adapter that runs the backend's `functions` mode and draws the result.
 */

export type ProblemSeverity = 'error' | 'warning' | 'info';

/** Where a problem comes from, for the source filter. */
export type ProblemOrigin = 'editor' | 'metrics';

export interface Problem {
    /** Workspace-relative path, with forward slashes. */
    readonly path: string;
    readonly severity: ProblemSeverity;
    readonly message: string;
    /** Who reported it: a language ("typescript", "json") or "Code-XR". */
    readonly source: string;
    readonly origin: ProblemOrigin;
    readonly code?: string;
    /** 1-based, as Monaco counts. */
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
}

/** One function as the backend's functions mode reports it. */
export interface FunctionMetric {
    readonly name: string;
    readonly lineStart: number;
    readonly lineEnd: number;
    /** Lines of code (Lizard's NLOC). */
    readonly lineCount: number;
    readonly complexity: number;
    readonly parameters: number;
}

export interface FileFunctionMetrics {
    readonly path: string;
    readonly functions: readonly FunctionMetric[];
}

/** The latest metrics of a window's folder. */
export interface FunctionMetricsSnapshot {
    /** The folder they describe (absolute). */
    readonly root: string;
    readonly files: readonly FileFunctionMetrics[];
}

/** A limit of 0 turns that check off. */
export interface MetricThresholds {
    readonly complexity: number;
    readonly lines: number;
    readonly parameters: number;
}

export const METRICS_SOURCE = 'Code-XR';

/** Files the backend may report per run; a bigger answer is cut (the scan stops at 5,000 anyway). */
const MAX_FILES = 10000;
const MAX_FUNCTIONS_PER_FILE = 5000;

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** A report's relative path with forward slashes, or '' when it is missing or leaves the folder. */
function safeRelativePath(value: unknown): string {
    const path = typeof value === 'string' ? value.replace(/\\/g, '/') : '';
    const escapes = path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..');
    return escapes ? '' : path;
}

function parseFunction(item: unknown): FunctionMetric[] {
    if (!isRecord(item)) {
        return [];
    }
    const name = item['functionName'];
    const lineStart = Math.max(1, count(item['lineStart']));
    return [{
        name: typeof name === 'string' && name ? name.slice(0, 200) : 'function',
        lineStart,
        lineEnd: Math.max(lineStart, count(item['lineEnd'])),
        lineCount: count(item['lineCount']),
        complexity: count(item['complexity']),
        parameters: count(item['parameters']),
    }];
}

/**
 * The backend's functions-mode answer, validated: entries without a usable
 * relative path are dropped, numbers are whole and non-negative, and a path
 * may not climb out of the folder.
 */
export function parseFunctionMetrics(payload: unknown): FileFunctionMetrics[] {
    if (!Array.isArray(payload)) {
        return [];
    }
    const files: FileFunctionMetrics[] = [];
    for (const entry of payload.slice(0, MAX_FILES)) {
        const path = isRecord(entry) ? safeRelativePath(entry['relativePath']) : '';
        if (!isRecord(entry) || !path) {
            continue;
        }
        const functions = Array.isArray(entry['functions']) ? entry['functions'] : [];
        files.push({ path, functions: functions.slice(0, MAX_FUNCTIONS_PER_FILE).flatMap(parseFunction) });
    }
    return files;
}

/** Puts one file's fresh metrics in place of its old ones (a file with no functions left is dropped). */
export function mergeFileMetrics(files: readonly FileFunctionMetrics[], fresh: readonly FileFunctionMetrics[], removed: readonly string[] = []): FileFunctionMetrics[] {
    const replaced = new Set([...fresh.map((file) => file.path), ...removed]);
    return [...files.filter((file) => !replaced.has(file.path)), ...fresh.filter((file) => file.functions.length > 0)]
        .sort((a, b) => a.path.localeCompare(b.path));
}

/** The functions over a limit, as warnings on the function's first line. */
export function metricProblems(files: readonly FileFunctionMetrics[], thresholds: MetricThresholds): Problem[] {
    const problems: Problem[] = [];
    const warn = (path: string, fn: FunctionMetric, code: string, message: string): void => {
        problems.push({
            path, severity: 'warning', message, source: METRICS_SOURCE, origin: 'metrics', code,
            startLine: fn.lineStart, startColumn: 1, endLine: fn.lineStart, endColumn: 1,
        });
    };
    for (const file of files) {
        for (const fn of file.functions) {
            if (thresholds.complexity > 0 && fn.complexity > thresholds.complexity) {
                warn(file.path, fn, 'complexity', `'${fn.name}' has a cyclomatic complexity of ${fn.complexity} (limit ${thresholds.complexity}).`);
            }
            if (thresholds.lines > 0 && fn.lineCount > thresholds.lines) {
                warn(file.path, fn, 'function-length', `'${fn.name}' has ${fn.lineCount} lines of code (limit ${thresholds.lines}).`);
            }
            if (thresholds.parameters > 0 && fn.parameters > thresholds.parameters) {
                warn(file.path, fn, 'parameters', `'${fn.name}' takes ${fn.parameters} parameters (limit ${thresholds.parameters}).`);
            }
        }
    }
    return problems;
}

/**
 * #178: the scene's complexity bands, as the backend draws them
 * (`build_complexity_band` in backend/src/utils/xr_field_schema.py): over 25
 * is critical, over 10 is high. The editor's heat strip uses these, not the
 * Problems limit, so the editor and the scene agree on a function's colour.
 */
export type ComplexityBand = 'normal' | 'high' | 'critical';

export function complexityBand(complexity: number): ComplexityBand {
    return complexity > 25 ? 'critical' : complexity > 10 ? 'high' : 'normal';
}

/** #178: the lens over a function, "CCN 7 · NLOC 42 · 3 params", each value over its limit marked. */
export function metricLensTitle(fn: FunctionMetric, thresholds: MetricThresholds): { readonly title: string; readonly over: boolean } {
    const part = (label: string, value: number, limit: number, unit = ''): { text: string; over: boolean } => {
        const over = limit > 0 && value > limit;
        return { text: `${label}${value}${unit}${over ? ` > ${limit}` : ''}`, over };
    };
    const parts = [
        part('CCN ', fn.complexity, thresholds.complexity),
        part('NLOC ', fn.lineCount, thresholds.lines),
        part('', fn.parameters, thresholds.parameters, fn.parameters === 1 ? ' param' : ' params'),
    ];
    const over = parts.some((p) => p.over);
    return { title: `${over ? '$(warning) ' : ''}${parts.map((p) => p.text).join(' · ')}`, over };
}
