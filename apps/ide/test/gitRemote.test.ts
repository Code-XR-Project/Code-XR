import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GitService } from '../src/main/git/gitService.ts';
import { GitCancelledError, REMOTE_GIT_ENV } from '../src/main/git/gitRunner.ts';
import { AUTH_HINT, NETWORK_HINT, REJECTED_HINT, remoteErrorMessage } from '../src/main/git/remoteErrors.ts';
import { gitCommandEntries, gitCommands, type GitActions } from '../src/renderer/git/gitCommands.ts';
import { deleteBranchPickerView, parseStashPick, remoteProgressTitle, stashPickerView, syncItem } from '../src/renderer/git/scmModel.ts';
import { emptyGitStatus, GIT_IPC_CHANNELS, isGitRemoteOperation, type GitStatus } from '../src/shared/git.ts';
import { ALLOWED_IPC_CHANNELS } from '../src/shared/api.ts';

/**
 * #284: push, pull, fetch, sync, stash and branch deletion against real
 * repositories: a local bare repository is the remote, two clones of it play
 * two people. On macOS the temp folder is a symlink, hence the realpath.
 */

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-git-remote-')));

/** Variables set for the whole file: an author, no system or user config, no proxy for 127.0.0.1, no askpass helper. */
const ENV: Record<string, string | undefined> = {
    GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'),
    GIT_ASKPASS: undefined, SSH_ASKPASS: undefined,
    http_proxy: undefined, HTTP_PROXY: undefined, https_proxy: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined, all_proxy: undefined,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};
const saved: Record<string, string | undefined> = {};

