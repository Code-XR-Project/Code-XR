import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { UnifiedSessionRegistry } from '../analysis/session/sessionRegistry';
import { ExecutePython } from '../analysis/python/executePython';
import { DependencyGraphDataset, DependencyRefreshRequest } from './dependencyGraphModels';
import { JobRunner } from '../analysis/launch/jobRunner';
import { runWithLaunchSignal } from '../analysis/launch/launchControl';
import { hostPathsFromContext, privateStorageRoot } from '../host/hostPaths';

/** A dependency analysis longer than this is killed and reported (DEPGRAPH-9). */
export const DEPENDENCY_GRAPH_JOB_TIMEOUT_MS = 10 * 60 * 1000;

export class DependencyGraphService {
    private readonly jobs = new JobRunner<object, DependencyGraphDataset>({
        busyCode: 'dependency-graph-busy',
        cancelledCode: 'dependency-graph-cancelled',
        timeoutCode: 'dependency-graph-timeout',
        timeoutMs: DEPENDENCY_GRAPH_JOB_TIMEOUT_MS,
    });
    /** Cancels the file-scope analysis in flight when the service is disposed. */
    private readonly disposal = new AbortController();
    private revision = 0;
    private generated = false;
    private readonly extractionCachePath: string;
    private readonly fileScopeCache = new Map<string, DependencyGraphDataset>();

    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly sessionId: string,
        private readonly staticRoot: string,
    ) {
        const storageRoot = privateStorageRoot(hostPathsFromContext(context));
        this.extractionCachePath = path.join(
            storageRoot,
            'dependency-graphs',
            sessionId,
            'extraction-cache.json',
        );
    }

    public getAvailability(): { enabled: boolean; reason: string | null } {
        const session = this.getSession();
        if (session.analysisMode !== 'XR' && session.analysisMode !== 'LivePanel') {
            return {
                enabled: false,
                reason: 'Dependency graphs are available for XR file/directory/project analyses '
                    + 'and LivePanel directory/project analyses.',
            };
        }
        return { enabled: true, reason: null };
    }

    public isBusy(): boolean {
        return this.jobs.isBusy();
    }

    public getInitialScope(): { kind: 'file' | 'directory'; relativePath: string } {
        const session = this.getSession();
        return session.targetType === 'file'
            ? { kind: 'file', relativePath: path.basename(session.targetPath) }
            : { kind: 'directory', relativePath: '' };
    }

    public analyze(
        request?: DependencyRefreshRequest,
        onProgress?: (message: string) => void,
    ): Promise<DependencyGraphDataset> {
        // A start while one runs joins it rather than being refused.
        const running = this.jobs.current();
        if (running) {
            return running;
        }
        const ticket = this.jobs.tryReserve({});
        if (!ticket) {
            // Reserved but not executing yet: impossible here (reserve and
            // execute are synchronous together), kept as a typed guard.
            return Promise.reject(new Error('dependency-graph-busy'));
        }
        return ticket.execute(() => this.executeAnalysis(request, onProgress));
    }

    /**
     * Disposing (the session ends) kills the Python analysis in flight
     * instead of leaving it running with nobody to read it (DEPGRAPH-9).
     */
    public async dispose(): Promise<void> {
        this.disposal.abort('disposed');
        await this.jobs.cancelAndWait('disposed');
        this.fileScopeCache.clear();
    }

    public async analyzeFileScope(
        relativePath?: string,
        onProgress?: (message: string) => void,
    ): Promise<DependencyGraphDataset> {
        const { targetPath, relative } = this.resolveScopedFile(relativePath);
        const contentHash = crypto.createHash('sha256')
            .update(await fs.promises.readFile(targetPath))
            .digest('hex');
        const cacheKey = `${targetPath}\0${contentHash}\0dependency-schema-2`;
        const cached = this.fileScopeCache.get(cacheKey);
        if (cached) {
            const dataset = {
                ...cached,
                revision: ++this.revision,
                generatedAt: new Date().toISOString(),
            };
            await this.writeFileScopeDataset(dataset);
            return dataset;
        }
        onProgress?.('Analyzing symbols and calls in the selected file...');
        const result = await runWithLaunchSignal(this.disposal.signal, () => new ExecutePython(this.context).executeDependencyAnalysis(
            targetPath,
            'file',
            false,
            undefined,
            undefined,
            this.resolveProjectRoot(targetPath),
        ));
        if (!result || result.error === true || !Array.isArray(result.nodes) || !Array.isArray(result.edges)) {
            throw new Error(String(result?.message || 'File dependency analysis returned an invalid dataset.'));
        }
        const dataset: DependencyGraphDataset = {
            ...result,
            schemaVersion: 2,
            revision: ++this.revision,
            sourceRevision: 0,
            targetType: 'file',
            targetRelativePath: relative.replace(/\\/g, '/'),
            generatedAt: new Date().toISOString(),
        };
        this.evictFileScopeEntries(targetPath);
        this.fileScopeCache.set(cacheKey, dataset);
        await this.writeFileScopeDataset(dataset);
        return dataset;
    }

    /**
     * The file a file-scope request names: the session file for file sessions,
     * otherwise `relativePath` under the analysed directory. Refuses anything
     * outside the analysis root, missing, or not a regular file.
     */
    private resolveScopedFile(relativePath?: string): { targetPath: string; relative: string } {
        const session = this.getSession();
        const analysisRoot = session.targetType === 'directory'
            ? path.resolve(session.targetPath)
            : path.dirname(path.resolve(session.targetPath));
        const targetPath = session.targetType === 'file'
            ? path.resolve(session.targetPath)
            : path.resolve(analysisRoot, String(relativePath || ''));
        const relative = path.relative(analysisRoot, targetPath);
        if (
            relative.startsWith('..')
            || path.isAbsolute(relative)
            || !fs.existsSync(targetPath)
            || !fs.statSync(targetPath).isFile()
        ) {
            throw new Error('The requested dependency file is outside the active analysis.');
        }
        return { targetPath, relative };
    }

    /** Drops every cached dataset of `targetPath`, whatever content hash it was keyed on. */
    private evictFileScopeEntries(targetPath: string): void {
        for (const key of this.fileScopeCache.keys()) {
            if (key.startsWith(`${targetPath}\0`)) {
                this.fileScopeCache.delete(key);
            }
        }
    }

    private async writeFileScopeDataset(dataset: DependencyGraphDataset): Promise<void> {
        const outputDirectory = path.join(this.staticRoot, 'dependencies');
        await fs.promises.mkdir(outputDirectory, { recursive: true });
        await fs.promises.writeFile(
            path.join(outputDirectory, `dependency-scope-${dataset.revision}.json`),
            JSON.stringify(dataset),
            'utf8',
        );
        await pruneDatasetRevisions(outputDirectory, 'dependency-scope-');
    }

    private async executeAnalysis(
        request?: DependencyRefreshRequest,
        onProgress?: (message: string) => void,
    ): Promise<DependencyGraphDataset> {
        const session = this.getSession();
        const refreshRequest: DependencyRefreshRequest = request ?? {
            sourceRevision: 0,
            changedFiles: [],
            addedFiles: [],
            removedFiles: [],
            forceFullScan: true,
        };
        const requestDirectory = path.dirname(this.extractionCachePath);
        await fs.promises.mkdir(requestDirectory, { recursive: true });
        const requestPath = path.join(requestDirectory, 'refresh-request.json');
        await fs.promises.writeFile(requestPath, JSON.stringify(refreshRequest), 'utf8');
        onProgress?.(refreshRequest.forceFullScan
            ? 'Scanning supported source files...'
            : 'Updating changed dependency sources...');
        const result = await new ExecutePython(this.context).executeDependencyAnalysis(
            session.targetPath,
            session.targetType,
            session.isDeep,
            this.extractionCachePath,
            requestPath,
            session.targetType === 'file' ? this.resolveProjectRoot(session.targetPath) : undefined,
        );
        if (!result || result.error === true || !Array.isArray(result.nodes) || !Array.isArray(result.edges)) {
            throw new Error(String(result?.message || 'Dependency analysis returned an invalid dataset.'));
        }

        onProgress?.('Calculating graph metrics and cycles...');
        const dataset: DependencyGraphDataset = {
            ...result,
            schemaVersion: Number(result.schemaVersion) === 2 ? 2 : 1,
            revision: ++this.revision,
            targetType: session.targetType,
            targetRelativePath: session.targetType === 'file'
                ? path.basename(session.targetPath)
                : '',
            sourceRevision: refreshRequest.sourceRevision,
            generatedAt: new Date().toISOString(),
        };
        this.generated = true;
        const outputDirectory = path.join(this.staticRoot, 'dependencies');
        await fs.promises.mkdir(outputDirectory, { recursive: true });
        const fileName = `dependency-graph-${dataset.revision}.json`;
        const serialized = JSON.stringify(dataset);
        await fs.promises.writeFile(path.join(outputDirectory, fileName), serialized, 'utf8');
        await fs.promises.writeFile(path.join(this.staticRoot, 'dependency-graph.json'), serialized, 'utf8');
        await pruneDatasetRevisions(outputDirectory, 'dependency-graph-');
        onProgress?.('Dependency graph ready.');
        return dataset;
    }

    public hasGeneratedDataset(): boolean {
        return this.generated;
    }

    private getSession() {
        const session = UnifiedSessionRegistry.getInstance(this.context).getSession(this.sessionId);
        if (!session) {
            throw new Error(`Analysis session not found: ${this.sessionId}`);
        }
        return session;
    }

    private resolveProjectRoot(targetPath: string): string {
        const resolvedTarget = path.resolve(targetPath);
        const workspace = vscode.workspace.workspaceFolders
            ?.map((folder) => path.resolve(folder.uri.fsPath))
            .filter((folderPath) => {
                const relative = path.relative(folderPath, resolvedTarget);
                return !relative.startsWith('..') && !path.isAbsolute(relative);
            })
            .sort((left, right) => right.length - left.length)[0];
        if (workspace) {
            return workspace;
        }
        let current = path.dirname(resolvedTarget);
        while (true) {
            if (fs.existsSync(path.join(current, '.git'))) {
                return current;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return path.dirname(resolvedTarget);
            }
            current = parent;
        }
    }
}

