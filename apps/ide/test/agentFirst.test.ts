import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentView, ProjectSessions, SessionSummary, TranscriptItem } from '../src/shared/agentSession.ts';
import { applySessionEvent, emptySession, summarize, titleFromPrompt } from '../src/shared/agentSession.ts';
import {
    attachmentLabel, changeCounts, composerAction, diffLinesForCard, displayPath, formatTokens, lastUserIndex, slashSuggestions, turnChanges,
} from '../src/renderer/agentFirst/chatModel.ts';
import { attentionCounts, defaultAgent, filterProjects, shortTime, statusLabel } from '../src/renderer/agentFirst/sessionsModel.ts';
import { chatIdOf, chatTabId, parseLayoutMode } from '../src/renderer/agentFirst/agentWorkbenchModel.ts';
import {
    changesIdOf, changesSummary, changesTabId, formatMetricChange, metricDeltaFileLines, metricDeltaHeadline, nextSelection, restorePrompt, statusLetter,
} from '../src/renderer/agentFirst/changesModel.ts';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 's1', title: 'Fix login', agentRef: 'acp:claude', agentName: 'Claude Code', workspaceRoot: '/p',
        createdAt: '2026-11-27T10:00:00.000Z', updatedAt: '2026-11-27T10:00:00.000Z', status: 'idle', unread: false, pendingChanges: 0,
        ...overrides,
    };
}

function agent(overrides: Partial<AgentView>): AgentView {
    return { ref: 'acp:x', name: 'X', kind: 'acp', description: '', availability: 'ready', ...overrides };
}

describe('agent workbench model', () => {
    it('defaults to the Agent layout and remembers Classic', () => {
        assert.equal(parseLayoutMode(null), 'agent');
        assert.equal(parseLayoutMode('nonsense'), 'agent');
        assert.equal(parseLayoutMode('classic'), 'classic');
    });

    it('round-trips chat tab ids and ignores other tabs', () => {
        assert.equal(chatIdOf(chatTabId('abc')), 'abc');
        assert.equal(chatIdOf('/home/me/file.ts'), null);
        assert.equal(chatIdOf('chat:'), null);
    });
});

describe('chat model', () => {
    it('suggests slash commands only for a leading slash', () => {
        const commands = [{ name: 'review', description: '' }, { name: 'compact', description: '' }];
        assert.deepEqual(slashSuggestions('/re', commands).map((c) => c.name), ['review']);
        assert.deepEqual(slashSuggestions('/', commands).length, 2);
        assert.deepEqual(slashSuggestions('hi /re', commands), []);
    });

    it('draws a compact diff with context and gaps', () => {
        const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
        const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h'].join('\n');
        const lines = diffLinesForCard(before, after, 1);
        assert.deepEqual(lines.map((l) => l.kind), ['gap', 'context', 'remove', 'add', 'context', 'gap']);
        assert.deepEqual(changeCounts(before, after), { added: 1, removed: 1 });
        assert.deepEqual(diffLinesForCard(null, 'x\ny').map((l) => l.kind), ['add', 'add']);
        assert.deepEqual(changeCounts(null, 'x\ny'), { added: 2, removed: 0 });
    });

    it('never shows a line twice when two hunks are close', () => {
        const before = ['export function total() {', '    let sum = 0;', '    loop();', '}'].join('\n');
        const after = ['function helper() {}', '', 'export function total() {', '    return helper();', '}'].join('\n');
        const texts = diffLinesForCard(before, after).filter((line) => line.kind !== 'add').map((line) => line.text);
        assert.equal(texts.filter((text) => text === '    let sum = 0;').length, 1);
    });

    it('caps a huge diff', () => {
        const lines = diffLinesForCard(null, Array.from({ length: 1000 }, (_, i) => String(i)).join('\n'), 2, 10);
        assert.equal(lines.length, 11);
        assert.equal(lines.at(-1)?.text, '990 more lines');
    });

    it('shows paths relative to the project', () => {
        assert.equal(displayPath('/p/src/a.ts', '/p'), 'src/a.ts');
        assert.equal(displayPath('C:\\P\\src\\a.ts', 'c:\\p\\'), 'src/a.ts');
        assert.equal(displayPath('/other/a.ts', '/p'), '/other/a.ts');
    });

    it('picks the composer action', () => {
        assert.equal(composerAction({ status: 'idle' }, 'hi'), 'send');
        assert.equal(composerAction({ status: 'running' }, 'hi'), 'queue');
        assert.equal(composerAction({ status: 'awaiting' }, ' '), 'stop');
        assert.equal(composerAction({ status: 'idle' }, ''), 'none');
    });

    it('collects the files a turn changed, keeping the first old text', () => {
        const items: TranscriptItem[] = [
            { kind: 'user', id: 'u1', text: 'go', at: '' },
            { kind: 'tool', id: 't1', title: 'Edit', toolKind: 'edit', status: 'completed', locations: [], content: [{ type: 'diff', path: 'a.ts', oldText: 'v0', newText: 'v1' }] },
            { kind: 'tool', id: 't2', title: 'Edit', toolKind: 'edit', status: 'completed', locations: [], content: [{ type: 'diff', path: 'a.ts', oldText: 'v1', newText: 'v2' }] },
        ];
        assert.equal(lastUserIndex(items), 0);
        assert.deepEqual(turnChanges(items, 0), [{ path: 'a.ts', oldText: 'v0', newText: 'v2' }]);
    });

    it('labels attachments and token use', () => {
        assert.equal(attachmentLabel({ kind: 'selection', path: 'a.ts', startLine: 3, endLine: 9 }), 'a.ts:3-9');
        assert.equal(attachmentLabel({ kind: 'file', path: 'a.ts' }), 'a.ts');
        assert.equal(formatTokens(12_400, 200_000), '12k / 200k');
        assert.equal(formatTokens(900, 1_000_000), '900 / 1M');
    });
});

