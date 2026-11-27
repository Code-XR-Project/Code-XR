import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agent, methods, type AgentContext } from '@agentclientprotocol/sdk';
import { applySessionEvent, emptySession, type AgentSessionState, type WorktreeStatusView } from '../src/shared/agentSession.ts';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';
import { AcpConnection } from '../src/main/agentSessions/acpConnection.ts';
import { AgentCatalog } from '../src/main/agentSessions/agentCatalog.ts';
import { AgentSessionService, type WindowPort } from '../src/main/agentSessions/agentSessionService.ts';
import { SessionStore } from '../src/main/agentSessions/sessionStore.ts';
import { SessionChanges } from '../src/main/checkpoints/sessionChanges.ts';
import {
    branchLabel, mergeOutcome, parseWorktreeChoice, suggestedCommitMessage, worktreeActions, worktreeSummary,
} from '../src/renderer/agentFirst/worktreeModel.ts';

/**
 * AF12 (#277): chats in their own git worktree, end to end through
 * AgentSessionService with a real temporary repository and an in-process
 * fake ACP agent (the pattern of agentSessions.test.ts).
 */

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-agent-worktrees-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('GIT_')) {
            env[key] = value;
        }
    }
    return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

function repo(name: string): string {
    const root = path.join(base, name, 'project');
    fs.mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Test Person');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'initial');
    return root;
}

interface AgentLog {
    connectCwds: string[];
    sessionCwds: string[];
}

/** A tiny ACP agent: `write <path>`, `read <path>`, `pwd` (a terminal), anything else ends the turn. */
function fakeAgent(log: AgentLog) {
    let client: AgentContext | null = null;
    const say = (sessionId: string, text: string): Promise<void> => (client as AgentContext).notify(methods.client.session.update, { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
    return agent({ name: 'fake' })
        .onConnect((connection) => {
            client = connection.client;
        })
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }))
        .onRequest(methods.agent.session.new, ({ params }) => {
            log.sessionCwds.push(params.cwd);
            return { sessionId: 'agent-1' };
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client: ctx }) => {
            const first = params.prompt[0];
            const [command, arg] = (first?.type === 'text' ? first.text : '').split(' ');
            const sid = params.sessionId;
            try {
                if (command === 'write') {
                    await ctx.request(methods.client.fs.writeTextFile, { sessionId: sid, path: arg ?? '', content: 'written\n' });
                    await say(sid, 'WROTE');
                } else if (command === 'read') {
                    const result = await ctx.request(methods.client.fs.readTextFile, { sessionId: sid, path: arg ?? '' });
                    await say(sid, `READ:${result.content}`);
                } else if (command === 'pwd') {
                    const created = await ctx.request(methods.client.terminal.create, { sessionId: sid, command: 'pwd' });
                    await ctx.request(methods.client.terminal.waitForExit, { sessionId: sid, terminalId: created.terminalId });
                    const output = await ctx.request(methods.client.terminal.output, { sessionId: sid, terminalId: created.terminalId });
                    await ctx.request(methods.client.terminal.release, { sessionId: sid, terminalId: created.terminalId });
                    await say(sid, `PWD:${output.output.trim()}`);
                }
            } catch (error) {
                await say(sid, `ERR:${(error as Error).message}`);
            }
            return { stopReason: 'end_turn' };
        });
}

async function setup(name: string, options: { trusted?: boolean; storage?: boolean } = {}) {
    const root = repo(name);
    const dir = path.join(base, name);
    const catalog = new AgentCatalog({ packagesDir: path.join(dir, 'packages'), store: new JsonKeyValueStore(path.join(dir, 'agents.json')), env: { PATH: '' }, platform: process.platform, execPath: process.execPath, builtinProfiles: () => Promise.resolve([]) });
    const custom = await catalog.saveCustom({ name: 'Fake', command: process.execPath, args: [] });
    const log: AgentLog = { connectCwds: [], sessionCwds: [] };
    const window: WindowPort = { id: 1, send: () => undefined, isDestroyed: () => false };
    const changes = new SessionChanges({ storageDir: path.join(dir, 'checkpoints'), bases: new JsonKeyValueStore(path.join(dir, 'review.json')) });
    const storageDir = path.join(dir, 'userData', 'worktrees');
    const sessionsDir = path.join(dir, 'sessions');
    const service = new AgentSessionService({
        catalog,
        store: new SessionStore(sessionsDir, { debounceMs: 5 }),
        decisions: new JsonKeyValueStore(path.join(dir, 'decisions.json')),
        rootOf: () => root,
        isTrusted: () => options.trusted ?? true,
        readText: (file) => fs.promises.readFile(file, 'utf8'),
        writeText: (file, content) => fs.promises.writeFile(file, content),
        openTerminal: () => Promise.reject(new Error('no terminal in tests')),
        connect: (_launch, cwd, handlers) => {
            log.connectCwds.push(cwd);
            return AcpConnection.inProcess(fakeAgent(log), handlers);
        },
        review: changes,
        beforePrompt: (sessionId, workspaceRoot) => changes.beforePrompt(sessionId, workspaceRoot),
        afterTurn: (sessionId, workspaceRoot) => changes.afterTurn(sessionId, workspaceRoot),
        ...(options.storage === false ? {} : { worktreeStorageDir: storageDir }),
        spawnAllowed: true,
        probeDir: path.join(dir, 'probe'),
        homeDir: os.homedir(),
        terminalEnv: { PATH: process.env['PATH'] ?? '' },
        cancelGraceMs: 2000,
    });
    return { root, service, window, log, storageDir, sessionsDir, ref: `acp:${custom.id}` };
}

