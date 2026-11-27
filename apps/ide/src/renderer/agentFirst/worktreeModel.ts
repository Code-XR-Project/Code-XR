import type { SessionWorktree, WorktreeStatusView } from '../../shared/agentSession.ts';

/**
 * AF12 (#277): the pure logic of a worktree chat's badge and Worktree bar.
 * No DOM, so it is unit-tested in test/agentFirst.test.ts.
 */

const AGENT_BRANCH_PREFIX = 'codexr/agent/';

/** The branch as the badge shows it: without the `codexr/agent/` prefix every agent branch has. */
export function branchLabel(worktree: Pick<SessionWorktree, 'branch'>): string {
    return worktree.branch.startsWith(AGENT_BRANCH_PREFIX) ? worktree.branch.slice(AGENT_BRANCH_PREFIX.length) : worktree.branch;
}

/** The badge's tooltip. */
export function branchTitle(worktree: SessionWorktree): string {
    return worktree.removed
        ? `This chat worked on the branch ${worktree.branch}; its worktree was discarded.`
        : `This chat's agent works in its own worktree on the branch ${worktree.branch} (${worktree.path}).`;
}

function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}

/** One line: what changed on the branch, and how it stands against the project's branch. */
export function worktreeSummary(status: WorktreeStatusView): string {
    if (status.removed) {
        return 'The worktree was discarded; this chat is kept read-only.';
    }
    if (!status.exists) {
        return `The worktree folder is missing. ${status.ahead > 0 ? `The branch still has ${plural(status.ahead, 'commit')}; merge it or discard it.` : 'Discard it to clean up.'}`;
    }
    const parts: string[] = [];
    if (status.files.length === 0) {
        parts.push('No changes yet');
    } else {
        const uncommitted = status.files.filter((file) => file.uncommitted).length;
        parts.push(`${plural(status.files.length, 'file')} changed${uncommitted > 0 ? ` (${uncommitted} uncommitted)` : ''}`);
    }
    parts.push(`${plural(status.ahead, 'commit')} ahead`);
    if (status.behind > 0) {
        parts.push(`${status.behind} behind ${status.into ?? 'the project'}`);
    }
    return parts.join(', ');
}

export interface WorktreeActions {
    readonly commit: boolean;
    readonly merge: boolean;
    readonly discard: boolean;
    /** Why Merge and Squash are off, when they are. */
    readonly mergeHint: string | null;
}

/** Which buttons of the bar are enabled; `busy` while the agent works or an action runs. */
export function worktreeActions(status: WorktreeStatusView | null, busy: boolean): WorktreeActions {
    if (!status || status.removed) {
        return { commit: false, merge: false, discard: false, mergeHint: null };
    }
    let mergeHint: string | null = null;
    if (status.into === null) {
        mergeHint = 'The project is not on a branch (detached HEAD).';
    } else if (status.hasUncommitted) {
        mergeHint = 'Commit the agent\'s changes first.';
    } else if (status.ahead === 0) {
        mergeHint = 'Nothing to merge yet.';
    }
    return {
        commit: !busy && status.exists && status.hasUncommitted,
        merge: !busy && mergeHint === null,
        discard: !busy,
        mergeHint,
    };
}

/** The commit message the bar suggests: the chat's title. */
export function suggestedCommitMessage(title: string): string {
    const line = title.replace(/\s+/g, ' ').trim();
    return line && line !== 'New chat' ? line : 'Changes by the agent';
}

/** What the person reads after a merge or a squash. */
export function mergeOutcome(result: { readonly strategy: 'merge' | 'squash'; readonly into: string; readonly nothingToMerge: boolean }): string {
    if (result.nothingToMerge) {
        return `Nothing to merge: ${result.into} already has these changes.`;
    }
    return result.strategy === 'merge' ? `Merged into ${result.into}.` : `Squashed into ${result.into} as one commit.`;
}

/** Whether the person's last "Separate worktree" choice is on (stored as '1'). */
export function parseWorktreeChoice(stored: string | null): boolean {
    return stored === '1';
}
