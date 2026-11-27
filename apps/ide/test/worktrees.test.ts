import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    canUseWorktrees, commitAll, createWorktree, listWorktrees, mergeIntoCurrent, removeWorktree, worktreeStatus, WorktreeError,
    type CreatedWorktree,
} from '../src/main/worktrees/worktreeManager.ts';
import { worktreeGitEnvironment } from '../src/main/worktrees/worktreeGit.ts';
import {
    agentBranchName, isAgentBranch, isSafeSessionId, parseNameStatus, parsePorcelain, parseWorktreeList, repoHash, slugify,
} from '../src/main/worktrees/worktreeModel.ts';

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-worktrees-')));
const storageDir = path.join(base, 'storage');
after(() => fs.rmSync(base, { recursive: true, force: true }));

let counter = 0;

function realGit(cwd: string, ...args: string[]): string {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('GIT_')) {
            env[key] = value;
        }
    }
    return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

function write(root: string, relative: string, content: string): void {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function read(root: string, relative: string): string | null {
    const target = path.join(root, ...relative.split('/'));
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
}

/** A repository with a local identity, `files` committed on `main`. */
function repo(files: Record<string, string> = { 'a.txt': 'a\n', 'b.txt': 'b\n', 'src/c.txt': 'c\n' }): string {
    counter += 1;
    const root = path.join(base, `repo-${counter}`);
    fs.mkdirSync(root, { recursive: true });
    realGit(root, 'init', '-q', '-b', 'main');
    realGit(root, 'config', 'user.name', 'Test Person');
    realGit(root, 'config', 'user.email', 'test@example.invalid');
    realGit(root, 'config', 'commit.gpgsign', 'false');
    for (const [relative, content] of Object.entries(files)) {
        write(root, relative, content);
    }
    realGit(root, 'add', '-A');
    realGit(root, 'commit', '-q', '-m', 'initial');
    return root;
}

function porcelain(root: string): string {
    return realGit(root, 'status', '--porcelain', '--untracked-files=all');
}

async function agent(root: string, label = 'Fix the parser'): Promise<CreatedWorktree> {
    counter += 1;
    return createWorktree({ projectRoot: root, storageDir, sessionId: `session-${counter}`, label });
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<WorktreeError> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof WorktreeError, `expected a WorktreeError, got ${String(error)}`);
        assert.equal(error.code, code, error.message);
        return error;
    }
    assert.fail(`expected a ${code} refusal`);
}

