const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { GitRepositoryService } = require('../../out/core/history/gitRepositoryService.js');

// Characterization of GitRepositoryService.listReferences (ROADMAP W4-T25,
// CX-04) per output format. historicalComparison.test.cjs drives it against
// a real repository; here the git calls are stubbed with raw stdout, so each
// parser meets the rows a real repository rarely produces: the checked-out
// branch, remote HEAD aliases, peeled and lightweight tags, malformed SHAs,
// merge commits, missing dates and subjects, CRLF output, a detached HEAD.

const sha = (c) => c.repeat(40);
const idOf = (refType, refName) => `${refType}-${crypto.createHash('sha256').update(refName).digest('hex').slice(0, 16)}`;

function serviceWith({ head = 'main', dirty = '', detached = 'abcd1234\n', branches = '', tags = '', commits = '' }) {
    const service = new GitRepositoryService('/repo/src', '/snapshots');
    const calls = [];
    service.resolveRepositoryRoot = async () => '/repo';
    service.resolveTargetRelativePath = () => 'src';
    service.runGit = async (cwd, args) => {
        calls.push([cwd, ...args]);
        const [command] = args;
        const stdout = command === 'status' ? dirty
            : command === 'rev-parse' ? detached
                : command === 'log' ? commits
                    : args.includes('refs/tags') ? tags
                        : command === 'for-each-ref' ? branches
                            : assert.fail(`unexpected git ${args.join(' ')}`);
        return { stdout, stderr: '' };
    };
    service.tryRunGit = async (cwd, args) => {
        calls.push([cwd, ...args]);
        return head === null ? null : { stdout: `${head}\n`, stderr: '' };
    };
    return { service, calls };
}

const row = (...fields) => fields.join('\0');

test('the git commands listReferences runs, in order', async () => {
    const { service, calls } = serviceWith({});
    await service.listReferences();
    assert.deepEqual(calls, [
        ['/repo', 'status', '--porcelain', '--untracked-files=normal', '--', 'src'],
        ['/repo', 'symbolic-ref', '--quiet', '--short', 'HEAD'],
        ['/repo', 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(refname:short)%00%(committerdate:short)%00%(committerdate:unix)', 'refs/heads', 'refs/remotes'],
        ['/repo', 'for-each-ref', '--format=%(refname)%00%(*objectname)%00%(objectname)%00%(refname:short)%00%(*committerdate:short)%00%(committerdate:short)%00%(*committerdate:unix)%00%(committerdate:unix)', 'refs/tags'],
        ['/repo', 'log', '--all', '--max-count=50', '--date=short', '--format=%H%x00%ad%x00%ct%x00%P%x00%s'],
    ]);
});

test('every format parsed: branches, tags and commits after the working copy', async () => {
    const { service } = serviceWith({
        dirty: ' M src/a.py\n',
        branches: [
            row('refs/heads/main', sha('a'), 'main', '2026-01-03', '1767400000'),
            row('refs/heads/feature', sha('b'), 'feature', '2026-01-02', '1767300000'),
            row('refs/remotes/origin/HEAD', sha('a'), 'origin/HEAD', '2026-01-03', '1767400000'),
            row('refs/remotes/origin/main', sha('a'), 'origin/main', '', 'not-a-number'),
            row('refs/heads/broken', 'nothex', 'broken', '2026-01-01', '1'),
            row('', sha('c'), 'nameless', '2026-01-01', '1'),
            row('refs/heads/noshort', sha('c'), '', '2026-01-01', '1'),
            '',
        ].join('\r\n'),
        tags: [
            row('refs/tags/v2', sha('d'), sha('e'), 'v2', '2026-01-05', '2026-01-06', '1767600000', '1767700000'),
            row('refs/tags/light', '', sha('a'), 'light', '', '2026-01-03', '', '1767400000'),
            row('refs/tags/bad', '', 'zz', 'bad', '', '', '', ''),
        ].join('\n'),
        commits: [
            row(sha('a'), '2026-01-03', '1767400000', `${sha('b')} ${sha('f')}`, 'Merge feature'),
            row(sha('b'), '2026-01-02', '1767300000', sha('f'), 'Second'),
            row(sha('f'), '', '', '', ''),
            row('short', '2026-01-01', '1', '', 'not a commit'),
        ].join('\n') + '\n',
    });
    const references = await service.listReferences();
    const gitRef = (refType, refName, label, commitSha, extra) => ({
        id: idOf(refType, refName),
        kind: 'gitRef',
        refType,
        refName,
        commitSha,
        label,
        description: undefined,
        date: undefined,
        timestamp: undefined,
        live: false,
        revisionType: refType,
        parentCount: 0,
        ...extra,
    });
    assert.deepEqual(references, {
        repositoryRoot: '/repo',
        targetRelativePath: 'src',
        workingTreeDirty: true,
        activeBranch: 'main',
        sources: [
            {
                id: 'working-copy', kind: 'workingCopy', label: 'main (live) (modified)', activeBranch: 'main', dirty: true, live: true, revisionType: 'working-copy',
            },
            // refs/heads/main is the checked-out branch: the working copy stands for it.
            gitRef('branch', 'refs/heads/feature', 'feature', sha('b'), { date: '2026-01-02', timestamp: 1767300000 }),
            gitRef('branch', 'refs/remotes/origin/main', 'origin/main', sha('a')),
            // Annotated tag: the peeled commit and its dates win over the tag object's.
            gitRef('tag', 'refs/tags/v2', 'v2', sha('d'), { date: '2026-01-05', timestamp: 1767600000 }),
            gitRef('tag', 'refs/tags/light', 'light', sha('a'), { date: '2026-01-03', timestamp: 1767400000 }),
            gitRef('commit', sha('a'), 'aaaaaaaa', sha('a'), {
                description: '2026-01-03 Merge feature', date: '2026-01-03', timestamp: 1767400000, revisionType: 'merge', parentCount: 2,
            }),
            gitRef('commit', sha('b'), 'bbbbbbbb', sha('b'), {
                description: '2026-01-02 Second', date: '2026-01-02', timestamp: 1767300000, parentCount: 1,
            }),
            gitRef('commit', sha('f'), 'ffffffff', sha('f'), { description: '' }),
        ],
        pageSize: 5,
    });
    // Every listed source is what resolveSource looks up afterwards.
    assert.deepEqual([...service.sourceById.values()], references.sources);
});

test('a detached HEAD labels the working copy with the short SHA and keeps every branch', async () => {
    const { service } = serviceWith({
        head: null,
        branches: row('refs/heads/main', sha('a'), 'main', '2026-01-03', '1767400000'),
    });
    const references = await service.listReferences();
    assert.equal(references.activeBranch, null);
    assert.equal(references.workingTreeDirty, false);
    assert.deepEqual(references.sources[0], {
        id: 'working-copy', kind: 'workingCopy', label: 'Detached HEAD abcd1234 (live)', activeBranch: null, dirty: false, live: true, revisionType: 'working-copy',
    });
    assert.deepEqual(references.sources.slice(1).map((source) => source.label), ['main']);
});

test('an empty symbolic-ref answer counts as detached, and a clean tree has no modified mark', async () => {
    const { service, calls } = serviceWith({ head: '' });
    const references = await service.listReferences();
    assert.equal(references.sources[0].label, 'Detached HEAD abcd1234 (live)');
    assert.ok(calls.some((call) => call[1] === 'rev-parse'));
    const named = await serviceWith({ head: 'dev' }).service.listReferences();
    assert.equal(named.sources[0].label, 'dev (live)');
});
