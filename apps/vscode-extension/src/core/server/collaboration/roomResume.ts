import type { CollaborationRoomState, ParticipantState } from './roomTypes';

/**
 * Coming back after a dropped connection (COLLAB-ROOM-2, story #360).
 *
 * Every browser tab keeps a random resume token for its whole life and sends
 * it with `room-join`. When a participant's last socket goes, the server
 * keeps who they were (name, avatar, role) under that token for a grace
 * period. A socket that rejoins with the token gets that identity back
 * instead of a new random name, and a host gets the host role back from the
 * guest it was handed to while they were away.
 *
 * The token only ever restores what the same tab already had: it cannot pick
 * another participant (the server stores it, never the client's claims), and
 * it expires.
 *
 * Pure functions over the room state; the room server calls them on join and
 * on leave.
 */

/** How long a dropped participant's identity is kept for its return. */
export const RESUME_GRACE_MS = 2 * 60 * 1000;

/** Tokens a room remembers at most; the oldest is forgotten first. */
const MAX_RESUMABLE = 64;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export interface ResumableParticipant {
    participant: ParticipantState;
    /** The participant had been handed the host role by the server, not by a person. */
    wasHost: boolean;
    expiresAt: number;
}

export interface RoomResumeState {
    resumable?: Map<string, ResumableParticipant>;
    /** Token of every joined participant, to remember it when they leave. */
    resumeTokens?: Map<string, string>;
    /**
     * Set when the host dropped and the server promoted a guest: that guest
     * holds the role only until the host comes back.
     */
    interimHostId?: string | null;
}

type ResumableRoom = CollaborationRoomState & RoomResumeState;

export function normalizeResumeToken(value: unknown): string | null {
    return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : null;
}

/** Remembers the token a joining participant presented. */
export function bindResumeToken(room: CollaborationRoomState, participantId: string, token: string | null): void {
    if (!token) {
        return;
    }
    const state = room as ResumableRoom;
    state.resumeTokens ??= new Map();
    state.resumeTokens.set(participantId, token);
}

/** The participant currently joined under this token, if any (a ghost of a dropped socket). */
export function participantHoldingToken(room: CollaborationRoomState, token: string | null): string | null {
    if (!token) {
        return null;
    }
    const state = room as ResumableRoom;
    for (const [participantId, held] of state.resumeTokens ?? []) {
        if (held === token && room.participants.has(participantId)) {
            return participantId;
        }
    }
    return null;
}

/** Keeps a leaving participant's identity for its return, under the token it joined with. */
export function rememberLeavingParticipant(
    room: CollaborationRoomState,
    participant: ParticipantState,
    now: number = Date.now(),
): void {
    const state = room as ResumableRoom;
    const token = state.resumeTokens?.get(participant.peerId);
    state.resumeTokens?.delete(participant.peerId);
    if (!token) {
        return;
    }
    state.resumable ??= new Map();
    pruneExpired(state, now);
    if (state.resumable.size >= MAX_RESUMABLE) {
        const oldest = state.resumable.keys().next().value;
        if (oldest) {
            state.resumable.delete(oldest);
        }
    }
    state.resumable.set(token, {
        participant: { ...participant, isPresenter: false },
        wasHost: participant.role === 'host',
        expiresAt: now + RESUME_GRACE_MS,
    });
}

/**
 * After a participant left the room: keeps their identity for their return,
 * and an interim host who left holds the role for nobody any more.
 */
export function noteParticipantLeft(room: CollaborationRoomState, participant: ParticipantState | undefined): void {
    if (participant) {
        rememberLeavingParticipant(room, participant);
    }
    if (interimHostOf(room) === null) {
        markInterimHost(room, null);
    }
}

/** Takes back the identity kept under this token, once; null when unknown or expired. */
export function takeResumable(
    room: CollaborationRoomState,
    token: string | null,
    now: number = Date.now(),
): ResumableParticipant | null {
    const state = room as ResumableRoom;
    if (!token || !state.resumable) {
        return null;
    }
    pruneExpired(state, now);
    const entry = state.resumable.get(token) ?? null;
    state.resumable.delete(token);
    return entry;
}

/** A removed participant leaves no identity to resume. */
export function forgetResumeToken(room: CollaborationRoomState, participantId: string): void {
    (room as ResumableRoom).resumeTokens?.delete(participantId);
}

/** Records the guest the server made host because the host dropped. */
export function markInterimHost(room: CollaborationRoomState, participantId: string | null): void {
    (room as ResumableRoom).interimHostId = participantId;
}

export function interimHostOf(room: CollaborationRoomState): string | null {
    const id = (room as ResumableRoom).interimHostId ?? null;
    return id && room.participants.has(id) ? id : null;
}

/** The room still keeps someone's identity for their return (do not drop the room yet). */
export function hasResumable(room: CollaborationRoomState, now: number = Date.now()): boolean {
    const state = room as ResumableRoom;
    pruneExpired(state, now);
    return (state.resumable?.size ?? 0) > 0;
}

function pruneExpired(state: ResumableRoom, now: number): void {
    for (const [token, entry] of state.resumable ?? []) {
        if (entry.expiresAt <= now) {
            state.resumable?.delete(token);
        }
    }
}
