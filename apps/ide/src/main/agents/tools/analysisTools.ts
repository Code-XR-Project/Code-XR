import fs from 'node:fs';
import path from 'node:path';
import { clip, numberArg, stringArg, type AgentTool, type ToolContext } from './toolTypes.ts';

/**
 * Code-XR's analyses as agent tools (A10). They read what the window's XR
 * analysis already produced, in the scene's static folder, and never start
 * an analysis or download anything:
 * - `data.json`: one metrics record per analysed file;
 * - `dependency-graph.json`: the graph, once the scene's dependency mode ran;
 * - `evolution/revision-N/`: the frames of the last project-evolution movie.
 * This is the bridge to the thesis' prediction work: an agent reasons over
 * the same measurements the person sees in XR.
 */

export interface FileMetrics {
    readonly relativePath: string;
    readonly language?: string;
    readonly [metric: string]: unknown;
}

/** The metrics agents are pointed at first (all of a record's numeric fields stay available). */
export const KEY_METRICS = [
    'totalLines', 'codeLines', 'commentRatio', 'functionCount', 'classCount',
    'maxComplexity', 'cyclomaticComplexityNumber', 'highComplexityFunctions', 'criticalComplexityFunctions',
    'maxFunctionLines', 'averageFunctionLines', 'maxFunctionParameters', 'averageFunctionNestingDepth',
] as const;

const MAX_JSON_BYTES = 64 * 1024 * 1024;

const NO_ANALYSIS = 'No Code-XR analysis is open in this window. Ask the person to run "Analyse Project (XR)" from the Analysis view first; agents cannot start one.';

async function readJson(file: string): Promise<unknown> {
    const stat = await fs.promises.stat(file);
    if (stat.size > MAX_JSON_BYTES) {
        throw new Error(`${path.basename(file)} is too large to read.`);
    }
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as unknown;
}

function recordsOf(data: unknown): FileMetrics[] {
    return Array.isArray(data)
        ? data.filter((item): item is FileMetrics => !!item && typeof item === 'object' && typeof (item as Record<string, unknown>)['relativePath'] === 'string')
            .map((item) => ({ ...item, relativePath: item.relativePath.replace(/\\/g, '/') }))
        : [];
}

