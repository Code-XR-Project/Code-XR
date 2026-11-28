/**
 * The per-analysis Agent Flow service: opens one agent session (a live IDE
 * chat or a Claude Code / Codex transcript), follows it, and rewrites the
 * dataset the XR runtime draws as events arrive (throttled), under the
 * analysis' static root: `agent-flow/agent-flow-<revision>.json`.
 *
 * The city is fixed when the session is opened (from the classic data.json);
 * deltas come from the live re-analysis, which keeps rewriting data.json while
 * the agent saves files, so the numbers are Code-XR's own metrics, not diff
 * estimates. The dependency graph, when the scene computed one, gives the
 * blast radius. Host-neutral: plain Node, used by the VS Code extension and
 * the Code-XR IDE alike.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentFlowDataset, AgentFlowEntity, AgentFlowFileMetrics, AgentTraceEvent, AgentTraceSourceSummary } from './agentFlowModels';
import { buildAgentFlowDataset } from './agentFlowBuilder';
import type { CityLayout } from './agentFlowLayout';
import { type AgentTraceSource, type DiscoveryOptions, listAgentTraceSources, summarizeSource } from './agentTraceSources';

export const AGENT_FLOW_FOLDER = 'agent-flow';
const REBUILD_THROTTLE_MS = 600;
/** Dataset files kept on disk; older revisions are removed (a viewer mid-fetch still finds the previous one). */
const KEEP_REVISIONS = 3;
const MAX_JSON_BYTES = 64 * 1024 * 1024;

export interface AgentFlowServiceOptions {
    /** The analysed folder (absolute). */
    root: string;
    /** The analysis' static root (data.json, dependency-graph.json live here). */
    staticRoot: string;
    discovery?: DiscoveryOptions;
    throttleMs?: number;
    now?: () => number;
}

function numberField(record: Record<string, unknown>, ...names: string[]): number | undefined {
    for (const name of names) {
        const value = record[name];
        if (typeof value === 'number' && Number.isFinite(value)) { return value; }
    }
    return undefined;
}

function readJsonFile(file: string): unknown {
    const stat = fs.statSync(file);
    if (stat.size > MAX_JSON_BYTES) { throw new Error(`${path.basename(file)} is too large.`); }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

/** One classic analysis record as city metrics, or null when it names no file. */
function recordMetrics(item: unknown): AgentFlowFileMetrics | null {
    if (!item || typeof item !== 'object') { return null; }
    const record = item as Record<string, unknown>;
    const rel = typeof record.relativePath === 'string' ? record.relativePath : (typeof record.filePath === 'string' ? record.filePath : null);
    if (!rel) { return null; }
    const metrics: AgentFlowFileMetrics = {
        path: rel.replace(/\\/g, '/').replace(/^\.?\/+/, ''),
        loc: numberField(record, 'codeLines', 'linesCount', 'totalLines') ?? 0,
    };
    const complexity = numberField(record, 'cyclomaticComplexityNumber', 'maxComplexity', 'complexity');
    if (complexity !== undefined) { metrics.complexity = complexity; }
    const functions = numberField(record, 'functionCount', 'functionsCount');
    if (functions !== undefined) { metrics.functions = functions; }
    if (typeof record.language === 'string') { metrics.language = record.language; }
    return metrics;
}

/** The classic analysis records as city metrics. */
export function readAnalysisMetrics(staticRoot: string): AgentFlowFileMetrics[] {
    let data: unknown;
    try {
        data = readJsonFile(path.join(staticRoot, 'data.json'));
    } catch {
        return [];
    }
    if (!Array.isArray(data)) { return []; }
    const out: AgentFlowFileMetrics[] = [];
    for (const item of data) {
        const metrics = recordMetrics(item);
        if (metrics) { out.push(metrics); }
    }
    return out;
}

interface DependencyGraphJson {
    nodes: Array<{ id?: string; relativePath?: string }>;
    edges: Array<{ source?: string; target?: string }>;
}

/** The scene's dependency graph file, when it ran and has nodes and edges. */
function readDependencyGraph(staticRoot: string): DependencyGraphJson | undefined {
    let data: unknown;
    try {
        data = readJsonFile(path.join(staticRoot, 'dependency-graph.json'));
    } catch {
        return undefined;
    }
    const graph = data as Partial<DependencyGraphJson> | null;
    if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) { return undefined; }
    return graph as DependencyGraphJson;
}

