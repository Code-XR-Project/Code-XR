/**
 * Pure helpers of the agent-first workbench (AF3, AF4): the layout modes and
 * the ids of chat tabs. No DOM.
 */

export type LayoutMode = 'agent' | 'classic';

/** The remembered layout mode; a new install starts in the Agent layout. */
export function parseLayoutMode(value: string | null | undefined): LayoutMode {
    return value === 'classic' ? 'classic' : 'agent';
}

/** Chat tabs live in the editor group under ids with this scheme. */
export const CHAT_ID_PREFIX = 'chat:';

export function chatTabId(sessionId: string): string {
    return `${CHAT_ID_PREFIX}${sessionId}`;
}

/** The session behind a chat tab id, or null for any other tab. */
export function chatIdOf(tabId: string): string | null {
    if (!tabId.startsWith(CHAT_ID_PREFIX)) {
        return null;
    }
    const id = tabId.slice(CHAT_ID_PREFIX.length);
    return id.length > 0 ? id : null;
}
