import * as fs from 'fs';
import * as path from 'path';
import { DrillDatasetBuilder } from './drillDownDatasetBuilder';
import type { DrillAnalyzer, DrillDataset, DrillSessionSeed } from './drillDownDatasetBuilder';
import { normalizeBabiaPath } from './drillDownDataset';
import { DrillHistory } from './drillDownHistory';
import type { DrillControllerSchema, DrillCrumb, DrillDownEntity, DrillTarget, DrillTargetKind } from './drillDownModels';
import {
    buildCrumbs,
    resolveBoundaryRoot,
    resolveScenePath,
    rootLabelOf,
    toAbsolute,
    toRelative,
} from './drillDownPaths';

/**
 * The drill-down of one analysis server (#335). It owns the history, the
 * cache and the datasets, and tells the server two things: the entity to
 * publish to the room and which table mode to show. It never creates a
 * session, a server or a watcher: a target is analysed with the Python
 * runner it is given, file by file, reusing every result whose hash holds.
 */

/**
 * The chart a target kind is drawn with: the user's configured defaults, and
 * the controller schema of that kind (charts and fields, see DrillDownEntity).
 */
export interface DrillChart {
    readonly chartId: string;
    readonly mapping: Record<string, string>;
    readonly controllerSchema?: DrillControllerSchema | null;
}
export type DrillChartResolver = (kind: DrillTargetKind) => Promise<DrillChart>;

export interface DrillDownServiceOptions {
    /** The session's own target and kind (the home of the history). */
    readonly targetPath: string;
    readonly targetType: DrillTargetKind;
    /** Folder analyses are deep when the session's is (file sessions always are). */
    readonly isDeep: boolean;
    /** The server's static root; datasets go to `<staticRoot>/drilldown/`. */
    readonly staticRoot: string;
    readonly workspaceFolders: readonly string[];
    readonly analyzer: DrillAnalyzer;
    /** The session's current rows and hashes; read again after every re-analysis. */
    readonly readSessionSeed?: () => DrillSessionSeed | null;
    readonly resolveChart: DrillChartResolver;
    /** Publishes the `drill-down` entity to the room. */
    readonly publish: (entity: DrillDownEntity) => void;
    /** Switches the table: 'drill-down' for a drilled target, 'single' for home. */
    readonly activate: (mode: 'drill-down' | 'single') => void | Promise<void>;
    /** A jump that answers within this delay shows no loading state (ms). */
    readonly loadingDelayMs?: number;
    /** Files per Python run when a folder needs many. */
    readonly batchSize?: number;
    readonly caseInsensitivePaths?: boolean;
    readonly now?: () => number;
}

const DEFAULT_LOADING_DELAY_MS = 150;
const DEFAULT_BATCH_SIZE = 80;
// A drilled folder's city is built on `drillPath` (`<folder>/<path re-rooted
// at the folder>`), so it starts at the folder instead of climbing every level
// of the absolute path, and the folder is its one top district.
const TREE_FIELD: Record<DrillTargetKind, string> = { directory: 'drillPath', file: 'treePath' };

export class DrillRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DrillRequestError';
    }
}

export class DrillDownService {
    private readonly options: DrillDownServiceOptions;
    private readonly boundaryRoot: string;
    private readonly rootLabel: string;
    private readonly history: DrillHistory;
    private readonly datasets: DrillDatasetBuilder;
    private readonly caseInsensitive: boolean;
    private readonly now: () => number;
    private entity: DrillDownEntity;
    private revision = 0;
    private requestSeq = 0;
    private running: AbortController | null = null;
    private disposed = false;