function nodePaths(nodes: DependencyGraphJson['nodes']): Map<string, string> {
    const pathById = new Map<string, string>();
    for (const node of nodes) {
        if (node?.id && node.relativePath) { pathById.set(node.id, node.relativePath.replace(/\\/g, '/')); }
    }
    return pathById;
}

/** `[importer, imported]` file pairs from the scene's dependency graph, when it ran. */
export function readDependencyEdges(staticRoot: string): Array<[string, string]> | undefined {
    const graph = readDependencyGraph(staticRoot);
    if (!graph) { return undefined; }
    const pathById = nodePaths(graph.nodes);
    const edges: Array<[string, string]> = [];
    for (const edge of graph.edges) {
        const from = edge?.source ? pathById.get(edge.source) : undefined;
        const to = edge?.target ? pathById.get(edge.target) : undefined;
        if (from && to && from !== to) { edges.push([from, to]); }
    }
    return edges;
}

export class AgentFlowService {
    private source: AgentTraceSource | null = null;
    private stopFollow: (() => void) | null = null;
    private events: AgentTraceEvent[] = [];
    private baseMetrics: AgentFlowFileMetrics[] = [];
    private layout: CityLayout | undefined;
    private revision = 0;
    private timer: NodeJS.Timeout | null = null;
    private entity: AgentFlowEntity = { entityKind: 'agent-flow', entityId: 'main', status: 'idle', revision: 0, datasetUrl: null, sourceId: null, live: false };
    private readonly listeners = new Set<(entity: AgentFlowEntity) => void>();
    private lastDataset: AgentFlowDataset | null = null;
    private disposed = false;

    private readonly options: AgentFlowServiceOptions;

    // Plain assignments (no parameter properties): the IDE loads core with Node's type stripping.
    constructor(options: AgentFlowServiceOptions) {
        this.options = options;
    }

    public get root(): string { return this.options.root; }

    public getEntity(): AgentFlowEntity { return this.entity; }

    public getDataset(): AgentFlowDataset | null { return this.lastDataset; }

    /** Notified on every entity change (open, new dataset revision, close, error). */
    public onEntity(listener: (entity: AgentFlowEntity) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public listSources(): AgentTraceSourceSummary[] {
        return listAgentTraceSources(this.options.root, this.options.discovery).map(summarizeSource);
    }

    /** Opens a source by id (from listSources). Throws a readable Error when it is gone. */
    public open(sourceId: string): AgentFlowEntity {
        const source = listAgentTraceSources(this.options.root, this.options.discovery).find((candidate) => candidate.id === sourceId);
        if (!source) {
            throw new Error('That agent session is no longer available. Refresh the list.');
        }
        return this.openSource(source);
    }

    /** Opens a source object directly (the IDE's live chats, tests). */
    public openSource(source: AgentTraceSource): AgentFlowEntity {
        this.close(false);
        this.source = source;
        this.events = [];
        this.layout = undefined;
        this.baseMetrics = readAnalysisMetrics(this.options.staticRoot);
        this.setEntity({ status: 'loading', sourceId: source.id, live: source.isLive(), datasetUrl: null, message: undefined });
        this.stopFollow = source.follow((events) => {
            this.events.push(...events);
            this.schedule();
        });
        // A session with no events yet still gets its (empty) city at once.
        this.schedule(0);
        return this.entity;
    }

    public close(publish = true): void {
        this.stopFollow?.();
        this.stopFollow = null;
        this.source = null;
        this.events = [];
        this.lastDataset = null;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (publish) {
            this.setEntity({ status: 'idle', sourceId: null, live: false, datasetUrl: null, message: undefined });
        }
    }

    public dispose(): void {
        this.close(false);
        this.disposed = true;
        this.listeners.clear();
    }

    /** The analysis re-ran (the agent saved files): rebuild for fresh deltas. */
    public requestRefresh(): void {
        if (this.source) { this.schedule(); }
    }

    /** Rebuilds now (tests, and a host that wants the dataset synchronously). */
    public rebuildNow(): AgentFlowDataset | null {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        return this.rebuild();
    }

    private schedule(delay = this.options.throttleMs ?? REBUILD_THROTTLE_MS): void {
        if (this.timer || this.disposed) { return; }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.rebuild();
        }, delay);
        this.timer.unref?.();
    }

    private rebuild(): AgentFlowDataset | null {
        const source = this.source;
        if (!source || this.disposed) { return null; }
        try {
            const now = this.options.now?.() ?? Date.now();
            this.revision += 1;
            const { dataset, layout } = buildAgentFlowDataset({
                root: this.options.root,
                session: {
                    id: source.id,
                    source: source.kind,
                    agent: source.agent,
                    label: source.label(),
                    startedAt: this.events[0]?.at ?? now,
                    updatedAt: source.updatedAt(),
                    live: source.isLive(),
                },
                events: this.events,
                baseMetrics: this.baseMetrics,
                currentMetrics: readAnalysisMetrics(this.options.staticRoot),
                dependencyEdges: readDependencyEdges(this.options.staticRoot),
                revision: this.revision,
                now,
                layout: this.layout,
            });
            if (this.baseMetrics.length === 0 && dataset.files.length === 0) {
                dataset.warnings.push('No classic analysis data was found: the city only shows the files the agent touches.');
            }
            this.layout = layout;
            const folder = path.join(this.options.staticRoot, AGENT_FLOW_FOLDER);
            fs.mkdirSync(folder, { recursive: true });
            const name = `agent-flow-${this.revision}.json`;
            fs.writeFileSync(path.join(folder, name), JSON.stringify(dataset));
            fs.writeFileSync(path.join(folder, 'agent-flow.json'), JSON.stringify(dataset));
            this.pruneRevisions(folder);
            this.lastDataset = dataset;
            this.setEntity({ status: 'ready', revision: this.revision, datasetUrl: `/${AGENT_FLOW_FOLDER}/${name}`, live: dataset.session.live, message: undefined });
            return dataset;
        } catch (error) {
            this.setEntity({ status: 'error', message: `Agent flow could not be built: ${error instanceof Error ? error.message : String(error)}` });
            return null;
        }
    }

    private pruneRevisions(folder: string): void {
        try {
            for (const name of fs.readdirSync(folder)) {
                const match = /^agent-flow-(\d+)\.json$/.exec(name);
                if (match && Number(match[1]) <= this.revision - KEEP_REVISIONS) {
                    fs.rmSync(path.join(folder, name), { force: true });
                }
            }
        } catch {
            // Pruning is housekeeping; a failure must not break the live view.
        }
    }

    private setEntity(patch: Partial<AgentFlowEntity>): void {
        this.entity = { ...this.entity, ...patch, entityKind: 'agent-flow', entityId: 'main' };
        if (this.entity.message === undefined) { delete this.entity.message; }
        for (const listener of this.listeners) { listener(this.entity); }
    }
}

