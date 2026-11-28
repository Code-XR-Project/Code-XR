import {
    CollaborationApplicationMessageContext,
    CollaborationMessage,
} from '../collaboration/collaborationRoomServer';
import { AnalysisFeatureHost } from './analysisFeatureHost';
import type { AgentFlowService } from '../../agent-flow/agentFlowService';
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
        return this.host.agentFlow.service;
    }

    public handleMessage(messageContext: CollaborationApplicationMessageContext, message: CollaborationMessage): boolean {
        const service = this.service;
        const refusal = !service
            ? 'Agent flow is not available for this analysis.'
            : (message.type !== 'agent-flow-sources-request' && !messageContext.local ? LOCAL_ONLY_MESSAGE : null);
        if (refusal || !service) {
            sendError(messageContext, refusal ?? LOCAL_ONLY_MESSAGE);
            return true;
        }
        const handler = HANDLERS.get(message.type);
        if (!handler) {
            return false;
        }
        try {
            handler(service, messageContext, message);
        } catch (error) {
            logger.warn('[CodeXR][AgentFlow] Request failed:', error);
            sendError(messageContext, error instanceof Error ? error.message : String(error));
        }
        return true;
    }
}

function sendError(messageContext: CollaborationApplicationMessageContext, message: string): void {
    messageContext.send({ type: 'agent-flow-error', payload: { message } });
}

type Handler = (service: AgentFlowService, messageContext: CollaborationApplicationMessageContext, message: CollaborationMessage) => void;

// A Map, not an object literal: a message type like `toString` must not find a handler.
const HANDLERS: ReadonlyMap<string, Handler> = new Map<string, Handler>([
    ['agent-flow-sources-request', (service, messageContext) => {
        // Remote guests get the current session only: never the host's other history.
        const activeSourceId = service.getEntity().sourceId;
        const sources = service.listSources().filter((source) => messageContext.local || source.id === activeSourceId);
        messageContext.send({ type: 'agent-flow-sources', payload: { sources, activeSourceId } });
    }],
    ['agent-flow-open', (service, messageContext, message) => {
        const sourceId = String(message.payload?.sourceId ?? '');
        if (sourceId) {
            service.open(sourceId);
        } else {
            sendError(messageContext, 'Pick an agent session first.');
        }
    }],
    ['agent-flow-close', (service) => {
        service.close();
    }],
]);
