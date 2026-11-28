import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAgentTraceSources } from '@codexr/core/agent-flow/agentTraceSources';
import { AgentFlowService, registerAgentFlowController } from '@codexr/core/agent-flow/agentFlowService';
import type { AgentTraceEvent } from '@codexr/core/agent-flow/agentFlowModels';
import { AgentFlowFeed, agentFlowSourceId, rebasePath, transcriptAsEvents } from '../src/main/agentSessions/agentFlowFeed.ts';
import type { AgentSessionState, SessionEvent, TranscriptItem } from '../src/shared/agentSession.ts';

/** Agent Flow (#319, AG7): every IDE chat feeds the XR scene's fifth analysis. */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-agent-flow-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function project(name: string): string {
    const root = path.join(temp, name);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    return root;
}

function state(id: string, root: string, items: readonly TranscriptItem[] = [], extra: Partial<AgentSessionState> = {}): AgentSessionState {
    return {
        id, title: 'Fix the parser', agentRef: 'acp:claude-code', agentName: 'Claude Code', workspaceRoot: root,
        createdAt: '2026-11-28T09:00:00.000Z', updatedAt: '2026-11-28T09:00:00.000Z', status: 'idle', unread: false, pendingChanges: 0,
        items, ...extra,
    } as AgentSessionState;
}

function follow(sourceId: string, root: string): AgentTraceEvent[] {
    const source = listAgentTraceSources(root, { home: temp }).find((candidate) => candidate.id === sourceId);
    assert.ok(source, `${sourceId} is listed for ${root}`);
    const events: AgentTraceEvent[] = [];
    source.follow((batch) => events.push(...batch))();
    return events;
}