describe('sessions model', () => {
    const projects: ProjectSessions[] = [
        { root: '/p', name: 'shop', current: true, sessions: [summary({ id: 'a', status: 'running' }), summary({ id: 'b', title: 'Write tests', status: 'awaiting', unread: true })] },
        { root: '/q', name: 'blog', current: false, sessions: [summary({ id: 'c', title: 'Fix CSS', agentName: 'Codex' })] },
    ];

    it('filters by project, title and agent', () => {
        assert.equal(filterProjects(projects, '').length, 2);
        assert.deepEqual(filterProjects(projects, 'shop')[0]?.sessions.length, 2);
        assert.deepEqual(filterProjects(projects, 'tests').map((p) => p.sessions.map((s) => s.id)), [['b']]);
        assert.deepEqual(filterProjects(projects, 'codex').map((p) => p.name), ['blog']);
    });

    it('counts what needs attention', () => {
        assert.deepEqual(attentionCounts(projects), { running: 1, waiting: 1, unread: 1 });
    });

    it('labels statuses', () => {
        assert.equal(statusLabel({ status: 'idle', unread: true }), 'Done, not read yet');
        assert.equal(statusLabel({ status: 'awaiting', unread: true }), 'Needs your approval');
    });

    it('writes short relative times', () => {
        const now = Date.parse('2026-11-27T12:00:00.000Z');
        assert.equal(shortTime('2026-11-27T11:59:30.000Z', now), 'now');
        assert.equal(shortTime('2026-11-27T11:55:00.000Z', now), '5 min');
        assert.equal(shortTime('2026-11-27T09:00:00.000Z', now), '3 h');
        assert.equal(shortTime('2026-11-25T12:00:00.000Z', now), '2 d');
        assert.equal(shortTime('2026-10-01T12:00:00.000Z', now), '2026-10-01');
        assert.equal(shortTime('bad', now), '');
    });

    it('chooses the default agent', () => {
        const agents = [agent({ ref: 'builtin:x', kind: 'builtin' }), agent({ ref: 'acp:claude' }), agent({ ref: 'acp:codex', availability: 'missing' })];
        assert.equal(defaultAgent(agents, 'acp:codex')?.ref, 'acp:claude');
        assert.equal(defaultAgent(agents, 'builtin:x')?.ref, 'acp:claude');
        assert.equal(defaultAgent([], null), null);
    });
});

describe('session events', () => {
    it('streams chunks, waits on a permission and ends the turn unread', () => {
        let state = emptySession({ id: 's', title: 'New chat', agentRef: 'acp:claude', agentName: 'Claude Code', workspaceRoot: '/p', createdAt: '', updatedAt: '' });
        state = applySessionEvent(state, { type: 'assistant-chunk', text: 'Hel' });
        state = applySessionEvent(state, { type: 'assistant-chunk', text: 'lo' });
        assert.equal(state.items.filter((item) => item.kind === 'assistant').length, 1);
        assert.equal(titleFromPrompt('  Fix the login\nbug please '), 'Fix the login bug please');
        const s = summarize(state);
        assert.equal(s.id, 's');
    });
});

