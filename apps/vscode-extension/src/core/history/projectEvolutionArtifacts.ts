/**
 * The files of one generated project-evolution movie: `dataN.json` per frame
 * and the manifest. Every file is written once and never changed: the scene
 * loads each frame by its own URL (EVO-5), so there is no shared bridge file
 * for concurrent players to race on.
 *
 * Pure helpers split out of ProjectEvolutionService: the service owns WHEN a
 * revision becomes current (only once these files are written and the job is
 * still wanted), this module owns WHAT a revision folder contains, plus two
 * pure source helpers.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CachedPayload } from './gitAnalysisSessionContext';
import {
    ComparisonSource,
    GitAnalysisExclusion,
    ProjectEvolutionResult,
} from './historicalComparisonModels';

export interface EvolutionFrameInput {
    payload: CachedPayload;
    source: ComparisonSource;
}

/** Phase 4: a fresh revision folder with dataN.json per frame and the manifest. */
export async function writeEvolutionRevision(
    revision: number,
    revisionDirectory: string,
    valid: EvolutionFrameInput[],
    excludedSources: GitAnalysisExclusion[],
): Promise<ProjectEvolutionResult> {
    await fs.promises.rm(revisionDirectory, { recursive: true, force: true });
    await fs.promises.mkdir(revisionDirectory, { recursive: true });
    const frames: ProjectEvolutionResult['frames'] = [];
    for (let index = 0; index < valid.length; index += 1) {
        const entry = valid[index];
        const fileName = `data${index + 1}.json`;
        await fs.promises.writeFile(
            path.join(revisionDirectory, fileName),
            JSON.stringify(entry.payload.payload, null, 2),
            'utf8',
        );
        frames.push({
            index,
            source: entry.source,
            label: entry.source.label,
            date: extractSourceDate(entry.source) || '',
            url: `/evolution/revision-${revision}/${fileName}`,
            itemCount: entry.payload.payload.length,
            missingTarget: false,
            warnings: entry.payload.warnings,
        });
    }

    const result: ProjectEvolutionResult = {
        revision,
        mode: 'project-evolution',
        frames,
        generatedAt: new Date().toISOString(),
        manifestUrl: `/evolution/revision-${revision}/manifest.json`,
        excludedSources,
    };
    await fs.promises.writeFile(
        path.join(revisionDirectory, 'manifest.json'),
        JSON.stringify(result, null, 2),
        'utf8',
    );
    return result;
}

/** The YYYY-MM-DD a Git source's description starts with, if any. */
export function extractSourceDate(source: ComparisonSource): string | undefined {
    const description = source.kind === 'gitRef' ? source.description : '';
    const match = String(description || '').match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : undefined;
}

/** `<staticRoot>/evolution`, refusing anything that would escape the static root. */
export function evolutionDirectoryOf(staticRootPath: string): string {
    const staticRoot = path.resolve(staticRootPath);
    const evolutionDirectory = path.resolve(staticRoot, 'evolution');
    if (!evolutionDirectory.startsWith(staticRoot + path.sep)) {
        throw new Error('project-evolution-outside-static-root');
    }
    return evolutionDirectory;
}

/**
 * Validates a frame of the current movie and returns its own URL. No file is
 * copied (EVO-5): each frame is an immutable `dataN.json`, so players seeking
 * at once can no longer race on a shared bridge file.
 */
export function resolveEvolutionFrame(
    revision: number,
    frameIndex: number,
    currentRevision: number,
    frameCount: number,
): { revision: number; frameIndex: number; frameUrl: string } {
    const safeRevision = Math.floor(Number(revision));
    const safeFrameIndex = Math.floor(Number(frameIndex));
    if (!Number.isFinite(safeRevision) || safeRevision < 1 || safeRevision !== currentRevision) {
        throw new Error('project-evolution-invalid-revision');
    }
    if (!Number.isFinite(safeFrameIndex) || safeFrameIndex < 0 || safeFrameIndex >= frameCount) {
        throw new Error('project-evolution-invalid-frame');
    }
    return {
        revision: safeRevision,
        frameIndex: safeFrameIndex,
        frameUrl: `/evolution/revision-${safeRevision}/data${safeFrameIndex + 1}.json`,
    };
}

/** The revision numbers of the `revision-N` folders under `evolutionDirectory`. */
export async function listEvolutionRevisions(evolutionDirectory: string): Promise<number[]> {
    let names: string[];
    try {
        names = await fs.promises.readdir(evolutionDirectory);
    } catch {
        return [];
    }
    return names
        .map((name) => /^revision-(\d+)$/.exec(name))
        .filter((match): match is RegExpExecArray => !!match)
        .map((match) => Number(match[1]))
        .filter((value) => Number.isSafeInteger(value) && value > 0);
}

/**
 * Removes every `revision-N` folder but `keep` (EVO-11): one movie on disk,
 * so an export can only ship the movie the room is looking at.
 */
export async function removeOtherEvolutionRevisions(evolutionDirectory: string, keep: number): Promise<void> {
    for (const revision of await listEvolutionRevisions(evolutionDirectory)) {
        if (revision !== keep) {
            await fs.promises.rm(path.join(evolutionDirectory, `revision-${revision}`), { recursive: true, force: true });
        }
    }
}

/** How a frame's revision is named in progress messages. */
export function describeRevisionType(source: ComparisonSource): string {
    if (source.kind === 'workingCopy') {
        return 'working copy';
    }
    if (source.revisionType === 'merge') {
        return 'merge';
    }
    return source.revisionType || source.refType || 'commit';
}

/** The picker's sources plus the timeline's, one per id (the timeline wins). */
export function mergeEvolutionSources(primary: ComparisonSource[], timeline: ComparisonSource[]): ComparisonSource[] {
    const merged = new Map<string, ComparisonSource>();
    for (const source of primary) {
        merged.set(source.id, source);
    }
    for (const source of timeline) {
        merged.set(source.id, source);
    }
    return Array.from(merged.values());
}
