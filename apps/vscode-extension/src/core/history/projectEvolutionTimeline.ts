/**
 * Which revisions a project-evolution movie can show (S11, EVO-6/EVO-7).
 *
 * The timeline is the first-parent history of what is checked out, from its
 * very first commit, ending on the working copy. It used to be the newest 240
 * commits of `git log --all`, so stashes and notes became frames, other
 * branches newer than the checkout played before the "final" state, and a
 * long history never reached its beginning.
 *
 * The whole history is listed (streamed, so its size is no problem) and then
 * thinned to `TIMELINE_SCAN_SAMPLE` revisions spread over all of it, first and
 * last included. That bound is what the eligibility index and the picker see,
 * the same cost as the old window, but the window now spans the whole history.
 */
import { sampleTimeline } from './gitTimelineSampler';
import { ComparisonSource } from './historicalComparisonModels';

/** How many revisions of the whole history are considered for a movie. */
export const TIMELINE_SCAN_SAMPLE = 240;

/** The part of GitRepositoryService the timeline needs. */
export interface EvolutionTimelineGit {
    listTimelineSources(maxCount: number | null, tip?: string, exclude?: string): Promise<ComparisonSource[]>;
    resolveSource(sourceId: string): Promise<ComparisonSource>;
    isAncestor(ancestor: string, descendant: string): Promise<boolean>;
    mergeBase(first: string, second: string): Promise<string | null>;
    resolveHeadCommit(): Promise<string | null>;
}

interface ReferenceListing {
    sources: ComparisonSource[];
}

export const RANGE_NOT_FOUND_MESSAGE =
    'The start or the end of the range is no longer in this repository. Pick it again and generate.';

function workingCopyOf(references: ReferenceListing): ComparisonSource | null {
    return references.sources.find((source) => source.kind === 'workingCopy') ?? null;
}

/** Thins a chronological timeline to the scan sample, first and last kept. */
function thin(timeline: ComparisonSource[]): ComparisonSource[] {
    if (timeline.length <= TIMELINE_SCAN_SAMPLE) {
        return timeline;
    }
    return sampleTimeline(timeline, TIMELINE_SCAN_SAMPLE, timeline[timeline.length - 1]);
}

function endWith(timeline: ComparisonSource[], end: ComparisonSource | null): ComparisonSource[] {
    if (end && !timeline.some((source) => source.id === end.id)) {
        return [...timeline, end];
    }
    return timeline;
}

/**
 * The Auto movie: HEAD's first-parent history from its first commit, ending
 * on the working copy (the branch as it stands now, dirty or not).
 */
export async function buildAutomaticTimeline(
    git: EvolutionTimelineGit,
    references: ReferenceListing,
): Promise<ComparisonSource[]> {
    const history = await git.listTimelineSources(null);
    return endWith(thin(history), workingCopyOf(references));
}

interface Endpoint {
    sha: string;
    live: boolean;
}

async function resolveEndpoint(git: EvolutionTimelineGit, sourceId: string): Promise<Endpoint | null> {
    if (sourceId === 'working-copy') {
        const head = await git.resolveHeadCommit();
        return head ? { sha: head, live: true } : null;
    }
    try {
        const source = await git.resolveSource(sourceId);
        if (source.kind === 'workingCopy') {
            const head = await git.resolveHeadCommit();
            return head ? { sha: head, live: true } : null;
        }
        return source.commitSha ? { sha: source.commitSha, live: false } : null;
    } catch {
        return null;
    }
}

/** Older first: the working copy is always the newer end, else ancestry decides. */
async function orderEndpoints(
    git: EvolutionTimelineGit,
    start: Endpoint,
    end: Endpoint,
): Promise<{ older: Endpoint; newer: Endpoint }> {
    if (start.live && !end.live) {
        return { older: end, newer: start };
    }
    const reversed = !end.live && start.sha !== end.sha
        && !await git.isAncestor(start.sha, end.sha)
        && await git.isAncestor(end.sha, start.sha);
    return reversed ? { older: end, newer: start } : { older: start, newer: end };
}

/** The older end, or the merge base when the two ends diverge. */
async function rangeStart(git: EvolutionTimelineGit, olderSha: string, newerSha: string): Promise<string> {
    if (olderSha === newerSha || await git.isAncestor(olderSha, newerSha)) {
        return olderSha;
    }
    const base = await git.mergeBase(olderSha, newerSha);
    if (!base) {
        throw new Error('The two ends of the range share no history. Pick two revisions of the same project.');
    }
    return base;
}

/**
 * A range movie: every first-parent step from the older endpoint to the newer
 * one, resolved by Git rather than looked up in a window, so any branch, tag
 * or commit the picker offers works (EVO-7). The endpoints may come in either
 * order. Endpoints on diverging branches start from their merge base, so the
 * movie is always one line of history. The working copy as an endpoint is the
 * end of the movie.
 */
export async function buildRangeTimeline(
    git: EvolutionTimelineGit,
    references: ReferenceListing,
    startSourceId: string,
    endSourceId: string,
): Promise<ComparisonSource[]> {
    const start = await resolveEndpoint(git, startSourceId);
    const end = await resolveEndpoint(git, endSourceId);
    if (!start || !end) {
        throw new Error(RANGE_NOT_FOUND_MESSAGE);
    }
    const { older, newer } = await orderEndpoints(git, start, end);
    const fromSha = await rangeStart(git, older.sha, newer.sha);
    const first = await git.listTimelineSources(1, fromSha);
    const rest = fromSha === newer.sha ? [] : await git.listTimelineSources(null, newer.sha, fromSha);
    const timeline = thin([...first, ...rest]);
    return newer.live ? endWith(timeline, workingCopyOf(references)) : timeline;
}
