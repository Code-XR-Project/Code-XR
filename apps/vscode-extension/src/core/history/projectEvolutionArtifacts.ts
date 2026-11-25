/**
 * The files of one generated project-evolution movie: `dataN.json` per frame,
 * the `data.json` bridge the scene reads, and the manifest.
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

/** Phase 4: a fresh revision folder with dataN.json per frame, the data.json bridge and the manifest. */
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
        bridgeUrl: `/evolution/revision-${revision}/data.json`,
        excludedSources,
    };
    await copyFileAtomically(
        path.join(revisionDirectory, 'data1.json'),
        path.join(revisionDirectory, 'data.json'),
    );
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

/** Copy through a temp file + rename, so a reader never sees half a file. */
export async function copyFileAtomically(sourcePath: string, destinationPath: string): Promise<void> {
    const tempPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.copyFile(sourcePath, tempPath);
    await fs.promises.rename(tempPath, destinationPath);
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