    constructor(options: DrillDownServiceOptions) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.caseInsensitive = options.caseInsensitivePaths ?? (process.platform === 'win32' || process.platform === 'darwin');
        this.boundaryRoot = resolveBoundaryRoot(options.targetPath, options.targetType, options.workspaceFolders);
        this.rootLabel = rootLabelOf(this.boundaryRoot);
        const homeRelative = toRelative(this.boundaryRoot, options.targetPath) ?? '';
        this.history = new DrillHistory({ kind: options.targetType, relativePath: homeRelative });
        this.datasets = new DrillDatasetBuilder({
            analyzer: options.analyzer,
            readSessionSeed: options.readSessionSeed,
            deep: options.targetType === 'file' || options.isDeep,
            batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
            caseInsensitive: this.caseInsensitive,
            staticRoot: options.staticRoot,
        });
        this.entity = this.buildEntity({ status: 'idle', datasetUrl: null, chartId: 'boats', mapping: {}, rowCount: 0, source: 'home' });
    }

    public get root(): string {
        return this.boundaryRoot;
    }

    public get home(): DrillTarget {
        return this.history.home;
    }

    public get current(): DrillTarget {
        return this.history.current;
    }

    public getEntity(): DrillDownEntity {
        return this.entity;
    }

    /** True when the path is something this server can drill into. */
    public covers(absolutePath: string): boolean {
        return toRelative(this.boundaryRoot, absolutePath) !== null;
    }

    /**
     * Opens a target the scene (or the host) named. `input` is whatever the
     * scene knows: a row's filePath, a district's tree uid, or a relative path.
     */
    public async open(input: string, kind: DrillTargetKind): Promise<DrillDownEntity> {
        const target = this.resolveTarget(input, kind);
        const before = this.history.snapshot();
        this.history.push(target);
        return this.show(before);
    }

    public async back(): Promise<DrillDownEntity> {
        const before = this.history.snapshot();
        return this.history.back() ? this.show(before) : this.entity;
    }

    public async forward(): Promise<DrillDownEntity> {
        const before = this.history.snapshot();
        return this.history.forward() ? this.show(before) : this.entity;
    }

    public async goHome(): Promise<DrillDownEntity> {
        const before = this.history.snapshot();
        this.history.goHome();
        return this.show(before);
    }

    /** A breadcrumb jump: `relativePath` comes from the entity's own crumbs. */
    public async goto(relativePath: string, kind: DrillTargetKind): Promise<DrillDownEntity> {
        const absolute = toAbsolute(this.boundaryRoot, String(relativePath ?? ''));
        return this.open(absolute, kind);
    }

    /**
     * The session's sources changed (its re-analysis ran): Python folder
     * results are stale, and a drilled target on screen is refreshed in place.
     */
    public async handleSourcesChanged(): Promise<void> {
        this.datasets.invalidateSeed();
        if (this.disposed || this.history.atHome || this.entity.status === 'loading') {
            return;
        }
        await this.show(null, { quiet: true });
    }

    /**
     * The room went back to the classic analysis on its own (the Analyses
     * menu): home becomes the current entry, so Back returns to the drilled
     * target and the bar never shows a place the table has left.
     */
    public noteHomeShown(): void {
        if (this.disposed || this.history.atHome) {
            return;
        }
        this.requestSeq++;
        this.running?.abort();
        this.running = null;
        this.history.goHome();
        this.publish(this.homeEntity());
    }

    /** Publishes the current entity again (a scene that joined before any jump asks for it). */
    public publishCurrent(): DrillDownEntity {
        if (this.entity.status === 'idle') {
            this.entity = this.homeEntity();
        }
        this.publish(this.entity);
        return this.entity;
    }

    public dispose(): void {
        this.disposed = true;
        this.running?.abort();
        this.running = null;
        this.datasets.clear();
    }

    /** Resolves and validates a scene path; throws a DrillRequestError with the reason. */
    public resolveTarget(input: string, kind: DrillTargetKind): DrillTarget {
        if (kind !== 'file' && kind !== 'directory') {
            throw new DrillRequestError('Only a file or a folder can be analysed.');
        }
        const absolute = resolveScenePath(this.boundaryRoot, input);
        if (!absolute) {
            throw new DrillRequestError(`"${String(input ?? '')}" is outside ${this.rootLabel}, the folder this analysis can explore.`);
        }
        assertKind(absolute, kind);
        return { kind, relativePath: toRelative(this.boundaryRoot, absolute) ?? '' };
    }

    /**
     * Shows the history's current target. `before` is the history to put back
     * if it cannot be shown (null for a refresh, which keeps the history).
     */
    private async show(
        before: { entries: DrillTarget[]; index: number } | null,
        options: { quiet?: boolean } = {},
    ): Promise<DrillDownEntity> {
        const target = this.history.current;
        const seq = ++this.requestSeq;
        this.running?.abort();
        this.running = null;
        if (this.history.atHome) {
            this.publish(this.homeEntity());
            await this.options.activate('single');
            return this.entity;
        }
        const controller = new AbortController();
        this.running = controller;
        const loadingTimer = options.quiet ? null : this.scheduleLoading(target, seq);
        try {
            const [dataset, chart] = await Promise.all([
                this.datasets.compute(toAbsolute(this.boundaryRoot, target.relativePath), target.kind, controller.signal),
                this.options.resolveChart(target.kind),
            ]);
            if (this.isSuperseded(seq)) {
                return this.entity;
            }
            await this.publishReady(target, dataset, chart);
            return this.entity;
        } catch (error) {
            return this.handleShowError(error, target, seq, before);
        } finally {
            if (loadingTimer) {
                clearTimeout(loadingTimer);
            }
            if (this.running === controller) {
                this.running = null;
            }
        }
    }

    private isSuperseded(seq: number): boolean {
        return seq !== this.requestSeq || this.disposed;
    }

    /** A jump that answers within the delay never flashes the loading state. */
    private scheduleLoading(target: DrillTarget, seq: number): NodeJS.Timeout {
        const startedAt = this.now();
        return setTimeout(() => {
            if (this.isSuperseded(seq)) {
                return;
            }
            this.publish({
                ...this.entity,
                status: 'loading',
                revision: ++this.revision,
                pending: { ...target },
                message: `Analyzing ${target.relativePath || this.rootLabel}…`,
                startedAt,
            });
        }, this.options.loadingDelayMs ?? DEFAULT_LOADING_DELAY_MS);
    }

    private async publishReady(
        target: DrillTarget,
        dataset: DrillDataset,
        chart: DrillChart,
    ): Promise<void> {
        const datasetUrl = await this.datasets.write(dataset.rows);
        const empty = target.kind === 'file' ? 'No functions were found in this file.' : 'No analysable files in this folder.';
        this.publish(this.buildEntity({
            status: 'ready',
            datasetUrl,
            chartId: chart.chartId,
            mapping: chart.mapping,
            // The controller keeps the session's own schema while the kinds match.
            controllerSchema: target.kind === this.history.home.kind ? null : chart.controllerSchema ?? null,
            rowCount: dataset.rows.length,
            source: dataset.source,
            analyzed: dataset.analyzed,
            reused: dataset.reused,
            message: dataset.rows.length ? '' : empty,
        }));
        await this.options.activate('drill-down');
    }

    /** The table keeps what it showed; only the bar reports the failure. A user move also rejects. */
    private handleShowError(
        error: unknown,
        target: DrillTarget,
        seq: number,
        before: { entries: DrillTarget[]; index: number } | null,
    ): DrillDownEntity {
        if (this.isSuperseded(seq)) {
            return this.entity;
        }
        if (before) {
            this.history.reset(before);
        }
        const message = describeDrillError(error, target, this.rootLabel);
        this.publish({
            ...this.entity,
            ...this.navigationFields(),
            status: 'error',
            revision: ++this.revision,
            pending: null,
            message,
            startedAt: null,
        });
        if (!before) {
            return this.entity;
        }
        throw new DrillRequestError(message);
    }

    private homeEntity(): DrillDownEntity {
        return this.buildEntity({ status: 'ready', datasetUrl: null, chartId: this.entity.chartId, mapping: this.entity.mapping, rowCount: 0, source: 'home' });
    }

    private navigationFields(): Pick<DrillDownEntity, 'target' | 'targetPath' | 'atHome' | 'crumbs' | 'canBack' | 'canForward'
        | 'homeKind' | 'homeRelativePath' | 'homePath' | 'homeCrumbs'> {
        const target = this.history.current;
        const home = this.history.home;
        return {
            target: { ...target },
            targetPath: normalizeBabiaPath(toAbsolute(this.boundaryRoot, target.relativePath)),
            homeKind: home.kind,
            homeRelativePath: home.relativePath,
            homePath: normalizeBabiaPath(toAbsolute(this.boundaryRoot, home.relativePath)),
            homeCrumbs: this.crumbsFor(home),
            atHome: this.history.atHome,
            crumbs: this.crumbsFor(target),
            canBack: this.history.canBack,
            canForward: this.history.canForward,
        };
    }

    private crumbsFor(target: DrillTarget): DrillCrumb[] {
        return buildCrumbs(target, this.history.home, this.rootLabel);
    }

    private buildEntity(fields: {
        status: DrillDownEntity['status'];
        datasetUrl: string | null;
        chartId: string;
        mapping: Record<string, string> | Readonly<Record<string, string>>;
        controllerSchema?: DrillControllerSchema | null;
        rowCount: number;
        source: DrillDownEntity['source'];
        message?: string;
        analyzed?: number;
        reused?: number;
    }): DrillDownEntity {
        const target = this.history.current;
        return {
            entityKind: 'drill-down',
            entityId: 'main',
            mode: 'drill-down',
            status: fields.status,
            revision: ++this.revision,
            ...this.navigationFields(),
            pending: null,
            rootLabel: this.rootLabel,
            rootPath: normalizeBabiaPath(this.boundaryRoot),
            datasetUrl: fields.datasetUrl,
            chartId: fields.chartId,
            mapping: { ...fields.mapping },
            controllerSchema: fields.controllerSchema ?? null,
            treeField: TREE_FIELD[target.kind],
            rowCount: fields.rowCount,
            analyzedCount: fields.analyzed ?? 0,
            reusedCount: fields.reused ?? 0,
            source: fields.source,
            message: fields.message ?? '',
            startedAt: null,
        };
    }

    private publish(entity: DrillDownEntity): void {
        this.entity = entity;
        if (!this.disposed) {
            this.options.publish(entity);
        }
    }
}

/** A readable reason for the bar. */
export function describeDrillError(error: unknown, target: DrillTarget, rootLabel: string): string {
    if (error instanceof DrillRequestError) {
        return error.message;
    }
    const name = target.relativePath || rootLabel;
    const reason = error instanceof Error ? error.message : String(error);
    return `Could not analyse ${name}: ${reason}`;
}

/** Throws when the path is gone or is not of the kind the scene asked for. */
function assertKind(absolute: string, kind: DrillTargetKind): void {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(absolute);
    } catch {
        throw new DrillRequestError(`${path.basename(absolute) || absolute} no longer exists.`);
    }
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
        throw new DrillRequestError(`${path.basename(absolute)} is not a ${kind === 'file' ? 'file' : 'folder'}.`);
    }
}