describe('instructions model', async () => {
    const { instructionEntries, otherRuleFiles, splitWorkspacePath } = await import('../src/renderer/agentFirst/instructionsModel.ts');

    it('marks which instruction files the project has', () => {
        const entries = instructionEntries(['agents.md', 'src/a.ts']);
        assert.equal(entries.find((entry) => entry.path === 'AGENTS.md')?.exists, true);
        assert.equal(entries.find((entry) => entry.path === 'CLAUDE.md')?.exists, false);
    });

    it('finds other rule files', () => {
        assert.deepEqual(otherRuleFiles(['AGENTS.md', 'pkg/AGENTS.md', '.cursor/rules/style.mdc', 'README.md', '.cursorrules']), ['.cursor/rules/style.mdc', '.cursorrules', 'pkg/AGENTS.md']);
    });

    it('splits a workspace path', () => {
        assert.deepEqual(splitWorkspacePath('.github/copilot-instructions.md'), { parent: '.github', name: 'copilot-instructions.md' });
        assert.deepEqual(splitWorkspacePath('AGENTS.md'), { parent: '', name: 'AGENTS.md' });
    });
});

describe('changes model (AF5, AF6, AF9)', () => {
    const file = (path: string, status: 'added' | 'modified' | 'deleted' = 'modified', additions = 1, deletions = 0) => ({ path, status, additions, deletions, binary: false });

    it('names Changes tabs apart from chat tabs', () => {
        assert.equal(changesTabId('s1'), 'chat-changes:s1');
        assert.equal(changesIdOf('chat-changes:s1'), 's1');
        assert.equal(changesIdOf('chat-changes:'), null);
        assert.equal(changesIdOf('chat:s1'), null);
        assert.equal(chatIdOf(changesTabId('s1')), null, 'a Changes tab is not a chat tab');
    });

    it('summarises the list and keeps the selection sensible as files go', () => {
        assert.equal(changesSummary([]), 'No pending changes.');
        assert.equal(changesSummary([file('a', 'modified', 3, 1), file('b', 'added', 2, 0)]), '2 files, +5 -1');
        assert.equal(changesSummary([file('a')]), '1 file, +1 -0');
        assert.deepEqual(['added', 'modified', 'deleted'].map((status) => statusLetter(status as 'added')), ['A', 'M', 'D']);
        const files = [file('a'), file('b'), file('c')];
        assert.equal(nextSelection(files, 'b', 1), 'b');
        assert.equal(nextSelection([file('a'), file('c')], 'b', 1), 'c', 'the next file takes the place of the one kept');
        assert.equal(nextSelection([file('a')], 'c', 2), 'a');
        assert.equal(nextSelection(files, null), 'a');
        assert.equal(nextSelection([], 'a'), null);
    });

    it('words the restore confirmation', () => {
        assert.match(restorePrompt(['a.ts', 'b.ts']), /^Restore 2 files /);
        assert.match(restorePrompt(['a.ts']), /^Restore 1 file /);
        assert.match(restorePrompt([]), /already as they were/);
    });

    it('formats a metric delta compactly, levels as before -> after and counts as a difference', () => {
        assert.equal(formatMetricChange({ metric: 'maxComplexity', before: 9, after: 1 }), 'Complexity max 9 -> 1');
        assert.equal(formatMetricChange({ metric: 'codeLines', before: 20, after: 14 }), 'LOC -6');
        assert.equal(formatMetricChange({ metric: 'functionCount', before: 2, after: 3 }), 'Functions +1');
        assert.equal(formatMetricChange({ metric: 'codeLines', before: null, after: 10 }), 'LOC - -> 10');
        const delta = {
            summary: '2 files (1 changed, 1 added)',
            totals: [{ metric: 'maxComplexity', before: 9, after: 1 }, { metric: 'codeLines', before: 20, after: 14 }, { metric: 'functionCount', before: 2, after: 3 }, { metric: 'classCount', before: 0, after: 1 }],
            files: [{ path: 'src/a.ts', status: 'changed', changes: [{ metric: 'maxComplexity', before: 9, after: 1 }] }, { path: 'src/b.ts', status: 'added', changes: [] }],
            moreFiles: 2,
        };
        assert.equal(metricDeltaHeadline(delta), 'Complexity max 9 -> 1, LOC -6, Functions +1');
        assert.equal(metricDeltaHeadline({ ...delta, totals: [] }), delta.summary);
        assert.deepEqual(metricDeltaFileLines(delta), ['src/a.ts (changed): Complexity max 9 -> 1', 'src/b.ts (added)', 'and 2 more files']);
    });
});
