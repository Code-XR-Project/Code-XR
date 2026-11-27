/** Which client joined a collaborative session: the CodeXR extension or a plain browser. */
export type CollaborationClientKind = 'codexr' | 'browser';

export interface ConnectedParticipantSummary {
    peerId: string;
    displayName: string;
    avatarId: string;
    clientKind: CollaborationClientKind;
    connectionScope: 'local' | 'remote';
    connectedAt: string;
    role: 'host' | 'guest';
    remoteAddress: string;
}
