/**
 * `vscode.workspace.getConfiguration` (#259): the defaults every extension
 * declares in `contributes.configuration`, overlaid with the person's values.
 * Keys are flat (`python.analysis.typeCheckingMode`); a section reads the
 * subtree under it, as VS Code does. Pure: values come in, updates go out
 * through the callback.
 */

export type ConfigurationTargetName = 'user' | 'workspace';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
    return value === undefined ? value : structuredClone(value);
}

/** The `properties` of a `contributes.configuration` (one object or an array of them), flattened to key -> default. */
export function configurationDefaults(contributes: Readonly<Record<string, unknown>>): Map<string, unknown> {
    const defaults = new Map<string, unknown>();
    const raw = contributes['configuration'];
    const sections = Array.isArray(raw) ? raw : [raw];
    for (const section of sections) {
        const properties = isRecord(section) ? section['properties'] : undefined;
        if (!isRecord(properties)) {
            continue;
        }
        for (const [key, schema] of Object.entries(properties)) {
            if (!isRecord(schema)) {
                continue;
            }
            if ('default' in schema) {
                defaults.set(key, schema['default']);
            } else {
                // VS Code derives a default from the type when none is given.
                const type = Array.isArray(schema['type']) ? schema['type'][0] : schema['type'];
                const byType: Record<string, unknown> = { string: '', boolean: false, number: 0, integer: 0, array: [], object: {}, null: null };
                if (typeof type === 'string' && type in byType) {
                    defaults.set(key, byType[type]);
                }
            }
        }
    }
    const overrides = contributes['configurationDefaults'];
    if (isRecord(overrides)) {
        for (const [key, value] of Object.entries(overrides)) {
            defaults.set(key, value);
        }
    }
    return defaults;
}

/** Sets `value` at the dotted `key` of a nested object. */
function assign(target: Record<string, unknown>, key: string, value: unknown): void {
    const parts = key.split('.');
    let node = target;
    for (const part of parts.slice(0, -1)) {
        const next = node[part];
        if (!isRecord(next)) {
            node[part] = {};
        }
        node = node[part] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1] ?? key;
    const existing = node[last];
    node[last] = isRecord(existing) && isRecord(value) ? { ...existing, ...clone(value) } : clone(value);
}

export interface ConfigurationInspect<T> {
    readonly key: string;
    readonly defaultValue?: T;
    readonly globalValue?: T;
    readonly workspaceValue?: T;
    readonly workspaceFolderValue?: T;
}

export interface WorkspaceConfiguration {
    get<T>(section: string, defaultValue?: T): T | undefined;
    has(section: string): boolean;
    inspect<T>(section: string): ConfigurationInspect<T> | undefined;
    update(section: string, value: unknown, target?: boolean | number | null): Promise<void>;
    readonly [key: string]: unknown;
}

export class ConfigurationModel {
    private defaults = new Map<string, unknown>();
    private user = new Map<string, unknown>();
    private readonly onUpdate: (key: string, value: unknown, target: ConfigurationTargetName) => Promise<void>;

    constructor(onUpdate: (key: string, value: unknown, target: ConfigurationTargetName) => Promise<void>) {
        this.onUpdate = onUpdate;
    }

    setDefaults(contributes: readonly Readonly<Record<string, unknown>>[]): void {
        this.defaults = new Map();
        for (const one of contributes) {
            for (const [key, value] of configurationDefaults(one)) {
                this.defaults.set(key, value);
            }
        }
    }

    /** Replaces the person's values; returns the keys whose effective value changed. */
    setUserValues(values: Readonly<Record<string, unknown>>): string[] {
        const next = new Map(Object.entries(values));
        const keys = new Set([...this.user.keys(), ...next.keys()]);
        const changed = [...keys].filter((key) => JSON.stringify(this.user.get(key)) !== JSON.stringify(next.get(key)));
        this.user = next;
        return changed;
    }

    private effective(): Map<string, unknown> {
        const merged = new Map(this.defaults);
        for (const [key, value] of this.user) {
            merged.set(key, value);
        }
        return merged;
    }

    /** The value at a full dotted key: a leaf, or the subtree assembled from the keys under it. */
    valueAt(key: string): unknown {
        const effective = this.effective();
        if (effective.has(key)) {
            const value = effective.get(key);
            // A leaf that is an object may still have keys under it set separately.
            if (!isRecord(value)) {
                return clone(value);
            }
        }
        const prefix = `${key}.`;
        const tree: Record<string, unknown> = {};
        let found = false;
        if (effective.has(key)) {
            Object.assign(tree, clone(effective.get(key)));
            found = true;
        }
        for (const [other, value] of effective) {
            if (other.startsWith(prefix)) {
                assign(tree, other.slice(prefix.length), value);
                found = true;
            }
        }
        return found ? tree : undefined;
    }

    /** Whether a change of `changedKey` affects `section` (`onDidChangeConfiguration`'s `affectsConfiguration`). */
    static affects(changedKey: string, section: string): boolean {
        return changedKey === section || changedKey.startsWith(`${section}.`) || section.startsWith(`${changedKey}.`);
    }

    get(section?: string): WorkspaceConfiguration {
        const base = section && section.trim() !== '' ? section : '';
        const full = (key: string): string => (base ? `${base}.${key}` : key);
        const subtree = base ? this.valueAt(base) : (() => {
            const tree: Record<string, unknown> = {};
            for (const [key, value] of this.effective()) {
                assign(tree, key, value);
            }
            return tree;
        })();
        const result: Record<string, unknown> = isRecord(subtree) ? subtree : {};
        const methods = {
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                const value = this.valueAt(full(key));
                return (value === undefined ? defaultValue : value) as T | undefined;
            },
            has: (key: string): boolean => this.valueAt(full(key)) !== undefined,
            inspect: <T>(key: string): ConfigurationInspect<T> | undefined => {
                const name = full(key);
                const defaultValue = this.defaults.get(name) as T | undefined;
                const globalValue = this.user.get(name) as T | undefined;
                return {
                    key: name,
                    ...(defaultValue !== undefined ? { defaultValue: clone(defaultValue) } : {}),
                    ...(globalValue !== undefined ? { globalValue: clone(globalValue) } : {}),
                };
            },
            update: async (key: string, value: unknown, target?: boolean | number | null): Promise<void> => {
                // ConfigurationTarget: 1 Global, 2 Workspace, 3 WorkspaceFolder; `true` means Global.
                const scope: ConfigurationTargetName = target === true || target === 1 || target === undefined || target === null ? 'user' : 'workspace';
                const name = full(key);
                await this.onUpdate(name, value === undefined ? undefined : clone(value), scope);
                if (value === undefined) {
                    this.user.delete(name);
                } else {
                    this.user.set(name, clone(value));
                }
            },
        };
        for (const [name, fn] of Object.entries(methods)) {
            Object.defineProperty(result, name, { value: fn, enumerable: false });
        }
        return Object.freeze(result) as WorkspaceConfiguration;
    }
}
