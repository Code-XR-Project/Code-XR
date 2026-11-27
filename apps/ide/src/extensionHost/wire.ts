import { Position, Range, Uri } from './types.ts';

/**
 * Values crossing the process boundary (#259): command arguments and
 * results travel as structured clones, so a `Uri`, `Position` or `Range`
 * goes as a tagged plain object and comes back as an instance. Functions and
 * cycles are dropped rather than failing the whole message.
 */

interface WireUri { readonly $uri: string }
interface WirePosition { readonly $pos: [number, number] }
interface WireRange { readonly $range: [number, number, number, number] }

export function toWire(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value ?? null;
    }
    if (typeof value === 'bigint') {
        return Number(value);
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
        return null;
    }
    if (value instanceof Uri) {
        return { $uri: value.toString() } satisfies WireUri;
    }
    if (value instanceof Range) {
        return { $range: [value.start.line, value.start.character, value.end.line, value.end.character] } satisfies WireRange;
    }
    if (value instanceof Position) {
        return { $pos: [value.line, value.character] } satisfies WirePosition;
    }
    if (typeof value !== 'object') {
        return null;
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp) {
        return value;
    }
    if (seen.has(value)) {
        return null;
    }
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
        result = value.map((item) => toWire(item, seen));
    } else {
        const record: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            if (typeof item !== 'function') {
                record[key] = toWire(item, seen);
            }
        }
        result = record;
    }
    // Only a cycle (a value inside itself) is dropped; the same object twice is kept.
    seen.delete(value);
    return result;
}

export function fromWire(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(fromWire);
    }
    if (ArrayBuffer.isView(value) || value instanceof Date || value instanceof RegExp) {
        return value;
    }
    const record = value as Record<string, unknown>;
    if (typeof record['$uri'] === 'string' && Object.keys(record).length === 1) {
        return Uri.parse(record['$uri']);
    }
    const position = record['$pos'];
    if (Array.isArray(position) && position.length === 2 && Object.keys(record).length === 1) {
        return new Position(Number(position[0]), Number(position[1]));
    }
    const range = record['$range'];
    if (Array.isArray(range) && range.length === 4 && Object.keys(record).length === 1) {
        return new Range(Number(range[0]), Number(range[1]), Number(range[2]), Number(range[3]));
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
        result[key] = fromWire(item);
    }
    return result;
}
