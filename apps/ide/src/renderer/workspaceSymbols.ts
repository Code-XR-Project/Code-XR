import type { PaletteSymbol, WorkspaceSymbolsState } from './commands/paletteModel.ts';

/**
 * #287: the symbols quick open lists after "#", asked of the language
 * servers (`workspace/symbol`) as the text changes. Asking waits for a short
 * pause in the typing, and an answer to an older query is dropped, so the
 * box shows the latest one only.
 */
export interface WorkspaceSymbolSearch {
    /** What is known for `query`; asks the servers when it is a new one (items null until they answer). */
    state(query: string): WorkspaceSymbolsState;
    /** Another folder opened: forget the last answer. */
    reset(): void;
}

export const SYMBOL_SEARCH_DELAY_MS = 120;

export function createWorkspaceSymbolSearch(
    search: (query: string) => Promise<readonly PaletteSymbol[]>,
    onLoaded: () => void,
    delayMs = SYMBOL_SEARCH_DELAY_MS,
): WorkspaceSymbolSearch {
    let current: WorkspaceSymbolsState | null = null;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    return {
        state(query) {
            if (query === '') {
                return { query, items: [] };
            }
            if (current?.query === query) {
                return current;
            }
            clearTimeout(timer);
            const asked = ++generation;
            current = { query, items: null };
            timer = setTimeout(() => {
                const settle = (items: readonly PaletteSymbol[]): void => {
                    if (asked === generation) {
                        current = { query, items };
                        onLoaded();
                    }
                };
                search(query).then(settle, () => settle([]));
            }, delayMs);
            return current;
        },
        reset() {
            clearTimeout(timer);
            generation++;
            current = null;
        },
    };
}