/** A scene server's Agent Flow, as a host (the IDE) can drive it. */
export interface AgentFlowController {
    readonly service: AgentFlowService;
    /** Switches the scene's room to the Agent Flow analysis. */
    activate(): void;
}

const controllers = new Set<AgentFlowController>();

/** Called by the analysis feature host of each XR server; returns the unregister function. */
export function registerAgentFlowController(controller: AgentFlowController): () => void {
    controllers.add(controller);
    controllerListeners.forEach((listener) => listener());
    return () => { controllers.delete(controller); };
}

const controllerListeners = new Set<() => void>();

/** True when an XR scene of `root` can show Agent Flow right now. */
export function hasAgentFlowScene(root: string): boolean {
    return [...controllers].some((controller) => rootsMatch(controller.service.root, root));
}

/** Resolves when an XR scene of `root` is up (true), or after `timeoutMs` (false). */
export function waitForAgentFlowScene(root: string, timeoutMs: number): Promise<boolean> {
    if (hasAgentFlowScene(root)) { return Promise.resolve(true); }
    return new Promise((resolve) => {
        const done = (value: boolean) => {
            clearTimeout(timer);
            controllerListeners.delete(check);
            resolve(value);
        };
        const check = () => { if (hasAgentFlowScene(root)) { done(true); } };
        const timer = setTimeout(() => done(false), timeoutMs);
        timer.unref?.();
        controllerListeners.add(check);
    });
}

function rootsMatch(a: string, b: string): boolean {
    const norm = (value: string) => {
        const resolved = path.resolve(value).replace(/[\\/]+$/, '');
        return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
    };
    return norm(a) === norm(b);
}

/**
 * Opens a source in every open XR scene of `root` and switches those scenes
 * to Agent Flow ("Watch in XR" from a chat). Returns how many scenes it reached.
 */
export function openAgentFlowInScenes(root: string, sourceId: string): number {
    let reached = 0;
    for (const controller of controllers) {
        if (!rootsMatch(controller.service.root, root)) { continue; }
        try {
            controller.service.open(sourceId);
            controller.activate();
            reached += 1;
        } catch {
            // That scene could not open it (source gone): the others still try.
        }
    }
    return reached;
}
