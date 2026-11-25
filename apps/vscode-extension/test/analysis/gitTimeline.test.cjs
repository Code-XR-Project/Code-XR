/**
 * S11 (#83): the project-evolution timeline follows the history that is
 * checked out (EVO-6, EVO-7, EVO-12). Runs the compiled GitRepositoryService
 * and projectEvolutionTimeline against real temporary repositories.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { GitRepositoryService } = require('../../out/core/history/gitRepositoryService.js');
const {
    TIMELINE_SCAN_SAMPLE,
    buildAutomaticTimeline,
    buildRangeTimeline,
} = require('../../out/core/history/projectEvolutionTimeline.js');

const roots = [];
test.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function git(cwd, args, env = {}) {
    return childProcess.execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

function newRepository() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-git-timeline-'));
    roots.push(root);
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '--quiet', '--initial-branch=main']);
    git(repo, ['config', 'user.name', 'CodeXR Tests']);
    git(repo, ['config', 'user.email', 'codexr-tests@example.invalid']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['config', 'tag.gpgsign', 'false']);
    let clock = Date.parse('2024-01-01T00:00:00Z') / 1000;
    const commit = (message, content = message) => {
        fs.writeFileSync(path.join(repo, 'main.js'), `export const value = ${JSON.stringify(content)};\n`);
        git(repo, ['add', '.']);
        clock += 3600;
        const date = `${clock} +0000`;
        git(repo, ['commit', '--quiet', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
        return git(repo, ['rev-parse', 'HEAD']);
    };
    const service = () => new GitRepositoryService(repo, path.join(root, `snapshots-${Math.random()}`));
    return { root, repo, commit, service };
}

/** `count` linear commits on main through fast-import: fast for big histories. */
function bigRepository(count) {
    const fixture = newRepository();
    const parts = [];
    for (let index = 1; index <= count; index += 1) {
        const message = `c${index}`;
        const content = `export const value = ${index};\n`;
        parts.push(
            'commit refs/heads/main',
            `mark :${index}`,
            `committer CodeXR Tests <codexr-tests@example.invalid> ${1700000000 + index * 60} +0000`,
            `data ${Buffer.byteLength(message)}`,
            message,
            ...(index > 1 ? [`from :${index - 1}`] : []),
            'M 644 inline main.js',
            `data ${Buffer.byteLength(content)}`,
            content,
        );
    }
    childProcess.execFileSync('git', ['fast-import', '--quiet'], {
        cwd: fixture.repo,
        input: `${parts.join('\n')}\n`,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    git(fixture.repo, ['reset', '--quiet', '--hard', 'main']);
    return fixture;
}

const subjectOf = (source) => String(source.description || '').replace(/^\S+\s/, '');

test('S11 EVO-6: the timeline is HEAD\'s first-parent history; stashes, notes and other branches never become frames', async () => {
    const { repo, commit, service } = newRepository();
    const c1 = commit('c1');
    const c2 = commit('c2');
    // Another branch, newer than HEAD.
    git(repo, ['checkout', '--quiet', '-b', 'other']);
    commit('other newer');
    git(repo, ['checkout', '--quiet', 'main']);
    // A note and a stash.
    git(repo, ['notes', 'add', '-m', 'a note', c2]);
    fs.writeFileSync(path.join(repo, 'main.js'), 'export const value = "WIP";\n');
    git(repo, ['stash', 'push', '--quiet', '-m', 'WIP never committed']);

    const gitService = service();
    const timeline = await gitService.listTimelineSources(null);
    assert.deepEqual(timeline.map((source) => source.commitSha), [c1, c2]);
    const references = await gitService.listReferences();
    const subjects = references.sources.map(subjectOf).join('\n');
    assert.doesNotMatch(subjects, /WIP never committed|index on main|Notes added/);
    const movie = await buildAutomaticTimeline(gitService, references);
    assert.deepEqual(movie.map((source) => source.commitSha || source.id), [c1, c2, 'working-copy']);

    // Detached at c1: nothing newer than the checkout plays before the end.
    git(repo, ['checkout', '--quiet', '--detach', c1]);
    const detached = service();
    const detachedMovie = await buildAutomaticTimeline(detached, await detached.listReferences());
    assert.deepEqual(detachedMovie.map((source) => source.commitSha || source.id), [c1, 'working-copy']);
});

test('S11 EVO-6: a merge is one step of the branch it landed on', async () => {
    const { repo, commit, service } = newRepository();
    const c1 = commit('c1');
    git(repo, ['checkout', '--quiet', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'side.js'), 'export const side = 1;\n');
    git(repo, ['add', 'side.js']);
    git(repo, ['commit', '--quiet', '-m', 'side']);
    const side = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '--quiet', 'main']);
    const c2 = commit('c2');
    git(repo, ['merge', '--quiet', '--no-ff', '-m', 'merge feature', 'feature']);
    const merge = git(repo, ['rev-parse', 'HEAD']);
    const timeline = await service().listTimelineSources(null);
    assert.deepEqual(timeline.map((source) => source.commitSha), [c1, c2, merge]);
    assert.equal(timeline.at(-1).revisionType, 'merge');
    assert.ok(!timeline.some((source) => source.commitSha === side));
});

