import { CollaborationApplicationMessageContext } from '../collaboration/collaborationRoomServer';
import { JobCancelledError } from '../../analysis/launch/jobRunner';
import { GitAnalysisSourceError } from '../../history/gitAnalysisEligibility';
import { AnalysisFeatureHost } from './analysisFeatureHost';

/**
 * Reply shapes shared by the historical-comparison and project-evolution
 * bridges. Every wire type and fallback code is passed in by the caller, so
 * the literals the clients match on stay in the bridge that owns them.
 */

/**
 * After a Git source was excluded, both pickers must drop it: re-broadcast
 * the filtered reference list of every Git service this host runs.
 */
export async function broadcastFilteredGitReferences(
    host: AnalysisFeatureHost,
    messageContext: CollaborationApplicationMessageContext,
): Promise<void> {
    const [historical, evolution] = await Promise.all([
        host.historicalComparisonService?.getReferences(),
        host.projectEvolutionService?.getReferences(),
    ]);
    if (historical) {
        messageContext.broadcast({
            type: 'historical-comparison-references',
            payload: historical,
        });
    }
    if (evolution) {
        messageContext.broadcast({
            type: 'project-evolution-references',
            payload: evolution,
        });
    }
}

/**
 * Answer a references request to the requester only: the list, or a
 * `references-unavailable` error carrying the failure message.
 */
export async function replyWithReferences(
    messageContext: CollaborationApplicationMessageContext,
    options: {
        load: () => Promise<unknown>;
        referencesType: string;
        errorType: string;
    },
): Promise<void> {
    try {
        const references = await options.load();
        messageContext.send({
            type: options.referencesType,
            payload: references,
        });
    } catch (error) {
        messageContext.send({
            type: options.errorType,
            payload: {
                code: 'references-unavailable',
                message: error instanceof Error ? error.message : String(error),
            },
        });
    }
}

/**
 * The error payload of a failed start: a Git source error reports its own
 * code, any other Error its message, anything else the fallback code.
 */
/** What the room reads when a job is stopped by its deadline. */
const JOB_TIMEOUT_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
    'project-evolution-timeout': 'Generating the project evolution movie took more than 30 minutes and was stopped.',
    'comparison-timeout': 'The historical comparison took more than 15 minutes and was stopped.',
    'dependency-graph-timeout': 'The dependency analysis took more than 10 minutes and was stopped.',
});

export function describeBridgeError(
    error: unknown,
    fallbackCode: string,
): { code: string; message: string } {
    if (error instanceof JobCancelledError) {
        return {
            code: error.message,
            message: JOB_TIMEOUT_MESSAGES[error.message] || 'The analysis was stopped.',
        };
    }
    return {
        code: error instanceof GitAnalysisSourceError
            ? error.code
            : error instanceof Error
                ? error.message
                : fallbackCode,
        message: error instanceof Error ? error.message : String(error),
    };
}
