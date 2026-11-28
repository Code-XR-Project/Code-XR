/**
 * Agent Flow on an analysis server (#319): its sources are the agent sessions
 * of the analysed folder, its dataset lives under the static root, and its
 * entity is published to the room on every change. A file analysis has no
 * city for an agent to move through, so it gets the reason instead.
 *
 * Kept out of AnalysisFeatureHost so the host only holds one slot for the mode.
 */
import { AgentFlowService, registerAgentFlowController } from '../../agent-flow/agentFlowService';
import type { AgentFlowEntity } from '../../agent-flow/agentFlowModels';
import { analysisRefreshCoordinator } from '../../analysis/refresh/analysisRefreshCoordinator';

export interface AgentFlowSlot {
    readonly service: AgentFlowService | null;
    readonly reason: string;
}

export const AGENT_FLOW_NOT_ATTACHED: AgentFlowSlot = Object.freeze({
    service: null,
    reason: 'Agent flow is not available for this server.',
});

export interface AgentFlowWiringInput {
    /** False when the server's capabilities leave Agent Flow out. */
    readonly enabled: boolean;
    /** The analysed target; none for a server without a session. */
    readonly target: { readonly targetType: string; readonly targetPath: string } | null | undefined;
    readonly sessionId: string;
    readonly staticRoot: string;
    /** Upserts the entity into the room (no-op without one). */
    readonly publish: (entity: AgentFlowEntity) => void;
    /** Switches the scenes of this server to the agent-flow mode. */
    readonly activate: () => void;
    /** Where the wiring's disposers go (the host's refresh disposables). */
    readonly disposables: Array<() => void>;
}

export function wireAgentFlow(input: AgentFlowWiringInput): AgentFlowSlot {
    if (!input.enabled || !input.target) {
        return AGENT_FLOW_NOT_ATTACHED;
    }
    if (input.target.targetType === 'file') {
        return { service: null, reason: 'Agent flow needs a folder or project analysis.' };
    }
    const service = new AgentFlowService({ root: input.target.targetPath, staticRoot: input.staticRoot });
    input.disposables.push(
        service.onEntity((entity) => {
            analysisRefreshCoordinator.setSnapshotAvailable(input.sessionId, 'agent-flow', typeof entity.datasetUrl === 'string');
            input.publish(entity);
        }),
        analysisRefreshCoordinator.registerHandler(input.sessionId, 'agent-flow', async () => service.requestRefresh()),
        registerAgentFlowController({ service, activate: input.activate }),
    );
    return { service, reason: '' };
}

/** The `agentFlow` entry of the server's availability snapshot. */
export function agentFlowAvailability(slot: AgentFlowSlot): { enabled: boolean; reason: string | null } {
    return slot.service ? { enabled: true, reason: null } : { enabled: false, reason: slot.reason };
}

/** Disposes the slot's service and returns the empty slot. */
export function releaseAgentFlow(slot: AgentFlowSlot): AgentFlowSlot {
    slot.service?.dispose();
    return AGENT_FLOW_NOT_ATTACHED;
}
