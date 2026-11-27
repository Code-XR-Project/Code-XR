import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupChanges, parsePorcelainV2 } from '../src/main/git/statusParser.ts';
import { parseBlamePorcelain } from '../src/main/git/blameParser.ts';
import { resolveGitPath, resolveGitPaths, validateBranchName, validateCommitMessage } from '../src/main/git/gitPaths.ts';
import { GitService } from '../src/main/git/gitService.ts';
import { GitNotFoundError, gitEnvironment, type GitRunner } from '../src/main/git/gitRunner.ts';
import { branchLabel, branchPickerView, changeCount, parseBranchAction, scmGroups, splitPath } from '../src/renderer/git/scmModel.ts';
import { emptyGitStatus, GIT_IPC_CHANNELS, type GitStatus } from '../src/shared/git.ts';
import { ALLOWED_IPC_CHANNELS } from '../src/shared/api.ts';

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-git-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

describe('parsePorcelainV2', () => {
    const SHA = 'a'.repeat(40);
    const record = (...parts: string[]): string => parts.join('\0') + '\0';

    it('reads the branch headers', () => {
        const status = parsePorcelainV2(record(`# branch.oid ${SHA}`, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3'));
        assert.deepEqual(status.branch, { oid: SHA, head: 'main', upstream: 'origin/main', ahead: 2, behind: 3 });
        assert.deepEqual(status.entries, []);
    });

    it('reads an initial, detached repository', () => {
        const status = parsePorcelainV2(record('# branch.oid (initial)', '# branch.head (detached)'));
        assert.equal(status.branch.oid, null);
        assert.equal(status.branch.head, null);
        assert.equal(status.branch.upstream, null);
    });

    it('reads ordinary, renamed, unmerged, untracked and ignored entries, spaces in names included', () => {
        const output = record(
            `1 M. N... 100644 100644 100644 ${SHA} ${SHA} src/a file.ts`,
            `1 .D N... 100644 100644 000000 ${SHA} ${SHA} gone.txt`,
            `2 R. N... 100644 100644 100644 ${SHA} ${SHA} R100 new name.ts`, 'old name.ts',
            `u UU N... 100644 100644 100644 100644 ${SHA} ${SHA} ${SHA} conflict.ts`,
            '? notes/todo list.md',
            '! build/out.js',
        );
        assert.deepEqual(parsePorcelainV2(output).entries, [
            { kind: 'changed', x: 'M', y: '.', path: 'src/a file.ts' },
            { kind: 'changed', x: '.', y: 'D', path: 'gone.txt' },
            { kind: 'changed', x: 'R', y: '.', path: 'new name.ts', origPath: 'old name.ts' },
            { kind: 'unmerged', x: 'U', y: 'U', path: 'conflict.ts' },
            { kind: 'untracked', path: 'notes/todo list.md' },
            { kind: 'ignored', path: 'build/out.js' },
        ]);
    });

    it('ignores malformed records instead of throwing', () => {
        assert.deepEqual(parsePorcelainV2(record('1 M', 'garbage', '2', '?')).entries, []);
        assert.deepEqual(parsePorcelainV2('').entries, []);
    });
});

describe('groupChanges', () => {
    it('groups by side and letter, a file changed on both sides in both groups', () => {
        const groups = groupChanges([
            { kind: 'changed', x: 'M', y: 'M', path: 'both.ts' },
            { kind: 'changed', x: 'A', y: '.', path: 'added.ts' },
            { kind: 'changed', x: '.', y: 'D', path: 'deleted.ts' },
            { kind: 'changed', x: 'R', y: '.', path: 'b.ts', origPath: 'a.ts' },
            { kind: 'unmerged', x: 'U', y: 'U', path: 'conflict.ts' },
            { kind: 'untracked', path: 'new.ts' },
            { kind: 'ignored', path: 'ignored.ts' },
        ]);
        assert.deepEqual(groups.staged, [
            { path: 'added.ts', letter: 'A' },
            { path: 'b.ts', letter: 'R', origPath: 'a.ts' },
            { path: 'both.ts', letter: 'M' },
        ]);
        assert.deepEqual(groups.changes, [
            { path: 'both.ts', letter: 'M' },
            { path: 'conflict.ts', letter: '!' },
            { path: 'deleted.ts', letter: 'D' },
        ]);
        assert.deepEqual(groups.untracked, [{ path: 'new.ts', letter: 'U' }]);
    });

    it('keeps only the open folder, relative to it, when it is inside the work tree', () => {
        const groups = groupChanges([
            { kind: 'changed', x: 'M', y: '.', path: 'apps/ide/src/a.ts' },
            { kind: 'changed', x: 'R', y: '.', path: 'apps/ide/b.ts', origPath: 'other/b.ts' },
            { kind: 'changed', x: 'M', y: '.', path: 'apps/ide2/c.ts' },
            { kind: 'untracked', path: 'README.md' },
        ], 'apps/ide/');
        assert.deepEqual(groups.staged, [{ path: 'b.ts', letter: 'R' }, { path: 'src/a.ts', letter: 'M' }]);
        assert.deepEqual(groups.untracked, []);
    });
});

describe('parseBlamePorcelain', () => {
    const A = '1'.repeat(40);
    const ZERO = '0'.repeat(40);
    const output = [
        `${A} 1 1 2`,
        'author Ada Lovelace',
        'author-mail <ada@example.com>',
        'author-time 1700000000',
        'author-tz +0100',
        'committer Ada Lovelace',
        'committer-mail <ada@example.com>',
        'committer-time 1700000100',
        'committer-tz +0100',
        'summary First commit',
        'boundary',
        'filename src/old.ts',
        '\tconst a = 1;',
        `${A} 2 2`,
        'filename src/old.ts',
        '\tconst b = 2;',
        `${ZERO} 3 3 1`,
        'author Not Committed Yet',
        'author-mail <not.committed.yet>',
        'author-time 1700000200',
        'author-tz +0000',
        'committer Not Committed Yet',
        'committer-mail <not.committed.yet>',
        'committer-time 1700000200',
        'committer-tz +0000',
        'summary Version of src/new.ts from src/new.ts',
        'filename src/new.ts',
        '\t// edited',
        '',
    ].join('\n');

    it('gives one entry per line with its commit, the commit details shared', () => {
        const lines = parseBlamePorcelain(output);
        assert.equal(lines.length, 3);
        assert.deepEqual(lines.map((line) => [line.line, line.originalLine, line.content, line.originalPath]), [
            [1, 1, 'const a = 1;', 'src/old.ts'],
            [2, 2, 'const b = 2;', 'src/old.ts'],
            [3, 3, '// edited', 'src/new.ts'],
        ]);
        const first = lines[0]?.commit;
        assert.equal(first?.author, 'Ada Lovelace');
        assert.equal(first?.authorMail, 'ada@example.com');
        assert.equal(first?.authorTime, 1700000000);
        assert.equal(first?.summary, 'First commit');
        assert.equal(first?.boundary, true);
        assert.equal(first?.uncommitted, false);
        assert.equal(lines[1]?.commit, first, 'a commit is described once and shared');
        assert.equal(lines[2]?.commit.uncommitted, true);
        assert.ok(Object.isFrozen(first));
    });

    it('returns nothing for empty or unrelated output', () => {
        assert.deepEqual(parseBlamePorcelain(''), []);
        assert.deepEqual(parseBlamePorcelain('fatal: no such path\n'), []);
    });
});

describe('resolveGitPath (the path guard)', () => {
    const root = path.join(base, 'guard');
    const outside = path.join(base, 'guard-outside');
    before(() => {
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(path.join(root, 'src', 'a.ts'), '');
        fs.symlinkSync(outside, path.join(root, 'link-out'), 'dir');
    });

    it('accepts files inside the folder, existing or deleted', async () => {
        assert.equal(await resolveGitPath(root, root, 'src/a.ts'), 'src/a.ts');
        assert.equal(await resolveGitPath(root, root, 'src/deleted.ts'), 'src/deleted.ts');
        assert.equal(await resolveGitPath(root, root, 'gone/deeper/file.ts'), 'gone/deeper/file.ts');
        assert.equal(await resolveGitPath(root, root, '*.ts'), '*.ts');
    });

    const refused: Array<[string, unknown]> = [
        ['the root itself', ''],
        ['a parent segment', '../guard-outside/x'],
        ['an inner parent segment', 'src/../../x'],
        ['an absolute path', path.join(outside, 'x')],
        ['a drive letter', 'C:/Windows/x'],
        ['a backslash', 'src\\..\\..\\x'],
        ['a NUL byte', 'src/a.ts\0'],
        ['a non-string', 42],
        ['a symlink that leads out', 'link-out/secret.txt'],
        ['a missing file under a symlink that leads out', 'link-out/missing/deeper.txt'],
    ];
    for (const [name, input] of refused) {
        it(`refuses ${name}`, async () => {
            await assert.rejects(resolveGitPath(root, root, input));
        });
    }

    it('checks every path of a list and caps its length', async () => {
        assert.deepEqual(await resolveGitPaths(root, root, ['src/a.ts', 'b.ts']), ['src/a.ts', 'b.ts']);
        await assert.rejects(resolveGitPaths(root, root, ['src/a.ts', '../x']));
        await assert.rejects(resolveGitPaths(root, root, []));
        await assert.rejects(resolveGitPaths(root, root, 'src/a.ts'));
        await assert.rejects(resolveGitPaths(root, root, ['a', 'b', 'c'], 2));
    });
});

describe('validateBranchName and validateCommitMessage', () => {
    it('accepts plain branch names', () => {
        assert.equal(validateBranchName('feature/ide-17'), 'feature/ide-17');
        assert.equal(validateBranchName('  fix  '), 'fix');
    });
    for (const name of ['', '-f', '--orphan', 'a b', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'a@{1}', 'x\0', 42]) {
        it(`refuses the branch name ${JSON.stringify(name)}`, () => {
            assert.throws(() => validateBranchName(name));
        });
    }
    it('requires a commit message, without NUL, at most 64 KiB', () => {
        assert.equal(validateCommitMessage('Fix it\n\nBody'), 'Fix it\n\nBody');
        assert.throws(() => validateCommitMessage('   \n'));
        assert.throws(() => validateCommitMessage('a\0b'));
        assert.throws(() => validateCommitMessage('x'.repeat(70_000)));
        assert.throws(() => validateCommitMessage(null));
    });
});

describe('gitEnvironment', () => {
    it('keeps Electron switches away from git and disables prompts', () => {
        const env = gitEnvironment({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' });
        assert.equal(env['ELECTRON_RUN_AS_NODE'], undefined);
        assert.equal(env['NODE_OPTIONS'], undefined);
        assert.equal(env['GIT_TERMINAL_PROMPT'], '0');
        assert.equal(env['PATH'], '/bin');
    });
});

describe('GitService without git or without a repository', () => {
    it('reports a missing git as a state, not an error', async () => {
        const missing: GitRunner = () => Promise.reject(new GitNotFoundError());
        const status = await new GitService(base, base, missing).status();
        assert.equal(status.state, 'no-git');
        assert.deepEqual(status.staged, []);
    });

    it('reports a folder outside any repository', async () => {
        const folder = path.join(base, 'plain');
        fs.mkdirSync(folder);
        // GIT_CEILING_DIRECTORIES keeps git from finding a repository above the temp folder.
        process.env['GIT_CEILING_DIRECTORIES'] = base;
        try {
            const status = await new GitService(folder, folder).status();
            assert.equal(status.state, 'not-repo');
            await assert.rejects(new GitService(folder, folder).commit('x'), /not in a Git repository/);
        } finally {
            delete process.env['GIT_CEILING_DIRECTORIES'];
        }
    });
});

describe('GitService against a real repository', () => {
    const repo = path.join(base, 'repo');
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    const write = (file: string, text: string): void => {
        fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
        fs.writeFileSync(path.join(repo, file), text);
    };
    let service: GitService;
    const saved: Record<string, string | undefined> = {};
    const env: Record<string, string> = {
        GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com',
        GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'),
    };

    before(() => {
        for (const [key, value] of Object.entries(env)) {
            saved[key] = process.env[key];
            process.env[key] = value;
        }
        fs.writeFileSync(env['GIT_CONFIG_GLOBAL'] ?? '', '');
        fs.mkdirSync(repo);
        git('init', '--quiet', '-b', 'main');
        service = new GitService(repo, repo);
    });
    after(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
        }
    });

    it('lists untracked files before the first commit, then stages, unstages and commits', async () => {
        write('README.md', 'hello\n');
        write('src/a file.ts', 'export const a = 1;\n');
        let status = await service.status();
        assert.equal(status.state, 'ok');
        assert.equal(status.branch, 'main');
        assert.equal(status.head, null);
        assert.deepEqual(status.untracked.map((change) => change.path), ['README.md', 'src/a file.ts']);

        await service.stage(['README.md', 'src/a file.ts']);
        status = await service.status();
        assert.deepEqual(status.staged.map((change) => `${change.letter} ${change.path}`), ['A README.md', 'A src/a file.ts']);

        // Before the first commit, unstaging removes from the index only.
        await service.unstage(['README.md']);
        status = await service.status();
        assert.deepEqual(status.untracked.map((change) => change.path), ['README.md']);
        assert.ok(fs.existsSync(path.join(repo, 'README.md')));

        await service.stageAll();
        const commit = await service.commit('First commit');
        assert.match(commit, /^[0-9a-f]{7,}$/);
        assert.equal(git('log', '--format=%s').trim(), 'First commit');
        status = await service.status();
        assert.equal(changeCount(status), 0);
        assert.equal(status.head, commit.slice(0, 7));
    });

    it('treats glob characters in a path as a name, not a pattern', async () => {
        // `[t]` is a glob that also matches star.ts, and unlike `*` it is a legal file name on Windows.
        write('star.ts', 'x\n');
        write('s[t]ar.ts', 'y\n');
        await service.stage(['s[t]ar.ts']);
        const status = await service.status();
        assert.deepEqual(status.staged.map((change) => change.path), ['s[t]ar.ts']);
        assert.deepEqual(status.untracked.map((change) => change.path), ['star.ts']);
        await service.unstage(['s[t]ar.ts']);
        fs.rmSync(path.join(repo, 's[t]ar.ts'));
        fs.rmSync(path.join(repo, 'star.ts'));
    });

    it('plans and restores a discard, and refuses a file without a change', async () => {
        write('README.md', 'changed\n');
        write('scratch.txt', 'new\n');
        assert.deepEqual(await service.discardPlan('README.md'), { kind: 'restore', path: 'README.md' });
        assert.deepEqual(await service.discardPlan('scratch.txt'), { kind: 'trash', path: 'scratch.txt', absolute: path.join(repo, 'scratch.txt') });
        await assert.rejects(service.discardPlan('src/a file.ts'), /no change to discard/);
        await assert.rejects(service.discardPlan('../outside.txt'));
        await service.restore('README.md');
        assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'hello\n');
        fs.rmSync(path.join(repo, 'scratch.txt'));
    });

    it('diffs HEAD against the working tree, untracked files against nothing', async () => {
        write('README.md', 'hello\nworld\n');
        const diff = await service.diff('README.md');
        assert.match(diff, /^diff --git a\/README\.md b\/README\.md/m);
        assert.match(diff, /^\+world$/m);
        write('fresh.txt', 'brand new\n');
        assert.match(await service.diff('fresh.txt'), /^\+brand new$/m);
        assert.equal(await service.diff('src/a file.ts'), '');
        assert.equal(await service.headContent('README.md'), 'hello\n');
        assert.equal(await service.headContent('fresh.txt'), null);
        fs.rmSync(path.join(repo, 'fresh.txt'));
        await service.restore('README.md');
    });

    it('blames each line, uncommitted lines marked', async () => {
        write('README.md', 'hello\nnot committed\n');
        const lines = await service.blame('README.md');
        assert.equal(lines.length, 2);
        assert.equal(lines[0]?.commit.author, 'Test Author');
        assert.equal(lines[0]?.commit.summary, 'First commit');
        assert.equal(lines[0]?.commit.uncommitted, false);
        assert.equal(lines[1]?.commit.uncommitted, true);
        await assert.rejects(service.blame('untracked-nowhere.txt'));
        await service.restore('README.md');
    });

    it('blames the editor\'s text through stdin, unsaved lines uncommitted (#175)', async () => {
        const lines = await service.blame('README.md', 'inserted above\nhello\n');
        assert.equal(lines.length, 2);
        assert.equal(lines[0]?.commit.uncommitted, true);
        assert.equal(lines[1]?.commit.summary, 'First commit');
        assert.equal(lines[1]?.originalLine, 1);
        assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'hello\n', 'the file on disk is untouched');
    });

    it('creates, lists and switches branches, refusing names that are not branches', async () => {
        await service.createBranch('feature/x');
        assert.equal((await service.status()).branch, 'feature/x');
        assert.deepEqual(await service.branches(), { current: 'feature/x', branches: ['feature/x', 'main'] });
        await service.switchBranch('main');
        assert.equal((await service.status()).branch, 'main');
        await assert.rejects(service.switchBranch('nope'), /no local branch/);
        await assert.rejects(service.switchBranch('--orphan'));
        await assert.rejects(service.createBranch('bad name'));
        await assert.rejects(service.createBranch('main'));
    });

    it('finds the common directory of a linked worktree, where its branches live', async () => {
        const main = await service.repository();
        assert.equal(main?.commonDir, main?.gitDir);
        const linked = path.join(base, 'linked');
        git('worktree', 'add', '--quiet', '-b', 'linked-branch', linked);
        const info = await new GitService(linked, linked).repository();
        assert.equal(info?.commonDir, path.join(repo, '.git'));
        assert.notEqual(info?.gitDir, info?.commonDir);
        assert.ok(fs.existsSync(path.join(info?.commonDir ?? '', 'refs', 'heads', 'linked-branch')));
        git('worktree', 'remove', '--force', linked);
        git('branch', '-D', 'linked-branch');
    });

    it('reports only the open folder when it is a subfolder of the work tree', async () => {
        write('sub/inner.ts', 'inner\n');
        write('outer.ts', 'outer\n');
        const sub = new GitService(path.join(repo, 'sub'), path.join(repo, 'sub'));
        const status = await sub.status();
        assert.deepEqual(status.untracked.map((change) => change.path), ['inner.ts']);
        await sub.stage(['inner.ts']);
        assert.deepEqual((await sub.status()).staged.map((change) => change.path), ['inner.ts']);
        assert.equal(await sub.headContent('inner.ts'), null);
        await sub.unstage(['inner.ts']);
        fs.rmSync(path.join(repo, 'sub'), { recursive: true });
        fs.rmSync(path.join(repo, 'outer.ts'));
    });
});

