import {
    CollaborationApplicationMessageContext,
    CollaborationMessage,
} from '../collaboration/collaborationRoomServer';
import type { DrillDownService } from '../../drilldown/drillDownService';
import { DRILL_DOWN_MESSAGES } from '../../drilldown/drillDownModels';
import type { DrillTargetKind } from '../../drilldown/drillDownModels';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('DRILL_DOWN_BRIDGE');

/**
 * Drill-down feature bridge (#335): the room messages that open a file or
 * folder of the analysis on the table, move through the history and go
 * home. The service publishes the shared `drill-down` entity, so every peer
 * (and a late joiner) follows the same view, like any analysis mode; any peer
 * may drive it, as with the mode selector, since it only reads the project.
 *
 * Protocol (client -> server): `drilldown-open` {path, kind},
 * `drilldown-goto` {relativePath, kind}, `drilldown-back` {},
 * `drilldown-forward` {}, `drilldown-home` {}, `drilldown-state-request` {}
 * (a scene that joined before any jump asks for the entity).
 * Reply on failure: `drilldown-error` {message} to the requester.
 */
export class DrillDownBridge {
    private readonly getService: () => DrillDownService | null;

    constructor(getService: () => DrillDownService | null) {
        this.getService = getService;
    }

    public async handleMessage(messageContext: CollaborationApplicationMessageContext, message: CollaborationMessage): Promise<boolean> {
        const handler = HANDLERS.get(message.type);
        if (!handler) {
            return false;
        }
        const service = this.getService();
        if (!service) {
            sendError(messageContext, 'Drill-down is not available for this analysis.');
            return true;
        }
        try {
            await handler(service, message);
        } catch (error) {
            logger.debug(() => `[CodeXR][DrillDown] ${message.type} refused: ${error instanceof Error ? error.message : String(error)}`);
            sendError(messageContext, error instanceof Error ? error.message : String(error));
        }
        return true;
    }
}

function sendError(messageContext: CollaborationApplicationMessageContext, message: string): void {
    messageContext.send({ type: DRILL_DOWN_MESSAGES.error, payload: { message } });
}

function kindOf(message: CollaborationMessage): DrillTargetKind {
    return message.payload?.kind === 'file' ? 'file' : 'directory';
}

type Handler = (service: DrillDownService, message: CollaborationMessage) => Promise<unknown>;

// A Map, not an object literal: a message type like `toString` must not find a handler.
const HANDLERS: ReadonlyMap<string, Handler> = new Map<string, Handler>([
    [DRILL_DOWN_MESSAGES.open, (service, message) => service.open(String(message.payload?.path ?? ''), kindOf(message))],
    [DRILL_DOWN_MESSAGES.goto, (service, message) => service.goto(String(message.payload?.relativePath ?? ''), kindOf(message))],
    [DRILL_DOWN_MESSAGES.back, (service) => service.back()],
    [DRILL_DOWN_MESSAGES.forward, (service) => service.forward()],
    [DRILL_DOWN_MESSAGES.home, (service) => service.goHome()],
    [DRILL_DOWN_MESSAGES.state, async (service) => service.publishCurrent()],
]);