function lastText(state: AgentSessionState): string {
    const item = [...state.items].reverse().find((candidate) => candidate.kind === 'assistant');
    return item && 'text' in item ? item.text : '';
}

async function errorOf(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        return (error as Error).message;
    }
    assert.fail('expected a refusal');
}

function branchExists(root: string, branch: string): boolean {
    try {
        git(root, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
        return true;
    } catch {
        return false;
    }
}

describe('AgentSessionService: chats in their own worktree (AF12)', () => {
    it('runs the agent in the worktree, confines it there, and commits, merges and discards it', async () => {
        const { root, service, window, log, storageDir, sessionsDir, ref } = await setup('lifecycle');
        assert.deepEqual(await service.worktreeAvailability(window), { ok: true, message: null });

        const created = await service.create(window, ref, { worktree: true });
        const worktree = created.worktree;
        assert.ok(worktree);
        assert.match(worktree.branch, /^codexr\/agent\/fake-[0-9a-f]{6}$/);
        assert.ok(worktree.path.startsWith(storageDir + path.sep), worktree.path);
        assert.equal(worktree.cwd, worktree.path);
        assert.equal(worktree.repoRoot, root);
        assert.equal(created.workspaceRoot, root, 'the chat still belongs to the project');

        // The agent starts in the worktree, and session/new names it.
        await service.prompt(window, created.id, 'pwd', []);
        assert.deepEqual(log.connectCwds, [worktree.cwd]);
        assert.deepEqual(log.sessionCwds, [worktree.cwd]);
        assert.equal(lastText(await service.get(window, created.id)), `PWD:${worktree.cwd}`);

        // It writes in the worktree only.
        await service.prompt(window, created.id, `write ${path.join(worktree.cwd, 'new.txt')}`, []);
        assert.equal(lastText(await service.get(window, created.id)), 'WROTE');
        assert.ok(fs.existsSync(path.join(worktree.cwd, 'new.txt')));
        assert.ok(!fs.existsSync(path.join(root, 'new.txt')));
        await service.prompt(window, created.id, `write ${path.join(root, 'escape.txt')}`, []);
        assert.match(lastText(await service.get(window, created.id)), /^ERR:.*outside the chat's worktree/);
        assert.ok(!fs.existsSync(path.join(root, 'escape.txt')));
        await service.prompt(window, created.id, `read ${path.join(root, 'a.txt')}`, []);
        assert.match(lastText(await service.get(window, created.id)), /^ERR:.*outside/);

        // The Changes tab and the checkpoints work on the worktree.
        const changes = await service.changes(window, created.id);
        assert.deepEqual(changes.files.map((file) => file.path), ['new.txt']);
        assert.equal((await service.get(window, created.id)).pendingChanges, 1);

        // Status, then a merge refused while the agent's work is not committed.
        let status: WorktreeStatusView = await service.worktreeStatus(window, created.id);
        assert.equal(status.into, 'main');
        assert.equal(status.exists, true);
        assert.deepEqual(status.files.map((file) => [file.path, file.status, file.uncommitted]), [['new.txt', 'added', true]]);
        assert.equal(status.ahead, 0);
        assert.equal(status.hasUncommitted, true);
        assert.match(await errorOf(service.worktreeMerge(window, created.id, 'merge')), /uncommitted changes.*Files: new\.txt/);

        const commit = await service.worktreeCommit(window, created.id, 'Add new.txt');
        assert.equal(commit.fileCount, 1);
        assert.ok(commit.commit);
        assert.deepEqual(await service.worktreeCommit(window, created.id, 'Again'), { commit: null, fileCount: 0 });
        await assert.rejects(service.worktreeCommit(window, created.id, '   '), /needs a message/);
        status = await service.worktreeStatus(window, created.id);
        assert.equal(status.ahead, 1);
        assert.equal(status.hasUncommitted, false);

        const merged = await service.worktreeMerge(window, created.id, 'merge');
        assert.equal(merged.into, 'main');
        assert.equal(merged.nothingToMerge, false);
        assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'written\n');
        assert.equal((await service.worktreeMerge(window, created.id, 'squash')).nothingToMerge, true);
        await assert.rejects(service.worktreeMerge(window, created.id, 'rebase'), /Unknown merge strategy/);

        // The worktree record is kept with the chat, on disk.
        const stored = await new SessionStore(sessionsDir).find(created.id, root);
        assert.deepEqual(stored?.worktree, worktree);
        const listed = (await service.listProjects(window))[0]?.sessions.find((session) => session.id === created.id);
        assert.equal(listed?.worktree?.branch, worktree.branch);

        // Discard: folder and branch gone, the chat kept read-only.
        await service.worktreeDiscard(window, created.id);
        assert.ok(!fs.existsSync(worktree.path));
        assert.ok(!branchExists(root, worktree.branch));
        const discarded = await service.get(window, created.id);
        assert.equal(discarded.worktree?.removed, true);
        assert.equal(discarded.pendingChanges, 0);
        await assert.rejects(service.prompt(window, created.id, 'pwd', []), /discarded/);
        assert.equal((await service.worktreeStatus(window, created.id)).removed, true);
        await assert.rejects(service.worktreeDiscard(window, created.id), /discarded/);
        await service.remove(window, created.id, { removeWorktree: true });
        await assert.rejects(service.get(window, created.id), /no longer exists/);
    });

    it('refuses a squash that would conflict, leaving the project as it was', async () => {
        const { root, service, window, ref } = await setup('conflict');
        const created = await service.create(window, ref, { worktree: true });
        const worktree = created.worktree;
        assert.ok(worktree);
        await service.prompt(window, created.id, `write ${path.join(worktree.cwd, 'a.txt')}`, []);
        await service.worktreeCommit(window, created.id, 'Rewrite a.txt');
        fs.writeFileSync(path.join(root, 'a.txt'), 'changed in the project\n');
        git(root, 'commit', '-q', '-am', 'project change');
        const head = git(root, 'rev-parse', 'HEAD');
        const status = await service.worktreeStatus(window, created.id);
        assert.equal(status.behind, 1);
        assert.match(await errorOf(service.worktreeMerge(window, created.id, 'squash')), /would conflict\. Nothing was changed\. Files: a\.txt/);
        assert.equal(git(root, 'rev-parse', 'HEAD'), head);
        assert.equal(git(root, 'status', '--porcelain'), '');
        await service.stopAll();
    });

    it('asks nothing of a plain chat, and keeps or removes the worktree when its chat is deleted', async () => {
        const { root, service, window, ref } = await setup('remove');
        const plain = await service.create(window, ref);
        assert.equal(plain.worktree, undefined);
        await assert.rejects(service.worktreeStatus(window, plain.id), /does not have a worktree/);

        const kept = await service.create(window, ref, { worktree: true });
        assert.ok(kept.worktree);
        await service.remove(window, kept.id);
        assert.ok(fs.existsSync(kept.worktree.path), 'without removeWorktree the worktree is kept');
        assert.ok(branchExists(root, kept.worktree.branch));

        const removed = await service.create(window, ref, { worktree: true });
        assert.ok(removed.worktree);
        await service.remove(window, removed.id, { removeWorktree: true });
        assert.ok(!fs.existsSync(removed.worktree.path));
        assert.ok(!branchExists(root, removed.worktree.branch));
        await service.stopAll();
    });

    it('only uses a worktree record the IDE created, and refuses worktrees where they cannot be', async () => {
        const { root, service, window, sessionsDir, ref } = await setup('records');
        // A record pointing at the project itself (a tampered file) is never acted on.
        const forged: AgentSessionState = applySessionEvent(
            emptySession({ id: 'forged-chat', title: 'Forged', agentRef: ref, agentName: 'Fake', workspaceRoot: root, createdAt: '2026-11-27T10:00:00.000Z', updatedAt: '2026-11-27T10:00:00.000Z' }),
            { type: 'worktree', worktree: { branch: 'codexr/agent/x-000000', path: root, cwd: root, baseCommit: 'HEAD', repoRoot: root } },
        );
        await new SessionStore(sessionsDir).saveNow(forged);
        await assert.rejects(service.worktreeStatus(window, 'forged-chat'), /not one the IDE created/);
        await assert.rejects(service.worktreeDiscard(window, 'forged-chat'), /not one the IDE created/);
        await assert.rejects(service.prompt(window, 'forged-chat', 'pwd', []), /not one the IDE created/);
        assert.ok(fs.existsSync(path.join(root, 'a.txt')));

        const untrusted = await setup('untrusted', { trusted: false });
        assert.equal((await untrusted.service.worktreeAvailability(untrusted.window)).ok, false);
        await assert.rejects(untrusted.service.create(untrusted.window, untrusted.ref, { worktree: true }), /Restricted Mode/);

        const noStorage = await setup('no-storage', { storage: false });
        assert.deepEqual(await noStorage.service.worktreeAvailability(noStorage.window), { ok: false, message: 'Worktrees are not available here.' });

        const notRepo = await setup('not-repo');
        fs.rmSync(path.join(notRepo.root, '.git'), { recursive: true, force: true });
        const availability = await notRepo.service.worktreeAvailability(notRepo.window);
        assert.equal(availability.ok, false);
        assert.match(availability.message ?? '', /not inside a git repository/);
        await assert.rejects(notRepo.service.create(notRepo.window, notRepo.ref, { worktree: true }), /not inside a git repository/);
        for (const each of [service, untrusted.service, noStorage.service, notRepo.service]) {
            await each.stopAll();
        }
    });
});

describe('worktree bar model (AF12)', () => {
    const status = (extra: Partial<WorktreeStatusView> = {}): WorktreeStatusView => ({
        branch: 'codexr/agent/fix-abc123', into: 'main', exists: true, removed: false, files: [], ahead: 0, behind: 0, hasUncommitted: false, ...extra,
    });

    it('labels branches and summarises a status', () => {
        assert.equal(branchLabel({ branch: 'codexr/agent/fix-abc123' }), 'fix-abc123');
        assert.equal(branchLabel({ branch: 'feature/x' }), 'feature/x');
        assert.equal(worktreeSummary(status()), 'No changes yet, 0 commits ahead');
        assert.equal(worktreeSummary(status({
            files: [{ path: 'a', status: 'added', committed: false, uncommitted: true }, { path: 'b', status: 'modified', committed: true, uncommitted: false }],
            ahead: 1, behind: 2, hasUncommitted: true,
        })), '2 files changed (1 uncommitted), 1 commit ahead, 2 behind main');
        assert.match(worktreeSummary(status({ removed: true })), /discarded/);
        assert.match(worktreeSummary(status({ exists: false, ahead: 2 })), /missing.*2 commits/);
    });

    it('enables the actions that can work now', () => {
        assert.deepEqual(worktreeActions(status({ hasUncommitted: true }), false), { commit: true, merge: false, discard: true, mergeHint: 'Commit the agent\'s changes first.' });
        assert.deepEqual(worktreeActions(status({ ahead: 2 }), false), { commit: false, merge: true, discard: true, mergeHint: null });
        assert.equal(worktreeActions(status({ ahead: 2 }), true).merge, false, 'not while the agent works');
        assert.equal(worktreeActions(status({ ahead: 2, into: null }), false).mergeHint, 'The project is not on a branch (detached HEAD).');
        assert.equal(worktreeActions(status(), false).mergeHint, 'Nothing to merge yet.');
        assert.deepEqual(worktreeActions(status({ removed: true }), false), { commit: false, merge: false, discard: false, mergeHint: null });
        assert.deepEqual(worktreeActions(null, false), { commit: false, merge: false, discard: false, mergeHint: null });
    });

    it('suggests a commit message, words outcomes and reads the remembered choice', () => {
        assert.equal(suggestedCommitMessage('  Fix   the parser '), 'Fix the parser');
        assert.equal(suggestedCommitMessage('New chat'), 'Changes by the agent');
        assert.equal(mergeOutcome({ strategy: 'merge', into: 'main', nothingToMerge: false }), 'Merged into main.');
        assert.equal(mergeOutcome({ strategy: 'squash', into: 'dev', nothingToMerge: false }), 'Squashed into dev as one commit.');
        assert.match(mergeOutcome({ strategy: 'merge', into: 'main', nothingToMerge: true }), /^Nothing to merge/);
        assert.equal(parseWorktreeChoice('1'), true);
        assert.equal(parseWorktreeChoice('0'), false);
        assert.equal(parseWorktreeChoice(null), false);
    });
});
