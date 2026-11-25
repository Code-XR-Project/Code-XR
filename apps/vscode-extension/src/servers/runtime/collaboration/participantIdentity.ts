import { buildStarWarsDisplayName } from '../../../collaboration/model/anonymousName';
import { CollaborationProfile } from '../../../collaboration/model/collaborationProfile';
import { normalizeId } from './roomMessageCodec';
import {
    CollaborationPeer,
    CollaborationRoomState,
    ParticipantState,
    SharedPresenceState,
} from './roomTypes';

/**
 * Who a participant is inside one room: the display name (sanitized, unique
 * per room, a generated anonymous one when none was chosen) and the avatar
 * colour (an explicit one wins, otherwise the least-used in the room). Pure
 * functions over the room state; nothing here sends or broadcasts.
 */

/** Sentinel meaning "this room picks a free colour for me". */
export const AUTO_AVATAR_ID = 'auto';
export const CODEXR_AVATAR_IDS = [
    'avatar-1',
    'avatar-2',
    'avatar-3',
    'avatar-4',
    'avatar-5',
    'avatar-6',
] as const;
const VALID_AVATAR_IDS = new Set<string>(CODEXR_AVATAR_IDS);

export function getParticipantPresence(participant: ParticipantState): Pick<
    SharedPresenceState,
    'displayName' | 'identityMode' | 'avatarId' | 'role' | 'isPresenter'
> {
    return {
        displayName: participant.displayName,
        identityMode: participant.identityMode,
        avatarId: participant.avatarId,
        role: participant.role,
        isPresenter: participant.isPresenter,
    };
}

function sanitizeDisplayName(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    const sanitized = value
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const characterCount = Array.from(sanitized).length;
    return characterCount >= 2 && characterCount <= 32 ? sanitized : '';
}

function createUniqueDisplayName(room: CollaborationRoomState, requestedName: string, peerId: string): string {
    const existingNames = new Set(
        Array.from(room.participants.values())
            .filter((participant) => participant.peerId !== peerId)
            .map((participant) => participant.displayName.toLocaleLowerCase()),
    );
    if (!existingNames.has(requestedName.toLocaleLowerCase())) {
        return requestedName;
    }

    for (let suffix = 2; suffix < 10_000; suffix += 1) {
        const suffixText = ` ${suffix}`;
        const maxBaseLength = 32 - suffixText.length;
        const base = Array.from(requestedName).slice(0, maxBaseLength).join('').trimEnd();
        const candidate = `${base}${suffixText}`;
        if (!existingNames.has(candidate.toLocaleLowerCase())) {
            return candidate;
        }
    }
    return `${Array.from(requestedName).slice(0, 23).join('')} ${peerId.slice(-6)}`;
}

export function applyProfileToParticipant(
    room: CollaborationRoomState,
    peer: CollaborationPeer,
    participant: ParticipantState,
    profile: CollaborationProfile,
): void {
    // An explicit colour always wins; `auto` (and anything invalid) gets a
    // colour nobody else in this room is wearing.
    const avatarId = normalizeAvatarId(profile.avatarId)
        || assignDistinctAvatarId(room, peer.id);
    const customName = profile.identityMode === 'custom'
        ? sanitizeDisplayName(profile.customName)
        : '';
    if (customName) {
        participant.identityMode = 'custom';
        participant.displayName = createUniqueDisplayName(room, customName, peer.id);
    } else {
        participant.identityMode = 'anonymous';
        const anonymousName = peer.anonymousDisplayName || createAnonymousName(room);
        participant.displayName = createUniqueDisplayName(room, anonymousName, peer.id);
        peer.anonymousDisplayName = participant.displayName;
    }
    participant.avatarId = avatarId;
}

export function createAnonymousName(room: CollaborationRoomState): string {
    let candidate = '';
    do {
        candidate = buildStarWarsDisplayName(room.nextDisplayNameIndex);
        room.nextDisplayNameIndex += 1;
    } while (
        Array.from(room.participants.values())
            .some((participant) => participant.displayName.toLocaleLowerCase() === candidate.toLocaleLowerCase())
    );
    return candidate;
}

function normalizeAvatarId(value: unknown): string {
    const avatarId = normalizeId(value);
    return VALID_AVATAR_IDS.has(avatarId) ? avatarId : '';
}

/**
 * Pick a palette colour none of the other participants is using, so a room
 * of players who never chose one still reads as distinct people. Past the
 * palette size the least-used colour is reused.
 */
function assignDistinctAvatarId(room: CollaborationRoomState, peerId: string): string {
    const usage = new Map<string, number>(CODEXR_AVATAR_IDS.map((id) => [id, 0]));
    for (const participant of room.participants.values()) {
        if (participant.peerId === peerId) {
            continue;
        }
        const current = usage.get(participant.avatarId);
        if (current !== undefined) {
            usage.set(participant.avatarId, current + 1);
        }
    }

    let chosen = CODEXR_AVATAR_IDS[0] as string;
    let lowest = Number.POSITIVE_INFINITY;
    for (const [avatarId, count] of usage) {
        if (count < lowest) {
            chosen = avatarId;
            lowest = count;
        }
    }
    return chosen;
}