describe('worktree model', () => {
    it('slugs labels and names branches under the agent prefix', () => {
        assert.equal(slugify('Fix the Parser: ñandú édition!'), 'fix-the-parser-nandu-edition');
        assert.equal(slugify('***'), 'agent');
        assert.ok(slugify('x'.repeat(100)).length <= 32);
        const branch = agentBranchName('Add tests', 'abc123');
        assert.equal(branch, 'codexr/agent/add-tests-abc123');
        assert.ok(isAgentBranch(branch));
        assert.ok(!isAgentBranch('main'));
        assert.ok(!isAgentBranch('codexr/agent/'));
    });

    it('accepts only single safe path segments as session ids', () => {
        assert.ok(isSafeSessionId('chat-1a2b_3.x'));
        for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden', 'trailing.', 'a..b', 'x'.repeat(200)]) {
            assert.ok(!isSafeSessionId(bad), bad);
        }
    });

    it('hashes the repository case-insensitively on Windows and macOS only', () => {
        assert.equal(repoHash('C:/Repo/.git', 'win32'), repoHash('c:/repo/.git', 'win32'));
        assert.notEqual(repoHash('/Repo/.git', 'linux'), repoHash('/repo/.git', 'linux'));
        assert.equal(repoHash('/x/.git', 'linux').length, 16);
    });

    it('parses worktree lists, name-status and porcelain', () => {
        const list = parseWorktreeList('worktree /r\0HEAD aaa\0branch refs/heads/main\0\0worktree /w\0HEAD bbb\0branch refs/heads/codexr/agent/x-1\0locked\0prunable gone\0\0');
        assert.deepEqual(list.map((entry) => [entry.path, entry.branch, entry.locked, entry.prunable]), [
            ['/r', 'main', false, false],
            ['/w', 'codexr/agent/x-1', true, true],
        ]);
        assert.deepEqual([...parseNameStatus('A\0n.txt\0M\0m.txt\0D\0d.txt\0')], [['n.txt', 'added'], ['m.txt', 'modified'], ['d.txt', 'deleted']]);
        assert.deepEqual(parsePorcelain('M  s.txt\0 M u.txt\0?? new.txt\0'), [
            { path: 's.txt', staged: true, untracked: false },
            { path: 'u.txt', staged: false, untracked: false },
            { path: 'new.txt', staged: false, untracked: true },
        ]);
    });

    it('drops inherited GIT_* variables and Electron switches from the environment', () => {
        const env = worktreeGitEnvironment({ PATH: '/bin', GIT_DIR: '/elsewhere', git_work_tree: '/x', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' });
        assert.equal(env['PATH'], '/bin');
        assert.equal(env['GIT_DIR'], undefined);
        assert.equal(env['git_work_tree'], undefined);
        assert.equal(env['ELECTRON_RUN_AS_NODE'], undefined);
        assert.equal(env['NODE_OPTIONS'], undefined);
        assert.equal(env['GIT_TERMINAL_PROMPT'], '0');
    });
});

describe('agent worktrees', () => {
    it('refuses a folder outside git and a repository without commits', async () => {
        const plain = path.join(base, 'plain');
        fs.mkdirSync(plain, { recursive: true });
        const notRepo = await canUseWorktrees(plain);
        assert.equal(notRepo.ok, false);
        assert.equal(notRepo.ok ? '' : notRepo.reason, 'not-a-repo');

        const empty = path.join(base, 'empty-repo');
        fs.mkdirSync(empty, { recursive: true });
        realGit(empty, 'init', '-q');
        const noCommits = await canUseWorktrees(empty);
        assert.equal(noCommits.ok ? '' : noCommits.reason, 'no-commits');
        await rejectsWith(createWorktree({ projectRoot: empty, storageDir, sessionId: 's-empty', label: 'x' }), 'no-commits');
        await rejectsWith(createWorktree({ projectRoot: plain, storageDir, sessionId: 's-plain', label: 'x' }), 'not-a-repo');

        const ok = await canUseWorktrees(repo());
        assert.equal(ok.ok, true);
    });

    it('creates a worktree on a fresh agent branch from HEAD, outside the project, and reports a dirty main tree', async () => {
        const root = repo();
        write(root, 'a.txt', 'local edit\n');
        const head = realGit(root, 'rev-parse', 'HEAD').trim();
        const info = await agent(root);
        assert.match(info.branch, /^codexr\/agent\/fix-the-parser-[0-9a-f]{6}$/);
        assert.equal(info.baseCommit, head);
        assert.equal(info.dirty, true);
        assert.ok(path.relative(root, info.path).startsWith('..'), 'worktree is outside the project');
        assert.equal(path.basename(info.path), info.sessionId);
        assert.equal(info.cwd, info.path);
        // Starts from HEAD: the uncommitted edit is not carried over.
        assert.equal(read(info.path, 'a.txt'), 'a\n');
        assert.equal(realGit(info.path, 'symbolic-ref', '--short', 'HEAD').trim(), info.branch);

        const clean = await agent(repo());
        assert.equal(clean.dirty, false);
        await rejectsWith(createWorktree({ projectRoot: root, storageDir, sessionId: info.sessionId, label: 'again' }), 'already-exists');
        await rejectsWith(createWorktree({ projectRoot: root, storageDir, sessionId: '../escape', label: 'x' }), 'invalid-argument');
        await rejectsWith(createWorktree({ projectRoot: root, storageDir: path.join(root, 'inside'), sessionId: 's-in', label: 'x' }), 'storage-inside-project');
    });

    it('keeps the project sub-folder as the agent cwd', async () => {
        const root = repo();
        const info = await createWorktree({ projectRoot: path.join(root, 'src'), storageDir, sessionId: 'sub-folder', label: 'sub' });
        assert.equal(info.repoRoot, root);
        assert.equal(info.cwd, path.join(info.path, 'src'));
        assert.equal(read(info.cwd, 'c.txt'), 'c\n');
    });

    it('reports committed and uncommitted changes against the base, then commits everything', async () => {
        const root = repo();
        const info = await agent(root);
        write(info.path, 'a.txt', 'a committed\n');
        realGit(info.path, 'commit', '-qam', 'agent edit');
        write(info.path, 'b.txt', 'b uncommitted\n');
        write(info.path, 'new/file.txt', 'new\n');
        fs.rmSync(path.join(info.path, 'src', 'c.txt'));

        const status = await worktreeStatus(info);
        assert.equal(status.exists, true);
        assert.equal(status.ahead, 1);
        assert.equal(status.behind, 0);
        assert.equal(status.hasUncommitted, true);
        assert.deepEqual(status.files.map((file) => [file.path, file.status, file.committed, file.uncommitted]), [
            ['a.txt', 'modified', true, false],
            ['b.txt', 'modified', false, true],
            ['new/file.txt', 'added', false, true],
            ['src/c.txt', 'deleted', false, true],
        ]);

        const commit = await commitAll(info, 'Agent: finish');
        assert.ok(commit);
        assert.equal(commit.fileCount, 3);
        assert.equal(commit.fallbackIdentity, false);
        assert.equal(realGit(info.path, 'log', '-1', '--format=%an <%ae>|%s').trim(), 'Test Person <test@example.invalid>|Agent: finish');
        assert.equal(await commitAll(info, 'nothing'), null);
        await rejectsWith(commitAll(info, '   '), 'invalid-argument');

        const after = await worktreeStatus(info);
        assert.equal(after.ahead, 2);
        assert.equal(after.hasUncommitted, false);
        assert.equal(after.files.length, 4);
        // The main tree did not move.
        assert.equal(read(root, 'a.txt'), 'a\n');
    });

    it('runs no repository hook on its own commits', async () => {
        const root = repo();
        const hook = path.join(root, '.git', 'hooks', 'pre-commit');
        const marker = path.join(base, `hook-ran-${counter}`);
        fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`, { mode: 0o755 });
        const msgHook = path.join(root, '.git', 'hooks', 'prepare-commit-msg');
        fs.writeFileSync(msgHook, `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
        const info = await agent(root);
        write(info.path, 'a.txt', 'x\n');
        assert.ok(await commitAll(info, 'no hooks'));
        assert.equal(fs.existsSync(marker), false);
    });

    it('falls back to the agent identity without writing any config', async () => {
        const root = repo();
        realGit(root, 'config', '--unset', 'user.name');
        realGit(root, 'config', '--unset', 'user.email');
        const configBefore = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
        const info = await agent(root);
        write(info.path, 'a.txt', 'x\n');
        const previousHome = process.env['HOME'];
        const previousXdg = process.env['XDG_CONFIG_HOME'];
        // Isolate from the machine's global identity for this one call.
        process.env['HOME'] = base;
        process.env['XDG_CONFIG_HOME'] = base;
        try {
            const commit = await commitAll(info, 'fallback');
            assert.ok(commit);
            assert.equal(commit.fallbackIdentity, true);
        } finally {
            restoreEnv('HOME', previousHome);
            restoreEnv('XDG_CONFIG_HOME', previousXdg);
        }
        assert.equal(realGit(info.path, 'log', '-1', '--format=%an <%ae>').trim(), 'Code-XR agent <agent@code-xr.invalid>');
        assert.equal(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'), configBefore);
    });

    it('merges with a merge commit', async () => {
        const root = repo();
        const info = await agent(root);
        write(info.path, 'a.txt', 'from agent\n');
        await commitAll(info, 'agent work');
        // The person keeps working on an unrelated file meanwhile.
        write(root, 'b.txt', 'person edit\n');

        const result = await mergeIntoCurrent(info, { strategy: 'merge' });
        assert.equal(result.into, 'main');
        assert.equal(result.nothingToMerge, false);
        assert.equal(result.commit, realGit(root, 'rev-parse', 'HEAD').trim());
        assert.equal(realGit(root, 'rev-list', '--count', '--merges', 'HEAD^..HEAD').trim(), '1');
        assert.equal(read(root, 'a.txt'), 'from agent\n');
        assert.equal(read(root, 'b.txt'), 'person edit\n');

        const again = await mergeIntoCurrent(info, { strategy: 'merge' });
        assert.equal(again.nothingToMerge, true);
        assert.equal(again.commit, null);
    });

    it('squashes into one ordinary commit', async () => {
        const root = repo();
        const info = await agent(root, 'Squash me');
        write(info.path, 'a.txt', 'one\n');
        await commitAll(info, 'first');
        write(info.path, 'b.txt', 'two\n');
        await commitAll(info, 'second');

        const result = await mergeIntoCurrent(info, { strategy: 'squash', message: 'Agent: squash me' });
        assert.equal(result.strategy, 'squash');
        assert.equal(realGit(root, 'log', '-1', '--format=%P').trim().split(' ').length, 1, 'one parent');
        assert.equal(realGit(root, 'log', '-1', '--format=%s').trim(), 'Agent: squash me');
        assert.equal(read(root, 'a.txt'), 'one\n');
        assert.equal(read(root, 'b.txt'), 'two\n');
        assert.equal(porcelain(root), '');
    });

    it('refuses a conflicting merge and leaves the main tree exactly as it was', async () => {
        for (const strategy of ['merge', 'squash'] as const) {
            const root = repo();
            const info = await agent(root);
            write(info.path, 'a.txt', 'agent side\n');
            await commitAll(info, 'agent');
            write(root, 'a.txt', 'person side\n');
            realGit(root, 'commit', '-qam', 'person');
            write(root, 'b.txt', 'unrelated dirty\n');
            const headBefore = realGit(root, 'rev-parse', 'HEAD');
            const statusBefore = porcelain(root);

            const error = await rejectsWith(mergeIntoCurrent(info, { strategy }), 'conflicts');
            assert.deepEqual(error.files, ['a.txt']);
            assert.equal(porcelain(root), statusBefore);
            assert.equal(realGit(root, 'rev-parse', 'HEAD'), headBefore);
            assert.equal(read(root, 'a.txt'), 'person side\n');
            assert.equal(read(root, 'b.txt'), 'unrelated dirty\n');
        }
    });

    it('refuses when the main tree has uncommitted or staged changes to the same files', async () => {
        const root = repo();
        const info = await agent(root);
        write(info.path, 'a.txt', 'agent\n');
        write(info.path, 'added.txt', 'agent new\n');
        await commitAll(info, 'agent');

        write(root, 'a.txt', 'person dirty\n');
        const statusBefore = porcelain(root);
        const dirty = await rejectsWith(mergeIntoCurrent(info, { strategy: 'merge' }), 'dirty-overlap');
        assert.deepEqual(dirty.files, ['a.txt']);
        assert.equal(porcelain(root), statusBefore);

        realGit(root, 'checkout', '--', 'a.txt');
        write(root, 'added.txt', 'person untracked\n');
        const untracked = await rejectsWith(mergeIntoCurrent(info, { strategy: 'squash' }), 'dirty-overlap');
        assert.deepEqual(untracked.files, ['added.txt']);
        fs.rmSync(path.join(root, 'added.txt'));

        write(root, 'b.txt', 'staged elsewhere\n');
        realGit(root, 'add', 'b.txt');
        await rejectsWith(mergeIntoCurrent(info, { strategy: 'squash' }), 'staged-changes');
        realGit(root, 'reset', '-q');

        write(info.path, 'b.txt', 'agent not committed\n');
        await rejectsWith(mergeIntoCurrent(info, { strategy: 'merge' }), 'uncommitted-in-worktree');
    });

    it('runs the person\'s hooks on the final merge and undoes it when one rejects', async () => {
        for (const [strategy, hookName] of [['merge', 'pre-merge-commit'], ['squash', 'pre-commit']] as const) {
            const root = repo();
            const info = await agent(root);
            write(info.path, 'a.txt', 'agent\n');
            await commitAll(info, 'agent');
            write(root, 'b.txt', 'unrelated dirty\n');
            fs.writeFileSync(path.join(root, '.git', 'hooks', hookName), '#!/bin/sh\necho rejected by hook >&2\nexit 1\n', { mode: 0o755 });
            const headBefore = realGit(root, 'rev-parse', 'HEAD');
            const statusBefore = porcelain(root);

            const error = await rejectsWith(mergeIntoCurrent(info, { strategy }), 'merge-failed');
            assert.match(error.message, /rejected by hook/);
            assert.equal(realGit(root, 'rev-parse', 'HEAD'), headBefore);
            assert.equal(porcelain(root), statusBefore);
            assert.equal(read(root, 'a.txt'), 'a\n');
            assert.equal(read(root, 'b.txt'), 'unrelated dirty\n');
        }
    });

    it('refuses to merge into a detached HEAD', async () => {
        const root = repo();
        const info = await agent(root);
        write(info.path, 'a.txt', 'agent\n');
        await commitAll(info, 'agent');
        realGit(root, 'checkout', '-q', '--detach');
        await rejectsWith(mergeIntoCurrent(info, { strategy: 'merge' }), 'detached-head');
    });

    it('lists only agent worktrees, then removes them with or without the branch', async () => {
        const root = repo();
        const first = await agent(root, 'First');
        const second = await agent(root, 'Second');
        const foreign = path.join(base, `foreign-${counter}`);
        realGit(root, 'worktree', 'add', '-q', '-b', 'feature/mine', foreign);

        const listed = await listWorktrees(root);
        assert.deepEqual(listed.map((entry) => entry.info.branch).sort(), [first.branch, second.branch].sort());
        const restored = listed.find((entry) => entry.info.branch === first.branch);
        assert.ok(restored);
        assert.equal(restored.recovered, false);
        assert.equal(restored.info.baseCommit, first.baseCommit);
        assert.equal(restored.info.sessionId, first.sessionId);

        const kept = await removeWorktree(first, { deleteBranch: false });
        assert.deepEqual(kept, { removedWorktree: true, deletedBranch: false });
        assert.equal(fs.existsSync(first.path), false);
        assert.equal(realGit(root, 'branch', '--list', first.branch).trim().length > 0, true);

        const gone = await removeWorktree(second, { deleteBranch: true });
        assert.deepEqual(gone, { removedWorktree: true, deletedBranch: true });
        assert.equal(realGit(root, 'branch', '--list', second.branch).trim(), '');

        assert.deepEqual(await listWorktrees(root), []);
        assert.ok(fs.existsSync(foreign), 'a worktree that is not ours is never touched');
        await rejectsWith(removeWorktree({ ...first, branch: 'feature/mine', path: foreign }, { deleteBranch: true }), 'not-ours');

        // Removing again is harmless; the branch delete then takes the branch.
        assert.deepEqual(await removeWorktree(first, { deleteBranch: true }), { removedWorktree: false, deletedBranch: true });
    });

    it('cleans up a worktree whose folder was deleted by hand', async () => {
        const root = repo();
        const info = await agent(root);
        fs.rmSync(info.path, { recursive: true, force: true });
        const status = await worktreeStatus(info);
        assert.equal(status.exists, false);
        await rejectsWith(commitAll(info, 'x'), 'worktree-missing');
        const listed = await listWorktrees(root);
        assert.equal(listed[0]?.prunable, true);
        assert.deepEqual(await removeWorktree(info, { deleteBranch: true }), { removedWorktree: true, deletedBranch: true });
        assert.deepEqual(await listWorktrees(root), []);
    });
});

function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}
