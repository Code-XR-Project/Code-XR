import { createHash, randomBytes } from 'node:crypto';

/**
 * Pure helpers of the agent worktrees (AF12, #277): branch and folder naming,
 * and the parsers of the git outputs worktreeManager.ts reads. No I/O, so it
 * is unit-tested without git.
 */

/** Every branch the IDE creates for an agent starts with this; nothing else is ever listed, merged or deleted. */
export const AGENT_BRANCH_PREFIX = 'codexr/agent/';

const MAX_SLUG_LENGTH = 32;

/** `label` reduced to lowercase ASCII words joined by `-`, at most 32 characters; `agent` when nothing is left. */
export function slugify(label: string): string {
    const slug = label
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_SLUG_LENGTH)
        .replace(/-+$/g, '');
    return slug || 'agent';
}

/** Six hex characters: unique enough among one person's parallel agents, short enough to read. */
export function shortId(): string {
    return randomBytes(3).toString('hex');
}

export function agentBranchName(label: string, id: string = shortId()): string {
    return `${AGENT_BRANCH_PREFIX}${slugify(label)}-${id}`;
}

export function isAgentBranch(branch: string): boolean {
    return branch.startsWith(AGENT_BRANCH_PREFIX) && branch.length > AGENT_BRANCH_PREFIX.length;
}

/**
 * The session id becomes a folder name and the worktree's name inside
 * `.git/worktrees/`, so it must be one safe path segment on every platform.
 */
export function isSafeSessionId(sessionId: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId) && !sessionId.endsWith('.') && !sessionId.includes('..');
}

/**
 * Names the folder of one repository's worktrees: a hash of its common git
 * directory, so every worktree of one repository (and a project opened from a
 * sub-folder) lands in the same place. Case-folded where the file system is.
 */
export function repoHash(commonGitDir: string, platform: NodeJS.Platform = process.platform): string {
    const normalized = platform === 'win32' || platform === 'darwin' ? commonGitDir.toLowerCase() : commonGitDir;
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** One entry of `git worktree list --porcelain -z`. */
export interface WorktreeListEntry {
    readonly path: string;
    readonly head: string | null;
    /** Short branch name (`refs/heads/` removed); null when detached or bare. */
    readonly branch: string | null;
    readonly bare: boolean;
    readonly locked: boolean;
    readonly prunable: boolean;
}

export function parseWorktreeList(stdout: string): WorktreeListEntry[] {
    const entries: WorktreeListEntry[] = [];
    let current: { path: string; head: string | null; branch: string | null; bare: boolean; locked: boolean; prunable: boolean } | null = null;
    for (const field of stdout.split('\0')) {
        if (field === '') {
            if (current) {
                entries.push(current);
            }
            current = null;
            continue;
        }
        const space = field.indexOf(' ');
        const key = space === -1 ? field : field.slice(0, space);
        const value = space === -1 ? '' : field.slice(space + 1);
        if (key === 'worktree') {
            if (current) {
                entries.push(current);
            }
            current = { path: value, head: null, branch: null, bare: false, locked: false, prunable: false };
            continue;
        }
        if (!current) {
            continue;
        }
        if (key === 'HEAD') {
            current.head = value;
        } else if (key === 'branch') {
            current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
        } else if (key === 'bare') {
            current.bare = true;
        } else if (key === 'locked') {
            current.locked = true;
        } else if (key === 'prunable') {
            current.prunable = true;
        }
    }
    if (current) {
        entries.push(current);
    }
    return entries;
}

export type WorktreeChangeStatus = 'added' | 'modified' | 'deleted';

/** `git diff --name-status -z --no-renames`: status letter, NUL, path, NUL, repeated. */
export function parseNameStatus(stdout: string): Map<string, WorktreeChangeStatus> {
    const changes = new Map<string, WorktreeChangeStatus>();
    const fields = stdout.split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
        const letter = fields[i] ?? '';
        const file = fields[i + 1] ?? '';
        if (!file) {
            continue;
        }
        changes.set(file, letter.startsWith('A') ? 'added' : letter.startsWith('D') ? 'deleted' : 'modified');
    }
    return changes;
}

/** One entry of `git status --porcelain=v1 -z --no-renames`. */
export interface PorcelainEntry {
    readonly path: string;
    /** Something is recorded in the index (relative to HEAD). */
    readonly staged: boolean;
    readonly untracked: boolean;
}

export function parsePorcelain(stdout: string): PorcelainEntry[] {
    const entries: PorcelainEntry[] = [];
    for (const field of stdout.split('\0')) {
        if (field.length < 4) {
            continue;
        }
        const x = field[0] ?? ' ';
        const y = field[1] ?? ' ';
        const untracked = x === '?' && y === '?';
        entries.push({ path: field.slice(3), staged: !untracked && x !== ' ' && x !== '!', untracked });
    }
    return entries;
}

/** NUL-separated paths (`--name-only -z`, `ls-files -z`). */
export function parseNulList(stdout: string): string[] {
    return stdout.split('\0').filter((entry) => entry !== '');
}
