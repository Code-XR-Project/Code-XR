import { JobStatus } from '../analysis/launch/jobRunner';
import { HistoricalComparisonStatus } from './historicalComparisonModels';

export const HISTORICAL_COMPARISON_CANCELLED_MESSAGE = 'Historical comparison cancelled.';
export const HISTORICAL_COMPARISON_TIMEOUT_MESSAGE = 'The comparison took longer than 15 minutes and was stopped.';

/**
 * Maps the comparison job onto what `GET /api/historical/status` answers
 * (HIST-13). A user cancel is `idle` (the previous result stays on screen);
 * a timeout is an `error`. `describeError` turns a failed job's raw message
 * into the sentence the clients show. Free of vscode imports.
 */
export function describeComparisonStatus(
    job: JobStatus | null,
    revision: number | null,
    describeError: (error: unknown) => string,
): HistoricalComparisonStatus {
    const status: HistoricalComparisonStatus = { state: 'idle', jobId: job?.id ?? null, revision, message: null };
    if (!job) {
        return status;
    }
    switch (job.state) {
        case 'queued':
        case 'running':
            return { ...status, state: 'running' };
        case 'done':
            return { ...status, state: 'done' };
        case 'failed':
            return { ...status, state: 'error', message: describeError(new Error(job.error || 'comparison-failed')) };
        default:
            return job.error === 'timeout'
                ? { ...status, state: 'error', message: HISTORICAL_COMPARISON_TIMEOUT_MESSAGE }
                : status;
    }
}