/** How many revisions of each dataset kind stay on disk (DEPGRAPH-9). */
export const KEPT_DATASET_REVISIONS = 2;

/**
 * Deletes all but the newest `KEPT_DATASET_REVISIONS` files named
 * `<prefix><revision>.json` in `directory` (DEPGRAPH-9). Every refresh used to
 * add a file that was never removed, so a live session grew without bound and
 * every export copied the whole history. The newest two stay: the one the
 * room entity points at, and the one a page that has not reloaded yet may
 * still be fetching. A file another process still holds open (Windows) is
 * left for the next pass.
 */
export async function pruneDatasetRevisions(
    directory: string,
    prefix: string,
    keep: number = KEPT_DATASET_REVISIONS,
): Promise<string[]> {
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)\\.json$`);
    let entries: string[];
    try {
        entries = await fs.promises.readdir(directory);
    } catch {
        return [];
    }
    const stale = entries
        .map((name) => ({ name, revision: Number(pattern.exec(name)?.[1]) }))
        .filter((entry) => Number.isInteger(entry.revision))
        .sort((left, right) => right.revision - left.revision)
        .slice(keep)
        .map((entry) => entry.name);
    const removed: string[] = [];
    for (const name of stale) {
        try {
            await fs.promises.rm(path.join(directory, name), { force: true });
            removed.push(name);
        } catch {
            // Still open elsewhere; the next refresh tries again.
        }
    }
    return removed;
}
