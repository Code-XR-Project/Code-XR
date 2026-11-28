import {
    CollaborationApplicationMessageContext,
    CollaborationMessage,
} from '../collaboration/collaborationRoomServer';
import { AnalysisFeatureHost } from './analysisFeatureHost';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('AGENT_FLOW_BRIDGE');

/** Remote guests (a shared room over a tunnel) see the flow; only this machine picks what to show. */
const LOCAL_ONLY_MESSAGE = 'Only the person hosting this analysis can choose which agent session it shows.';

/**
 * Agent Flow feature bridge: the room messages that list the agent sessions
 * of the analysed folder, open one (the service then follows it and keeps
 * the shared `agent-flow` entity current) and close it.
 *
 * Protocol (client -> server): `agent-flow-sources-request` {},
 * `agent-flow-open` {sourceId}, `agent-flow-close` {}.
 * Replies: `agent-flow-sources` {sources, activeSourceId}, `agent-flow-error` {message}.
 */
export class AgentFlowBridge {
    constructor(private readonly host: AnalysisFeatureHost) {}

    private get service() {
        return this.host.agentFlowService;
    }

    public handleMessage(messageContext: CollaborationApplicationMessageContext, message: CollaborationMessage): boolean {
        const service = this.service;
        if (!service) {
            messageContext.send({ type: 'agent-flow-error', payload: { message: 'Agent flow is not available for this analysis.' } });
            return true;
        }
        if (message.type !== 'agent-flow-sources-request' && !messageContext.local) {
            messageContext.send({ type: 'agent-flow-error', payload: { message: LOCAL_ONLY_MESSAGE } });
            return true;
        }
        try {
            if (message.type === 'agent-flow-sources-request') {
                // Remote guests get the current session only: never the host's other history.
                const sources = messageContext.local
                    ? service.listSources()
                    : service.listSources().filter((source) => source.id === service.getEntity().sourceId);
                messageContext.send({ type: 'agent-flow-sources', payload: { sources, activeSourceId: service.getEntity().sourceId } });
                return true;
            }
            if (message.type === 'agent-flow-open') {
                const sourceId = String(message.payload?.sourceId ?? '');
                if (!sourceId) {
                    messageContext.send({ type: 'agent-flow-error', payload: { message: 'Pick an agent session first.' } });
                    return true;
                }
                service.open(sourceId);
                return true;
            }
            if (message.type === 'agent-flow-close') {
                service.close();
                return true;
            }
        } catch (error) {
            logger.warn('[CodeXR][AgentFlow] Request failed:', error);
            messageContext.send({
                type: 'agent-flow-error',
                payload: { message: error instanceof Error ? error.message : String(error) },
            });
            return true;
        }
        return false;
    }
}
