import { RawData } from 'ws';

/**
 * Media frame wire format, mirrored by the runtime relay transport. The kind
 * byte packs both values: low nibble the frame kind, high nibble the temporal
 * layer the encoder put it in, so one encoded stream can be thinned per viewer
 * without ever encoding it twice.
 */
export const FRAME_HEADER_BYTES = 12;
export const FRAME_MAGIC_0 = 0x43; // 'C'
export const FRAME_MAGIC_1 = 0x58; // 'X'
export const FRAME_KIND_OFFSET = 3;
export const FRAME_KIND_MASK = 0x0f;
export const FRAME_LAYER_SHIFT = 4;
/** Delta video frames are droppable; keyframes, audio and config never are. */
export const FRAME_KIND_VIDEO_DELTA = 2;
/** A single frame larger than this is a bug or an attack, not a screen. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** What the relay needs to know about a frame; the payload is never read. */
export interface MediaFrameHeader {
    /** A video delta: the only kind a congested viewer may skip. */
    droppable: boolean;
    temporalLayer: number;
}

/** The frame as one buffer, or null when it is too short, too large or not ours. */
export function toFrameBuffer(raw: RawData): Buffer | null {
    const frame = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
            ? raw
            : Buffer.from(raw as ArrayBufferLike);

    if (frame.length < FRAME_HEADER_BYTES || frame.length > MAX_FRAME_BYTES) {
        return null;
    }
    if (frame[0] !== FRAME_MAGIC_0 || frame[1] !== FRAME_MAGIC_1) {
        return null;
    }
    return frame;
}

export function readFrameHeader(frame: Buffer): MediaFrameHeader {
    const kindByte = frame[FRAME_KIND_OFFSET];
    const droppable = (kindByte & FRAME_KIND_MASK) === FRAME_KIND_VIDEO_DELTA;
    const temporalLayer = kindByte >> FRAME_LAYER_SHIFT;
    return { droppable, temporalLayer };
}
