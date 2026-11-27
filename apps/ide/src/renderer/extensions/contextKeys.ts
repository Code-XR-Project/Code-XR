import type { ContextLookup } from '../../shared/whenClause.ts';

/**
 * #261: the context keys `when` clauses read: what extensions set with
 * `setContext`, and what the workbench knows (trust, folder, platform,
 * settings as `config.*`), plus the keys of the thing a menu is about
 * (`view`, `viewItem`, `resourceLangId`, ...), passed per lookup. Pure.
 */

export class ContextKeys {
    private readonly values = new Map<string, unknown>();
    private readonly providers: ((key: string) => unknown)[] = [];
    private readonly listeners = new Set<() => void>();
    private scheduled = false;

    /** A key `setContext` set; undefined removes it. Listeners hear once per task, however many keys changed. */
    set(key: string, value: unknown): void {
        if (value === undefined || value === null) {
            if (!this.values.delete(key)) {
                return;
            }
        } else if (this.values.get(key) === value && typeof value !== 'object') {
            return;
        } else {
            this.values.set(key, value);
        }
        this.changed();
    }

    /** Every key extensions set goes (their host stopped). */
    clear(): void {
        if (this.values.size > 0) {
            this.values.clear();
            this.changed();
        }
    }

    /** Keys the workbench answers itself; the first provider that knows a key (not undefined) wins. */
    addProvider(provider: (key: string) => unknown): void {
        this.providers.push(provider);
    }

    /** Something a provider reads changed (trust, a setting). */
    changed(): void {
        if (this.scheduled) {
            return;
        }
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            for (const listener of this.listeners) {
                listener();
            }
        });
    }

    onDidChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    get(key: string): unknown {
        if (this.values.has(key)) {
            return this.values.get(key);
        }
        for (const provider of this.providers) {
            const value = provider(key);
            if (value !== undefined) {
                return value;
            }
        }
        return undefined;
    }

    /** A lookup with `extra` keys on top (the item or file a menu is about). */
    lookup(extra: Readonly<Record<string, unknown>> = {}): ContextLookup {
        return (key) => (Object.prototype.hasOwnProperty.call(extra, key) ? extra[key] : this.get(key));
    }
}

/** The platform keys VS Code sets. */
export function platformContext(platform: string): (key: string) => unknown {
    return (key) => {
        switch (key) {
            case 'isLinux': return platform === 'linux';
            case 'isMac': return platform === 'darwin';
            case 'isWindows': return platform === 'win32';
            case 'isWeb': return false;
            case 'isDesktop': return true;
            default: return undefined;
        }
    };
}