test('S11 EVO-7: a long history is sampled from its first commit, and an old tag works as a range start', async () => {
    const { repo, service } = bigRepository(300);
    const shas = git(repo, ['rev-list', '--reverse', 'HEAD']).split('\n');
    git(repo, ['tag', 'v0.1', shas[4]]);
    const gitService = service();
    const references = await gitService.listReferences();
    const movie = await buildAutomaticTimeline(gitService, references);
    assert.equal(movie[0].commitSha, shas[0], 'the root commit opens the movie');
    assert.equal(movie.at(-2).commitSha, shas.at(-1), 'HEAD is the last commit');
    assert.equal(movie.at(-1).id, 'working-copy');
    assert.ok(movie.length <= TIMELINE_SCAN_SAMPLE + 1);

    const tag = references.sources.find((source) => source.label === 'v0.1');
    assert.ok(tag, 'the old tag is offered');
    const range = await buildRangeTimeline(gitService, references, tag.id, 'working-copy');
    assert.equal(range[0].commitSha, shas[4]);
    assert.equal(range.at(-1).id, 'working-copy');
    // Same range picked in the other order.
    const reversed = await buildRangeTimeline(gitService, references, 'working-copy', tag.id);
    assert.deepEqual(reversed.map((source) => source.id), range.map((source) => source.id));
});

test('S11 EVO-7: a range is resolved by Git: either order, and diverging ends start at their merge base', async () => {
    const { repo, commit, service } = newRepository();
    const c1 = commit('c1');
    const c2 = commit('c2');
    const c3 = commit('c3');
    git(repo, ['checkout', '--quiet', '-b', 'feature', c2]);
    const f1 = commit('f1');
    git(repo, ['checkout', '--quiet', 'main']);
    const gitService = service();
    const references = await gitService.listReferences();
    await gitService.listTimelineSources(null);
    const idOf = (sha) => references.sources.find((source) => source.commitSha === sha && source.refType === 'commit')?.id;

    const forward = await buildRangeTimeline(gitService, references, idOf(c1), idOf(c3));
    assert.deepEqual(forward.map((source) => source.commitSha), [c1, c2, c3]);
    const backward = await buildRangeTimeline(gitService, references, idOf(c3), idOf(c1));
    assert.deepEqual(backward.map((source) => source.commitSha), [c1, c2, c3]);
    const feature = references.sources.find((source) => source.refType === 'branch' && source.label === 'feature');
    const diverging = await buildRangeTimeline(gitService, references, idOf(c3), feature.id);
    assert.deepEqual(diverging.map((source) => source.commitSha), [c2, f1]);

    await assert.rejects(
        buildRangeTimeline(gitService, references, 'commit-does-not-exist', idOf(c3)),
        /no longer in this repository/,
    );
});

test('S11 EVO-7: a tag on a tree is not offered by the picker', async () => {
    const { repo, commit, service } = newRepository();
    commit('c1');
    git(repo, ['tag', 'tree-tag', 'HEAD^{tree}']);
    git(repo, ['tag', 'good']);
    const references = await service().listReferences();
    const tags = references.sources.filter((source) => source.refType === 'tag').map((source) => source.label);
    assert.deepEqual(tags, ['good']);
});

test('S11 EVO-12: "latest N" is not clamped to 1000, and the count is the checked-out history', async () => {
    const { service } = bigRepository(1100);
    const gitService = service();
    assert.equal(await gitService.countTimelineCommits(), 1100);
    const latest = await gitService.listTimelineSources(1050);
    assert.equal(latest.length, 1050);
    assert.equal(subjectOf(latest.at(-1)), 'c1100');
    assert.equal(subjectOf(latest[0]), 'c51');
    const all = await gitService.listTimelineSources(null);
    assert.equal(all.length, 1100);
});

test('S11: an empty repository has an empty timeline and a zero count, not an error', async () => {
    const { service } = newRepository();
    const gitService = service();
    assert.deepEqual(await gitService.listTimelineSources(null), []);
    assert.equal(await gitService.countTimelineCommits(), 0);
});
