import { Disposable } from './types.ts';

/**
 * Unimplemented VS Code API (#259, ADR 0002): instead of crashing an
 * extension on `undefined is not a function`, the host hands back values that
 * absorb every use, and reports the first use of each name so the
 * *Extensions* output channel says what an extension missed.
 */

const NOOP_EVENT = (): Disposable => new Disposable(() => undefined);

/**
 * A value that can be called, read and disposed at any depth: calling it or
 * reading a property gives another one. `then` stays undefined so an `await`
 * on it resolves at once instead of hanging.
 */
export function inert(): unknown {
    const target = function inertValue(): unknown {
        return inert();
    };
    return new Proxy(target, {
        get(_target, property) {
            if (property === 'then' || typeof property === 'symbol') {
                return property === Symbol.toPrimitive ? () => '' : undefined;
            }
            if (property === 'dispose') {
                return () => undefined;
            }
            if (property === 'toString' || property === 'toJSON') {
                return () => '';
            }
            if (property.startsWith('onDid') || property.startsWith('onWill')) {
                return NOOP_EVENT;
            }
            return inert();
        },
        apply() {
            return inert();
        },
        set() {
            return true;
        },
    });
}

/** What an unknown member of a namespace stands in with, by the shape its name implies. */
export function stubFor(name: string): unknown {
    if (/^on[A-Z]/.test(name)) {
        return NOOP_EVENT;
    }
    if (/^(register|create|add)[A-Z]/.test(name)) {
        return () => inert();
    }
    if (/^(get|find|fetch|show|open|select|execute|request|resolve)[A-Z]?/.test(name)) {
        return () => Promise.resolve(undefined);
    }
    return undefined;
}

/**
 * Wraps a namespace (`window`, `workspace`, ...) so a member the host does
 * not implement is reported once (per name) and replaced by `stubFor(name)`.
 */
export function withFallback<T extends object>(namespace: string, implemented: T, report: (api: string) => void): T {
    return new Proxy(implemented, {
        get(target, property, receiver) {
            if (typeof property === 'symbol' || property in target) {
                return Reflect.get(target, property, receiver) as unknown;
            }
            if (property === 'then') {
                return undefined;
            }
            report(`${namespace}.${property}`);
            return stubFor(property);
        },
    });
}

/** A whole namespace the host does not implement yet (`tests`, `chat`, ...): every member is a stub. */
export function missingNamespace(namespace: string, report: (api: string) => void, known: Readonly<Record<string, unknown>> = {}): unknown {
    return withFallback(namespace, { ...known }, report);
}
