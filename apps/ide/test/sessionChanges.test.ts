import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';
import { SessionChanges } from '../src/main/checkpoints/sessionChanges.ts';

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-session-changes-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

let counter = 0;

function setup(files: Record<string, string>, store: { maxFiles?: number } = {}): { root: string; changes: SessionChanges; basesFile: string } {
    counter += 1;
    const root = path.join(base, `project-${counter}`);
    fs.mkdirSync(root, { recursive: true });
    for (const [relative, content] of Object.entries(files)) {
        write(root, relative, content);
    }
    const basesFile = path.join(base, `review-${counter}.json`);
    const changes = new SessionChanges({ storageDir: path.join(base, 'checkpoints'), bases: new JsonKeyValueStore(basesFile), store });
    return { root, changes, basesFile };
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

describe('SessionChanges', () => {
    it('makes the first checkpoint of a chat its review base and lists what changed since', async () => {
        const { root, changes } = setup({ 'a.txt': 'a\n', 'src/b.ts': 'b\n' });
        assert.equal(await changes.afterTurn('s1', root), null, 'no base before the first message');
        const first = await changes.beforePrompt('s1', root);
        assert.ok(first);
        assert.equal(changes.reviewBase('s1')?.baseId, first.checkpointId);
        write(root, 'a.txt', 'a\nmore\n');
        write(root, 'new.md', 'hi\n');
        const second = await changes.beforePrompt('s1', root);
        assert.ok(second && second.checkpointId !== first.checkpointId);
        assert.equal(changes.reviewBase('s1')?.baseId, first.checkpointId, 'later checkpoints do not move the base');
        fs.rmSync(path.join(root, 'src', 'b.ts'));
        assert.equal(await changes.afterTurn('s1', root), 3);
        const pending = await changes.pending('s1', root);
        assert.equal(pending.disabledReason, null);
        assert.deepEqual(pending.files.map((file) => [file.path, file.status, file.additions, file.deletions]), [
            ['a.txt', 'modified', 1, 0],
            ['new.md', 'added', 1, 0],
            ['src/b.ts', 'deleted', 0, 1],
        ]);
        assert.deepEqual(await changes.changedSince(root, second.checkpointId), ['src/b.ts']);
        assert.deepEqual(await changes.diff('s1', root, 'a.txt'), { oldText: 'a\n', newText: 'a\nmore\n' });
        assert.deepEqual(await changes.diff('s1', root, 'new.md'), { oldText: null, newText: 'hi\n' });
        await changes.dispose();
    });

    it('keeps one file against a fresh snapshot, and shows it again only if it changes after', async () => {
        const { root, changes } = setup({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
        await changes.beforePrompt('s1', root);
        write(root, 'a.txt', 'A\n');
        write(root, 'b.txt', 'B\n');
        await changes.keep('s1', root, ['./a.txt']);
        assert.deepEqual((await changes.pending('s1', root)).files.map((file) => file.path), ['b.txt']);
        write(root, 'a.txt', 'AA\n');
        const pending = await changes.pending('s1', root);
        assert.deepEqual(pending.files.map((file) => file.path), ['a.txt', 'b.txt']);
        assert.deepEqual(await changes.diff('s1', root, 'a.txt'), { oldText: 'A\n', newText: 'AA\n' }, 'compared with what was kept');
        await changes.keep('s1', root, 'all');
        assert.deepEqual((await changes.pending('s1', root)).files, []);
        await changes.dispose();
    });

    it('undoes files from their own base: modified back, added deleted, deleted recreated', async () => {
        const { root, changes } = setup({ 'a.txt': 'a\n', 'gone.txt': 'g\n', 'keep.txt': 'k\n' });
        await changes.beforePrompt('s1', root);
        write(root, 'a.txt', 'changed\n');
        write(root, 'added.txt', 'new\n');
        fs.rmSync(path.join(root, 'gone.txt'));
        write(root, 'keep.txt', 'K\n');
        await changes.keep('s1', root, ['keep.txt']);
        write(root, 'keep.txt', 'KK\n');
        assert.deepEqual(await changes.undo('s1', root, ['a.txt']), ['a.txt']);
        assert.equal(read(root, 'a.txt'), 'a\n');
        const undone = await changes.undo('s1', root, 'all');
        assert.deepEqual(undone.sort(), ['added.txt', 'gone.txt', 'keep.txt']);
        assert.equal(read(root, 'added.txt'), null);
        assert.equal(read(root, 'gone.txt'), 'g\n');
        assert.equal(read(root, 'keep.txt'), 'K\n', 'a kept file goes back to what was kept');
        assert.deepEqual((await changes.pending('s1', root)).files, []);
        await assert.rejects(changes.undo('s1', root, ['../outside.txt']), /cannot leave the project/);
        await changes.dispose();
    });

    it('previews and restores the project to a checkpoint', async () => {
        const { root, changes } = setup({ 'a.txt': 'a\n' });
        const first = await changes.beforePrompt('s1', root);
        assert.ok(first);
        write(root, 'a.txt', 'turn 1\n');
        write(root, 'b.txt', 'b\n');
        await changes.beforePrompt('s1', root);
        write(root, 'a.txt', 'turn 2\n');
        assert.deepEqual((await changes.previewRestore(root, first.checkpointId)).sort(), ['a.txt', 'b.txt']);
        assert.equal(read(root, 'a.txt'), 'turn 2\n', 'a preview writes nothing');
        assert.deepEqual((await changes.restoreCheckpoint(root, first.checkpointId)).sort(), ['a.txt', 'b.txt']);
        assert.equal(read(root, 'a.txt'), 'a\n');
        assert.equal(read(root, 'b.txt'), null);
        assert.equal(await changes.afterTurn('s1', root), 0);
        assert.throws(() => changes.previewRestore(root, 'HEAD'), /Invalid checkpoint/);
        await changes.dispose();
    });

    it('persists review bases per chat and forgets a deleted chat', async () => {
        const { root, changes, basesFile } = setup({ 'a.txt': 'a\n' });
        const first = await changes.beforePrompt('s1', root);
        await changes.beforePrompt('s2', root);
        write(root, 'a.txt', 'b\n');
        await changes.dispose();
        const reopened = new SessionChanges({ storageDir: path.join(base, 'checkpoints'), bases: new JsonKeyValueStore(basesFile) });
        assert.equal(reopened.reviewBase('s1')?.baseId, first?.checkpointId);
        assert.equal(await reopened.afterTurn('s1', root), 1);
        await reopened.forget('s1');
        assert.equal(reopened.reviewBase('s1'), null);
        assert.ok(reopened.reviewBase('s2'));
        await assert.rejects(reopened.diff('s1', root, 'a.txt'), /no checkpoint/);
        await reopened.dispose();
    });

    it('degrades without checkpoints: no base, no count, the reason for the review', async () => {
        const { root, changes } = setup({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' }, { maxFiles: 1 });
        assert.equal(await changes.beforePrompt('s1', root), null);
        assert.equal(changes.reviewBase('s1'), null);
        assert.equal(await changes.afterTurn('s1', root), null);
        const pending = await changes.pending('s1', root);
        assert.deepEqual(pending.files, []);
        assert.ok(pending.disabledReason && pending.disabledReason.length > 0);
        assert.deepEqual(await changes.changedSince(root, 'a'.repeat(40)), []);
        await assert.rejects(changes.keep('s1', root, 'all'), /no checkpoint/);
        await changes.dispose();
    });
});