const normalize = (value: string | undefined): string => (value ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');

function inScope(file: string, scope: string): boolean {
    return !scope || file === scope || file.startsWith(`${scope}/`);
}

function numeric(record: FileMetrics, metric: string): number | null {
    const value = record[metric];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** Totals and averages over `records`: what "how big / how complex is this folder" asks. */
export function summarize(records: readonly FileMetrics[]): Record<string, number> {
    const summary: Record<string, number> = { files: records.length };
    for (const metric of KEY_METRICS) {
        const values = records.map((record) => numeric(record, metric)).filter((value): value is number => value !== null);
        if (values.length === 0) {
            continue;
        }
        const sum = values.reduce((a, b) => a + b, 0);
        if (/Ratio|average|cyclomaticComplexityNumber/.test(metric)) {
            summary[`avg ${metric}`] = round(sum / values.length);
        } else {
            summary[`total ${metric}`] = round(sum);
            summary[`max ${metric}`] = Math.max(...values);
        }
    }
    return summary;
}

function formatRecord(record: FileMetrics): string {
    const parts = KEY_METRICS.map((metric) => [metric, numeric(record, metric)] as const)
        .filter(([, value]) => value !== null)
        .map(([metric, value]) => `${metric}=${value}`);
    return `${record.relativePath}${record.language ? ` (${record.language})` : ''}: ${parts.join(', ')}`;
}

function formatSummary(summary: Record<string, number>): string {
    return Object.entries(summary).map(([key, value]) => `${key}: ${value}`).join('\n');
}

export function metricsReport(records: readonly FileMetrics[], scopeArg: string | undefined): string {
    const scope = normalize(scopeArg);
    const exact = records.find((record) => record.relativePath === scope);
    if (exact) {
        return formatRecord(exact);
    }
    const inside = records.filter((record) => inScope(record.relativePath, scope));
    if (inside.length === 0) {
        throw new Error(`The analysis has no file at or under "${scope}". Paths are relative to the project root.`);
    }
    const byLanguage = new Map<string, number>();
    for (const record of inside) {
        byLanguage.set(record.language ?? 'unknown', (byLanguage.get(record.language ?? 'unknown') ?? 0) + 1);
    }
    return [
        `${scope || 'Whole project'}: ${inside.length} analysed files`,
        `languages: ${[...byLanguage].sort((a, b) => b[1] - a[1]).map(([language, count]) => `${language} ${count}`).join(', ')}`,
        formatSummary(summarize(inside)),
    ].join('\n');
}

export function hotspotsReport(records: readonly FileMetrics[], metric: string, limit: number, scopeArg: string | undefined): string {
    const scope = normalize(scopeArg);
    const ranked = records
        .filter((record) => inScope(record.relativePath, scope))
        .map((record) => ({ record, value: numeric(record, metric) }))
        .filter((entry): entry is { record: FileMetrics; value: number } => entry.value !== null)
        .sort((a, b) => b.value - a.value)
        .slice(0, limit);
    if (ranked.length === 0) {
        const known = Object.keys(records[0] ?? {}).filter((key) => typeof records[0]?.[key] === 'number');
        throw new Error(`No file has the metric "${metric}". Known metrics: ${known.join(', ')}.`);
    }
    return [`Top ${ranked.length} files by ${metric}${scope ? ` under ${scope}` : ''}:`, ...ranked.map(({ record, value }, index) => `${index + 1}. ${record.relativePath}: ${metric}=${value} | ${formatRecord(record).split(': ').slice(1).join(': ')}`)].join('\n');
}

interface GraphNode { readonly id: string; readonly relativePath?: string; readonly label?: string; readonly external?: boolean; readonly metrics?: Record<string, number> }
interface GraphEdge { readonly source: string; readonly target: string; readonly kind?: string; readonly occurrences?: number }

export function dependenciesReport(graph: unknown, fileArg: string | undefined, limit: number): string {
    const record = (graph && typeof graph === 'object' ? graph : {}) as { nodes?: GraphNode[]; edges?: GraphEdge[] };
    const nodes = Array.isArray(record.nodes) ? record.nodes : [];
    const edges = Array.isArray(record.edges) ? record.edges : [];
    const nameOf = (id: string): string => {
        const node = nodes.find((candidate) => candidate.id === id);
        return node?.relativePath ?? node?.label ?? id;
    };
    const file = normalize(fileArg);
    if (!file) {
        const ranked = nodes.filter((node) => !node.external && node.metrics)
            .sort((a, b) => (b.metrics?.['degree'] ?? 0) - (a.metrics?.['degree'] ?? 0))
            .slice(0, limit);
        const cycles = nodes.filter((node) => (node.metrics?.['cycleSize'] ?? 0) > 1).map((node) => node.relativePath ?? node.label);
        return [
            `${nodes.length} nodes, ${edges.length} edges.`,
            `Most connected (fanIn/fanOut):`,
            ...ranked.map((node) => `- ${node.relativePath ?? node.label}: fanIn=${node.metrics?.['fanIn'] ?? 0}, fanOut=${node.metrics?.['fanOut'] ?? 0}`),
            cycles.length > 0 ? `In dependency cycles: ${cycles.slice(0, limit).join(', ')}${cycles.length > limit ? ` and ${cycles.length - limit} more` : ''}` : 'No dependency cycles.',
        ].join('\n');
    }
    const node = nodes.find((candidate) => normalize(candidate.relativePath) === file);
    if (!node) {
        throw new Error(`"${file}" is not in the dependency graph.`);
    }
    const describe = (list: readonly GraphEdge[], end: 'source' | 'target'): string[] => {
        const grouped = new Map<string, string[]>();
        for (const edge of list) {
            const other = nameOf(edge[end]);
            grouped.set(other, [...(grouped.get(other) ?? []), edge.kind ?? 'uses']);
        }
        return [...grouped].slice(0, limit).map(([other, kinds]) => `- ${other} (${[...new Set(kinds)].join(', ')})`);
    };
    const outgoing = edges.filter((edge) => edge.source === node.id);
    const incoming = edges.filter((edge) => edge.target === node.id);
    return [
        `${file}: ${Object.entries(node.metrics ?? {}).map(([key, value]) => `${key}=${value}`).join(', ')}`,
        `Depends on (${outgoing.length}):`, ...describe(outgoing, 'target'),
        `Used by (${incoming.length}):`, ...describe(incoming, 'source'),
    ].join('\n');
}

interface EvolutionFrame { readonly label?: string; readonly date?: string; readonly url?: string }

export function evolutionReport(frames: readonly { frame: EvolutionFrame; records: readonly FileMetrics[] }[], fileArg: string | undefined, metric: string): string {
    const file = normalize(fileArg);
    const lines = frames.map(({ frame, records }) => {
        const when = [frame.date, frame.label].filter(Boolean).join(' ');
        if (file) {
            const inside = records.filter((record) => inScope(record.relativePath, file));
            if (inside.length === 0) {
                return `- ${when}: (not present)`;
            }
            const values = inside.map((record) => numeric(record, metric)).filter((value): value is number => value !== null);
            const total = values.reduce((a, b) => a + b, 0);
            return `- ${when}: ${metric}=${round(inside.length === 1 ? total : total)}${inside.length > 1 ? ` over ${inside.length} files` : ''}`;
        }
        const summary = summarize(records);
        return `- ${when}: files=${summary['files']}, codeLines=${summary['total codeLines'] ?? '?'}, avg complexity=${summary['avg cyclomaticComplexityNumber'] ?? '?'}, max complexity=${summary['max maxComplexity'] ?? '?'}`;
    });
    return [`Project evolution, ${frames.length} snapshots (oldest first)${file ? ` for ${file}` : ''}:`, ...lines].join('\n');
}

/** The last project-evolution movie under `root`, oldest frame first. */
async function readEvolution(root: string): Promise<{ frame: EvolutionFrame; records: FileMetrics[] }[] | null> {
    const dir = path.join(root, 'evolution');
    let revisions: number[];
    try {
        revisions = (await fs.promises.readdir(dir)).map((name) => /^revision-(\d+)$/.exec(name)?.[1]).filter((value): value is string => !!value).map(Number);
    } catch {
        return null;
    }
    const latest = Math.max(...revisions);
    if (!Number.isFinite(latest)) {
        return null;
    }
    const manifest = (await readJson(path.join(dir, `revision-${latest}`, 'manifest.json'))) as { frames?: EvolutionFrame[] };
    const frames = Array.isArray(manifest.frames) ? manifest.frames : [];
    const out: { frame: EvolutionFrame; records: FileMetrics[] }[] = [];
    for (const [index, frame] of frames.entries()) {
        const name = path.basename(frame.url ?? `data${index + 1}.json`);
        if (!/^data\d+\.json$/.test(name)) {
            continue;
        }
        out.push({ frame, records: recordsOf(await readJson(path.join(dir, `revision-${latest}`, name))) });
    }
    return out;
}

function outputRoot(context: ToolContext): string {
    if (!context.workspace) {
        throw new Error('No folder is open in the IDE.');
    }
    const root = context.analysisOutput?.() ?? null;
    if (!root) {
        throw new Error(NO_ANALYSIS);
    }
    return root;
}

async function readMetrics(root: string): Promise<FileMetrics[]> {
    try {
        return recordsOf(await readJson(path.join(root, 'data.json')));
    } catch {
        throw new Error(NO_ANALYSIS);
    }
}

const metricDescription = `Metric name, e.g. ${KEY_METRICS.slice(0, 7).join(', ')}.`;

export const ANALYSIS_TOOLS: readonly AgentTool[] = analysisTools();

function analysisTools(): AgentTool[] {
    return [
        {
            name: 'get_metrics',
            title: 'Read Code-XR metrics',
            description: 'Code-XR metrics (lines, functions, complexity, parameters, nesting) for one file, or totals and averages for a folder or the whole project, from the analysis open in the IDE.',
            risk: 'read',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'A file or folder relative to the project root; "" for the whole project.' } } },
            preview: (args) => ({ summary: `metrics of ${normalize(args['path'] as string | undefined) || 'the project'}` }),
            async run(args, context) {
                return clip(metricsReport(await readMetrics(outputRoot(context)), stringArg(args, 'path', false)));
            },
        },
        {
            name: 'get_hotspots',
            title: 'Find complexity hot spots',
            description: 'The files that rank highest on a Code-XR metric (default maxComplexity), optionally under a folder: where to look first for risky code.',
            risk: 'read',
            parameters: {
                type: 'object',
                properties: {
                    metric: { type: 'string', description: metricDescription },
                    limit: { type: 'integer', description: 'How many files (default 10, max 50).' },
                    path: { type: 'string', description: 'Only files under this folder.' },
                },
            },
            preview: (args) => ({ summary: `top files by ${String(args['metric'] ?? 'maxComplexity')}` }),
            async run(args, context) {
                const metric = stringArg(args, 'metric', false) ?? 'maxComplexity';
                const limit = Math.min(50, Math.max(1, numberArg(args, 'limit') ?? 10));
                return clip(hotspotsReport(await readMetrics(outputRoot(context)), metric, limit, stringArg(args, 'path', false)));
            },
        },
        {
            name: 'get_dependencies',
            title: 'Read the dependency graph',
            description: 'From Code-XR\'s dependency graph: for a file, what it depends on and what uses it; without a file, the most connected files and any cycles. Needs the dependency graph mode to have run in the XR scene.',
            risk: 'read',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'A file relative to the project root; omit for the overview.' },
                    limit: { type: 'integer', description: 'How many entries per list (default 20, max 100).' },
                },
            },
            preview: (args) => ({ summary: `dependencies of ${normalize(args['path'] as string | undefined) || 'the project'}` }),
            async run(args, context) {
                const root = outputRoot(context);
                let graph: unknown;
                try {
                    graph = await readJson(path.join(root, 'dependency-graph.json'));
                } catch {
                    throw new Error('The dependency graph has not been computed for this analysis. Ask the person to open the Dependency graph mode in the XR scene once.');
                }
                return clip(dependenciesReport(graph, stringArg(args, 'path', false), Math.min(100, Math.max(1, numberArg(args, 'limit') ?? 20))));
            },
        },
        {
            name: 'get_evolution',
            title: 'Read the project\'s evolution',
            description: 'How metrics changed across the Git history snapshots of Code-XR\'s last project-evolution movie: the whole project, or one metric for a file or folder. Needs the Project evolution mode to have run in the XR scene.',
            risk: 'read',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'A file or folder; omit for project totals.' },
                    metric: { type: 'string', description: `${metricDescription} Used with path; default codeLines.` },
                },
            },
            preview: (args) => ({ summary: `evolution of ${normalize(args['path'] as string | undefined) || 'the project'}` }),
            async run(args, context) {
                const frames = await readEvolution(outputRoot(context));
                if (!frames || frames.length === 0) {
                    throw new Error('No project-evolution movie has been computed for this analysis. Ask the person to run Project evolution in the XR scene once.');
                }
                return clip(evolutionReport(frames, stringArg(args, 'path', false), stringArg(args, 'metric', false) ?? 'codeLines'));
            },
        },
    ];
}
