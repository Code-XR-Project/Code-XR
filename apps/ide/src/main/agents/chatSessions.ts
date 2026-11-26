import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessageView, ChatSessionSummary } from '../../shared/agents.ts';

/** A chat as stored on disk (A5). */
export interface StoredSession {
    readonly version: 1;
    readonly id: string;
    readonly title: string;
    readonly agentId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly messages: readonly ChatMessageView[];
}

const ID_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * Chat sessions, one JSON file per chat under `<root>/<workspace key>/`, so
 * each folder keeps its own history and a window without a folder shares a
 * "no folder" list. Writes go through a temporary file and a rename.
 */
export class ChatSessions {
    private readonly root: string;

    constructor(root: string) {
        this.root = root;
    }

    /** The folder for a workspace: a hash of its path, so no path reaches a file name. */
    private dirOf(workspaceRoot: string | null): string {
        const key = workspaceRoot ? createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 24) : 'no-folder';
        return path.join(this.root, key);
    }

    private fileOf(workspaceRoot: string | null, id: string): string {
        if (!ID_PATTERN.test(id)) {
            throw new Error('Unknown chat.');
        }
        return path.join(this.dirOf(workspaceRoot), `${id}.json`);
    }

    async list(workspaceRoot: string | null): Promise<readonly ChatSessionSummary[]> {
        const dir = this.dirOf(workspaceRoot);
        let names: string[];
        try {
            names = await fs.promises.readdir(dir);
        } catch {
            return [];
        }
        const sessions = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
            try {
                return summaryOf(parseSession(await fs.promises.readFile(path.join(dir, name), 'utf8')));
            } catch {
                return null;
            }
        }));
        return sessions.filter((session): session is ChatSessionSummary => session !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    async get(workspaceRoot: string | null, id: string): Promise<StoredSession> {
        try {
            return parseSession(await fs.promises.readFile(this.fileOf(workspaceRoot, id), 'utf8'));
        } catch {
            throw new Error('That chat no longer exists.');
        }
    }

    async create(workspaceRoot: string | null, agentId: string): Promise<StoredSession> {
        const now = new Date().toISOString();
        const session: StoredSession = { version: 1, id: randomUUID(), title: 'New chat', agentId, createdAt: now, updatedAt: now, messages: [] };
        await this.write(workspaceRoot, session);
        return session;
    }

    async write(workspaceRoot: string | null, session: StoredSession): Promise<void> {
        const file = this.fileOf(workspaceRoot, session.id);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await fs.promises.writeFile(temporary, `${JSON.stringify(session)}\n`, 'utf8');
        await fs.promises.rename(temporary, file);
    }

    async rename(workspaceRoot: string | null, id: string, title: unknown): Promise<ChatSessionSummary> {
        if (typeof title !== 'string' || !title.trim()) {
            throw new Error('A chat needs a title.');
        }
        const session = { ...(await this.get(workspaceRoot, id)), title: title.trim().slice(0, 100) };
        await this.write(workspaceRoot, session);
        return summaryOf(session);
    }

    async delete(workspaceRoot: string | null, id: string): Promise<void> {
        await fs.promises.rm(this.fileOf(workspaceRoot, id), { force: true });
    }
}

export function summaryOf(session: StoredSession): ChatSessionSummary {
    return { id: session.id, title: session.title, agentId: session.agentId, updatedAt: session.updatedAt, messageCount: session.messages.length };
}

function parseSession(text: string): StoredSession {
    const parsed = JSON.parse(text) as Partial<StoredSession>;
    if (parsed.version !== 1 || typeof parsed.id !== 'string' || !Array.isArray(parsed.messages)) {
        throw new Error('Not a chat.');
    }
    return parsed as StoredSession;
}

/** A short title from the first message: its first line, cut at a word. */
export function titleFrom(text: string): string {
    const line = text.trim().split(/\r?\n/)[0] ?? '';
    if (line.length <= 48) {
        return line || 'New chat';
    }
    const cut = line.slice(0, 48);
    const space = cut.lastIndexOf(' ');
    return `${space > 20 ? cut.slice(0, space) : cut}…`;
}

/** The chat as Markdown (A5 export). */
export function sessionToMarkdown(session: StoredSession, agentName: string): string {
    const lines = [`# ${session.title}`, '', `Agent: ${agentName} · ${session.createdAt.slice(0, 10)}`, ''];
    for (const message of session.messages) {
        lines.push(message.role === 'user' ? '## You' : `## ${agentName}${message.model ? ` (${message.model})` : ''}`, '');
        lines.push(message.content || (message.error ? `_${message.error}_` : '_(no answer)_'), '');
    }
    return lines.join('\n');
}