describe('Source Control view model', () => {
    const status: GitStatus = {
        ...emptyGitStatus('ok'),
        branch: 'main',
        head: 'abc1234',
        upstream: 'origin/main',
        ahead: 1,
        behind: 2,
        staged: [{ path: 'a.ts', letter: 'M' }],
        changes: [{ path: 'a.ts', letter: 'M' }, { path: 'src/b.ts', letter: 'D' }],
        untracked: [],
    };

    it('lists only the groups with changes and counts files once', () => {
        assert.deepEqual(scmGroups(status).map((group) => group.id), ['staged', 'changes']);
        assert.equal(changeCount(status), 2);
    });

    it('labels the branch, a detached HEAD and no repository', () => {
        assert.equal(branchLabel(status), 'main 2\u2193 1\u2191');
        assert.equal(branchLabel({ ...status, branch: null, upstream: null }), 'abc1234 (detached)');
        assert.equal(branchLabel(emptyGitStatus('not-repo')), null);
    });

    it('splits a path into name and folder', () => {
        assert.deepEqual(splitPath('src/main/a.ts'), { name: 'a.ts', folder: 'src/main' });
        assert.deepEqual(splitPath('a.ts'), { name: 'a.ts', folder: '' });
    });

    it('offers to create the typed branch and filters the existing ones', () => {
        const all = branchPickerView(['main', 'feature/x'], 'main', '');
        assert.deepEqual(all.entries.map((entry) => entry.id), ['hint', 'switch:main', 'switch:feature/x']);
        assert.equal(all.entries[1]?.description, 'current branch');
        const typed = branchPickerView(['main', 'feature/x'], 'main', 'feat');
        assert.deepEqual(typed.entries.map((entry) => entry.id), ['create:feat', 'switch:feature/x']);
        const exact = branchPickerView(['main', 'feature/x'], 'main', 'main');
        assert.deepEqual(exact.entries.map((entry) => entry.id), ['switch:main']);
        assert.deepEqual(parseBranchAction('create:feat'), { kind: 'create', name: 'feat' });
        assert.deepEqual(parseBranchAction('switch:main'), { kind: 'switch', name: 'main' });
        assert.equal(parseBranchAction('hint'), null);
    });
});

describe('Source Control IPC contract', () => {
    it('merges every channel into the allow-list', () => {
        for (const channel of Object.values(GIT_IPC_CHANNELS)) {
            assert.ok(ALLOWED_IPC_CHANNELS.has(channel), channel);
        }
    });
});