before(() => {
    for (const [key, value] of Object.entries(ENV)) {
        saved[key] = process.env[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    fs.writeFileSync(path.join(base, 'gitconfig'), '');
});
after(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    fs.rmSync(base, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (folder: string, file: string, text: string): void => fs.writeFileSync(path.join(folder, file), text);
const commitFile = (folder: string, file: string, text: string, message: string): void => {
    write(folder, file, text);
    git(folder, 'add', file);
    git(folder, 'commit', '--quiet', '-m', message);
};
const sync = (status: GitStatus): [number, number] => [status.ahead, status.behind];

describe('GitService remote operations against a local bare remote (#284)', () => {
    const remote = path.join(base, 'remote.git');
    const alice = path.join(base, 'alice');
    const bob = path.join(base, 'bob');
    let a: GitService;
    let b: GitService;

    before(() => {
        git(base, 'init', '--quiet', '--bare', remote);
        git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        // Not a clone: a clone of the empty remote would already track origin/main.
        fs.mkdirSync(alice);
        git(alice, 'init', '--quiet', '-b', 'main');
        git(alice, 'remote', 'add', 'origin', remote);
        a = new GitService(alice, alice);
    });

    it('publishes a branch on its first push and sets its upstream', async () => {
        commitFile(alice, 'README.md', 'hello\n', 'First commit');
        let status = await a.status();
        assert.equal(status.upstream, null);
        assert.equal(typeof await a.push(), 'string', 'the push resolves with git\'s report');
        status = await a.status();
        assert.equal(status.upstream, 'origin/main');
        assert.deepEqual(sync(status), [0, 0]);
        assert.equal(git(remote, 'rev-parse', 'main'), git(alice, 'rev-parse', 'HEAD'));
    });

    it('fetches, then pulls, what another clone pushed', async () => {
        git(base, 'clone', '--quiet', remote, bob);
        b = new GitService(bob, bob);
        commitFile(bob, 'bob.txt', 'from bob\n', 'Bob commit');
        assert.deepEqual(sync(await b.status()), [1, 0], 'one commit ahead before the push');
        await b.push();
        assert.deepEqual(sync(await b.status()), [0, 0]);

        await a.fetch();
        assert.deepEqual(sync(await a.status()), [0, 1], 'the fetch shows one incoming commit');
        await a.pull();
        assert.deepEqual(sync(await a.status()), [0, 0]);
        assert.equal(fs.readFileSync(path.join(alice, 'bob.txt'), 'utf8'), 'from bob\n');
    });

    it('syncs diverged clones: pulls (a merge without a configured strategy), then pushes', async () => {
        commitFile(alice, 'alice.txt', 'from alice\n', 'Alice commit');
        commitFile(bob, 'bob2.txt', 'again\n', 'Bob second commit');
        await b.push();
        await a.fetch();
        assert.deepEqual(sync(await a.status()), [1, 1]);
        await assert.rejects(a.push(), (error: Error) => error.message.startsWith(REJECTED_HINT), 'a push behind the remote is explained');
        await a.sync();
        assert.deepEqual(sync(await a.status()), [0, 0]);
        assert.equal(git(remote, 'rev-parse', 'main'), git(alice, 'rev-parse', 'HEAD'));
        assert.ok(fs.existsSync(path.join(alice, 'bob2.txt')));
        await b.fetch();
        assert.deepEqual(sync(await b.status()), [0, 2], 'bob sees alice\'s commit and the merge');
    });

    it('prunes a remote branch deleted elsewhere on fetch', async () => {
        git(bob, 'push', '--quiet', 'origin', 'HEAD:refs/heads/short-lived');
        await a.fetch();
        assert.match(git(alice, 'branch', '-r'), /origin\/short-lived/);
        git(bob, 'push', '--quiet', 'origin', '--delete', 'short-lived');
        await a.fetch();
        assert.doesNotMatch(git(alice, 'branch', '-r'), /origin\/short-lived/);
    });

    it('publishes to the remote the person picks when there are several and none is origin', async () => {
        const solo = path.join(base, 'solo');
        fs.mkdirSync(solo);
        git(solo, 'init', '--quiet', '-b', 'work');
        git(solo, 'remote', 'add', 'first', remote);
        git(solo, 'remote', 'add', 'second', remote);
        commitFile(solo, 'solo.txt', 'solo\n', 'Solo commit');
        const service = new GitService(solo, solo);
        let asked: readonly string[] = [];
        assert.equal(await service.push({ chooseRemote: (remotes) => { asked = remotes; return Promise.resolve(null); } }), null, 'cancelling the choice pushes nothing');
        assert.deepEqual(asked, ['first', 'second']);
        await service.push({ chooseRemote: () => Promise.resolve('second') });
        assert.equal((await service.status()).upstream, 'second/work');
    });

    it('stashes and pops tracked changes, untracked files only when asked', async () => {
        write(alice, 'README.md', 'changed\n');
        write(alice, 'scratch.txt', 'untracked\n');
        await a.stash(false);
        assert.equal(fs.readFileSync(path.join(alice, 'README.md'), 'utf8'), 'hello\n');
        assert.ok(fs.existsSync(path.join(alice, 'scratch.txt')), 'an untracked file stays without the option');
        await assert.rejects(a.stash(false), /no local changes to stash/);
        await a.stash(true);
        assert.ok(!fs.existsSync(path.join(alice, 'scratch.txt')));
        const stashes = await a.stashes();
        assert.equal(stashes.length, 2);
        assert.deepEqual(stashes.map((entry) => entry.index), [0, 1]);
        assert.match(stashes[0]?.label ?? '', /^WIP on main/);

        await a.stashAction('apply', 0);
        assert.ok(fs.existsSync(path.join(alice, 'scratch.txt')));
        await a.stashAction('drop', 0);
        fs.rmSync(path.join(alice, 'scratch.txt'));
        await a.stashAction('pop', 0);
        assert.equal(fs.readFileSync(path.join(alice, 'README.md'), 'utf8'), 'changed\n', 'pop restores the change');
        assert.deepEqual(await a.stashes(), []);
        await assert.rejects(a.stashAction('pop', 0), /no stash number 0/);
        await assert.rejects(a.stashAction('pop', '0; rm -rf /'), /named by its index/);
        await assert.rejects(a.stashAction('pop', -1), /named by its index/);
        git(alice, 'checkout', '--quiet', '--', 'README.md');
    });

    it('deletes a merged branch, and refuses an unmerged one until forced', async () => {
        git(alice, 'branch', 'merged-topic');
        git(alice, 'checkout', '--quiet', '-b', 'topic');
        commitFile(alice, 'topic.txt', 'topic\n', 'Topic commit');
        git(alice, 'checkout', '--quiet', 'main');

        assert.equal(await a.deleteBranch('merged-topic', false), 'deleted');
        assert.equal(await a.deleteBranch('topic', false), 'not-merged');
        assert.match(git(alice, 'branch', '--list', 'topic'), /topic/, 'the unmerged branch is still there');
        assert.equal(await a.deleteBranch('topic', true), 'deleted');
        assert.equal(git(alice, 'branch', '--list', 'topic'), '');
        await assert.rejects(a.deleteBranch('main', false), /checked out/);
        await assert.rejects(a.deleteBranch('nope', false), /no local branch/);
        await assert.rejects(a.deleteBranch('-D', true), /Not a valid branch name/);
    });

    it('explains a push from a detached HEAD and a repository with no remote', async () => {
        const lonely = path.join(base, 'lonely');
        fs.mkdirSync(lonely);
        git(lonely, 'init', '--quiet', '-b', 'main');
        commitFile(lonely, 'x.txt', 'x\n', 'X');
        const service = new GitService(lonely, lonely);
        await assert.rejects(service.push(), /no remote to push to/);
        await assert.rejects(service.fetch(), /no remote to fetch from/);
        await assert.rejects(service.pull(), /no upstream branch/);
        git(lonely, 'checkout', '--quiet', '--detach');
        await assert.rejects(service.push(), /HEAD is detached/);
    });
});

describe('GitService remote failures fail fast (#284)', () => {
    let server: http.Server;
    let hanging: http.Server;
    let authUrl = '';
    let hangUrl = '';
    const repo = path.join(base, 'failing');
    let service: GitService;

    before(async () => {
        // A remote that wants a password: every request is answered 401.
        server = http.createServer((_request, response) => {
            response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"', 'Content-Type': 'text/plain' });
            response.end('Authentication required\n');
        });
        // A remote that never answers.
        hanging = http.createServer(() => undefined);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
        authUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/private/repo.git`;
        hangUrl = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}/slow/repo.git`;
        fs.mkdirSync(repo);
        git(repo, 'init', '--quiet', '-b', 'main');
        commitFile(repo, 'f.txt', 'f\n', 'F');
        service = new GitService(repo, repo);
    });
    after(() => {
        server.closeAllConnections();
        hanging.closeAllConnections();
        server.close();
        hanging.close();
    });

    const removeOrigin = (): void => {
        git(repo, 'remote', 'remove', 'origin');
    };

    it('rejects a remote that needs credentials at once, with what to do', async () => {
        git(repo, 'remote', 'add', 'origin', authUrl);
        const started = Date.now();
        await assert.rejects(service.fetch(), (error: Error) => {
            assert.ok(error.message.startsWith(AUTH_HINT), error.message);
            assert.match(error.message, /terminal prompts disabled|could not read Username/i);
            return true;
        });
        await assert.rejects(service.push(), (error: Error) => error.message.startsWith(AUTH_HINT));
        assert.ok(Date.now() - started < 15_000, 'no prompt kept it waiting');
        removeOrigin();
    });

    it('rejects a remote path that does not exist', async () => {
        git(repo, 'remote', 'add', 'origin', path.join(base, 'does-not-exist.git'));
        await assert.rejects(service.fetch(), /does not appear to be a git repository|not found|No such file/i);
        removeOrigin();
    });

    it('stops a remote that does not answer at the timeout', async () => {
        git(repo, 'remote', 'add', 'origin', hangUrl);
        service.remoteTimeoutMs = 1500;
        const started = Date.now();
        await assert.rejects(service.fetch(), /timed out after 1\.5 s/);
        assert.ok(Date.now() - started < 10_000);
        service.remoteTimeoutMs = 120_000;
        removeOrigin();
    });

    it('cancels a running remote operation', async () => {
        git(repo, 'remote', 'add', 'origin', hangUrl);
        const controller = new AbortController();
        const started = Date.now();
        setTimeout(() => controller.abort(), 300);
        await assert.rejects(service.fetch({ signal: controller.signal }), (error: Error) => error instanceof GitCancelledError);
        assert.ok(Date.now() - started < 10_000);
        await assert.rejects(service.fetch({ signal: controller.signal }), GitCancelledError, 'an aborted signal does not start git');
        removeOrigin();
    });
});

describe('remote environment and error messages (#284)', () => {
    it('turns every credential prompt off', () => {
        assert.equal(REMOTE_GIT_ENV['GIT_TERMINAL_PROMPT'], '0');
        assert.equal(REMOTE_GIT_ENV['GCM_INTERACTIVE'], 'never');
    });

    it('puts what to do in front of git\'s own message', () => {
        const auth = remoteErrorMessage("Cloning...\nfatal: could not read Username for 'https://example.com': terminal prompts disabled\n");
        assert.equal(auth, `${AUTH_HINT}\nfatal: could not read Username for 'https://example.com': terminal prompts disabled`);
        assert.ok(remoteErrorMessage('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.').startsWith(AUTH_HINT));
        assert.ok(remoteErrorMessage('fatal: unable to access \'https://x/\': Could not resolve host: x').startsWith(NETWORK_HINT));
        assert.ok(remoteErrorMessage(' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs').startsWith(REJECTED_HINT));
        assert.equal(remoteErrorMessage("fatal: 'nowhere' does not appear to be a git repository"), "fatal: 'nowhere' does not appear to be a git repository");
        assert.equal(remoteErrorMessage(''), 'Git failed without saying why.');
    });
});

describe('Source Control remote view model (#284)', () => {
    const status: GitStatus = { ...emptyGitStatus('ok'), branch: 'main', head: 'abc1234', upstream: 'origin/main', ahead: 1, behind: 2 };

    it('shows ahead/behind beside the branch, and publishes a branch with no upstream', () => {
        assert.deepEqual(syncItem(status), { text: '2↓ 1↑', title: 'Synchronize Changes: pull 2 commits from origin/main, push 1 commit to origin/main', operation: 'sync' });
        assert.equal(syncItem({ ...status, ahead: 0, behind: 0 })?.text, '');
        assert.equal(syncItem({ ...status, upstream: null })?.operation, 'push');
        assert.equal(syncItem({ ...status, branch: null }), null, 'a detached HEAD has nothing to sync');
        assert.equal(syncItem({ ...status, head: null }), null, 'nor a branch before its first commit');
        assert.equal(syncItem(emptyGitStatus('restricted')), null);
        assert.equal(remoteProgressTitle('push', { ...status, upstream: null }), 'Publishing main...');
        assert.equal(remoteProgressTitle('pull', status), 'Pulling from origin/main...');
    });

    it('picks a stash and a branch to delete, never the current one', () => {
        const stashes = stashPickerView([{ index: 0, label: 'WIP on main: abc fix' }, { index: 1, label: 'On main: parser' }], 'pars');
        assert.deepEqual(stashes.entries.map((entry) => entry.id), ['stash:1']);
        assert.equal(parseStashPick('stash:1'), 1);
        assert.equal(parseStashPick('stash:x'), null);
        const branches = deleteBranchPickerView(['main', 'topic', 'other'], 'main', '');
        assert.deepEqual(branches.entries.map((entry) => entry.id), ['delete:topic', 'delete:other']);
    });

    it('registers the palette commands under VS Code\'s ids, enabled only with a repository', () => {
        let repository = false;
        const ran: string[] = [];
        const actions: GitActions = {
            hasRepository: () => repository,
            remote: (operation) => ran.push(operation),
            stash: (untracked) => ran.push(untracked ? 'stash-u' : 'stash'),
            stashAction: (action) => ran.push(`stash-${action}`),
            deleteBranch: () => ran.push('delete'),
        };
        const commands = gitCommands(actions);
        assert.deepEqual(commands.map((command) => command.id).sort(), [
            'git.deleteBranch', 'git.fetch', 'git.pull', 'git.push', 'git.stash', 'git.stashApply', 'git.stashDrop', 'git.stashIncludeUntracked', 'git.stashPop', 'git.sync',
        ]);
        assert.ok(commands.every((command) => command.category === 'Git' && command.enabled?.() === false));
        repository = true;
        assert.ok(commands.every((command) => command.enabled?.() === true));
        for (const command of commands) {
            void command.run();
        }
        assert.deepEqual(ran.sort(), ['delete', 'fetch', 'pull', 'push', 'stash', 'stash-apply', 'stash-drop', 'stash-pop', 'stash-u', 'sync']);
        assert.equal(gitCommandEntries(actions).filter((entry) => entry === null).length, 2, 'the menu has three groups');
    });

    it('merges the new channels into the allow-list and checks the operation name', () => {
        for (const channel of Object.values(GIT_IPC_CHANNELS)) {
            assert.ok(ALLOWED_IPC_CHANNELS.has(channel), channel);
        }
        assert.equal(isGitRemoteOperation('push'), true);
        assert.equal(isGitRemoteOperation('gc'), false);
        assert.equal(isGitRemoteOperation(1), false);
    });
});