describe('Agent Flow feed of the IDE chats', () => {
    it('lists a chat as a live trace source of its project, seeded from what the chat already holds', () => {
        const root = project('seeded');
        const feed = new AgentFlowFeed(() => Date.parse('2026-11-28T09:05:00.000Z'));
        const items: TranscriptItem[] = [
            { kind: 'user', id: 'u1', text: 'Fix the parser', at: '2026-11-28T09:00:01.000Z' },
            { kind: 'tool', id: 't1', title: 'Read parser.ts', toolKind: 'read', status: 'completed', locations: [{ path: path.join(root, 'src/parser.ts') }], content: [] },
        ];
        const chat = state('s1', root, items);
        // The first event the feed sees is already in the transcript: it is drawn once.
        feed.onEvent({ state: chat, root, workRoot: root }, { type: 'tool', id: 't1', status: 'completed' });
        const events = follow(agentFlowSourceId('s1'), root);
        assert.deepEqual(events.map((event) => event.type), ['turn-start', 'step']);
        const step = events[1] as Extract<AgentTraceEvent, { type: 'step' }>;
        assert.equal(step.kind, 'read');
        assert.deepEqual(step.locations, [{ path: path.join(root, 'src/parser.ts') }]);
        assert.equal(listAgentTraceSources(project('elsewhere'), { home: temp }).some((source) => source.id === agentFlowSourceId('s1')), false);
        feed.dispose();
    });

    it('maps later events as they come, and keeps the title and liveness of the chat', () => {
        const root = project('live');
        const feed = new AgentFlowFeed(() => 1_000);
        const chat = state('s2', root);
        const info = { state: chat, root, workRoot: root };
        feed.onEvent(info, { type: 'status', status: 'running' });
        const later: SessionEvent[] = [
            { type: 'user', id: 'u1', text: 'Add a test', at: '2026-11-28T09:00:02.000Z' },
            { type: 'tool', id: 't1', title: 'Edit parser.ts', toolKind: 'edit', status: 'completed', content: [{ type: 'diff', path: path.join(root, 'src/parser.ts'), oldText: 'a', newText: 'a\nb' }] },
            { type: 'assistant-chunk', text: 'Done' },
            { type: 'title', title: 'Parser test' },
            { type: 'turn-end', id: 'e1', stopReason: 'end_turn', at: '2026-11-28T09:00:09.000Z' },
        ];
        for (const event of later) {
            feed.onEvent(info, event);
        }
        const source = listAgentTraceSources(root, { home: temp }).find((candidate) => candidate.id === agentFlowSourceId('s2'));
        assert.equal(source?.label(), 'Parser test');
        assert.equal(source?.isLive(), true);
        const events = follow(agentFlowSourceId('s2'), root);
        assert.deepEqual(events.map((event) => event.type), ['turn-start', 'step', 'turn-end']);
        const step = events[1] as Extract<AgentTraceEvent, { type: 'step' }>;
        assert.equal(step.kind, 'write');
        assert.equal(step.added, 2);
        feed.onEvent(info, { type: 'status', status: 'error' });
        assert.equal(source?.isLive(), false);
        feed.forget('s2');
        assert.equal(listAgentTraceSources(root, { home: temp }).some((candidate) => candidate.id === agentFlowSourceId('s2')), false);
    });

    it('moves the paths of a chat that works in a worktree onto the project folder', () => {
        const root = project('rebased');
        const worktree = path.join(temp, 'worktrees', 'rebased-1');
        assert.equal(rebasePath(path.join(worktree, 'src/a.ts'), worktree, root), path.join(root, 'src/a.ts'));
        assert.equal(rebasePath(path.join(temp, 'outside.ts'), worktree, root), path.join(temp, 'outside.ts'));
        assert.equal(rebasePath('src/a.ts', worktree, root), 'src/a.ts');
        const feed = new AgentFlowFeed(() => 1_000);
        const info = { state: state('s3', root), root, workRoot: worktree };
        feed.onEvent(info, { type: 'status', status: 'running' });
        feed.onEvent(info, { type: 'tool', id: 't1', toolKind: 'read', status: 'completed', locations: [{ path: path.join(worktree, 'src/a.ts'), line: 4 }] });
        const step = follow(agentFlowSourceId('s3'), root).find((event) => event.type === 'step') as Extract<AgentTraceEvent, { type: 'step' }>;
        assert.deepEqual(step.locations, [{ path: path.join(root, 'src/a.ts'), line: 4 }]);
        feed.dispose();
    });

    it('turns a permission request into a wait, allowed or rejected by the kind of the option picked', () => {
        const root = project('permission');
        const feed = new AgentFlowFeed(() => 1_000);
        const options = [{ id: 'yes', name: 'Allow', kind: 'allow_once' as const }, { id: 'no', name: 'Reject', kind: 'reject_once' as const }];
        let chat = state('s5', root);
        feed.onEvent({ state: chat, root, workRoot: root }, { type: 'status', status: 'running' });
        feed.onEvent({ state: chat, root, workRoot: root }, { type: 'permission', id: 'q1', title: 'Run npm test?', options });
        chat = state('s5', root, [{ kind: 'permission', id: 'q1', title: 'Run npm test?', options, outcome: 'no' }]);
        feed.onEvent({ state: chat, root, workRoot: root }, { type: 'permission-resolved', id: 'q1', outcome: 'no' });
        const waits = follow(agentFlowSourceId('s5'), root).filter((event) => event.type === 'step') as Extract<AgentTraceEvent, { type: 'step' }>[];
        assert.deepEqual(waits.map((step) => [step.kind, step.status]), [['wait', 'running'], ['wait', 'failed']]);
        feed.dispose();
    });

    it('replays a stored turn with its metric delta', () => {
        const events = transcriptAsEvents([
            { kind: 'user', id: 'u1', text: 'Go', at: '2026-11-28T09:00:00.000Z' },
            { kind: 'assistant', id: 'a1', text: 'Working' },
            {
                kind: 'turn-end', id: 'e1', stopReason: 'end_turn', at: '2026-11-28T09:01:00.000Z',
                metricDelta: { summary: '1 file', totals: [], files: [{ path: 'src/a.ts', status: 'modified', changes: [{ metric: 'codeLines', before: 10, after: 14 }] }], moreFiles: 0 },
            },
        ]);
        assert.deepEqual(events.map((entry) => entry.event.type), ['user', 'metric-delta', 'turn-end']);
    });

    it('Watch in XR opens the chat on the table of every scene of its project, and reaches none when no scene is open', () => {
        const root = project('watched');
        fs.writeFileSync(path.join(root, 'src/parser.ts'), 'export const a = 1;\n');
        const staticRoot = path.join(temp, 'watched-static');
        fs.mkdirSync(staticRoot, { recursive: true });
        fs.writeFileSync(path.join(staticRoot, 'data.json'), JSON.stringify([{ relativePath: 'src/parser.ts', codeLines: 40, cyclomaticComplexityNumber: 6, language: 'TypeScript' }]));
        const feed = new AgentFlowFeed(() => 1_000);
        const items: TranscriptItem[] = [
            { kind: 'user', id: 'u1', text: 'Read the parser', at: '2026-11-28T09:00:01.000Z' },
            { kind: 'tool', id: 't1', title: 'Read parser.ts', toolKind: 'read', status: 'completed', locations: [{ path: path.join(root, 'src/parser.ts') }], content: [] },
        ];
        const info = { state: state('s4', root, items), root, workRoot: root };
        assert.equal(feed.watch(info), 0);

        const service = new AgentFlowService({ root, staticRoot, discovery: { home: temp }, throttleMs: 10_000 });
        let activated = 0;
        const unregister = registerAgentFlowController({ service, activate: () => { activated += 1; } });
        try {
            assert.equal(feed.watch(info), 1);
            assert.equal(activated, 1);
            const dataset = service.rebuildNow();
            assert.ok(dataset);
            assert.equal(dataset.session.id, agentFlowSourceId('s4'));
            const read = dataset.steps.find((step) => step.kind === 'read');
            assert.ok(read, 'the read step is on the table');
            assert.equal(dataset.files[read.files[0]!]!.path, 'src/parser.ts');
        } finally {
            unregister();
            service.dispose();
            feed.dispose();
        }
    });
});
