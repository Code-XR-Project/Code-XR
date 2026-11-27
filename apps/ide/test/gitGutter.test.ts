import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blameText, changeAtLine, explorerDecorations, lineChanges, relativeTime, revertEdit, type LineChange } from '../src/shared/gitGutter.ts';
import { emptyGitStatus, type GitStatus } from '../src/shared/git.ts';

/** Applies a revert edit to `\n`-joined lines, as Monaco would. */
function apply(buffer: string, change: LineChange): string {
    const lines = buffer.split('\n');
    const edit = revertEdit(lines, change);
    const offset = (line: number, column: number): number => lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + column - 1;
    return buffer.slice(0, offset(edit.startLine, edit.startColumn)) + edit.text + buffer.slice(offset(edit.endLine, edit.endColumn));
}

describe('Gutter markers (#175)', () => {
    const head = 'a\nb\nc\nd\ne\n';

    it('marks added, modified and deleted lines of the buffer', () => {
        assert.deepEqual(lineChanges(head, head), []);
        const added = lineChanges(head, 'a\nb\nnew\nc\nd\ne\n');
        assert.deepEqual(added.map((c) => [c.kind, c.startLine, c.endLine]), [['added', 3, 3]]);
        const modified = lineChanges(head, 'a\nB\nC\nd\ne\n');
        assert.deepEqual(modified.map((c) => [c.kind, c.startLine, c.endLine, c.originalLines]), [['modified', 2, 3, ['b', 'c']]]);
        const deleted = lineChanges(head, 'a\nd\ne\n');
        assert.deepEqual(deleted.map((c) => [c.kind, c.startLine, c.originalLines]), [['deleted', 1, ['b', 'c']]]);
        const top = lineChanges(head, 'c\nd\ne\n');
        assert.deepEqual(top.map((c) => [c.kind, c.startLine]), [['deleted', 1]]);
    });

    it('ignores line endings', () => {
        assert.deepEqual(lineChanges('a\r\nb\r\n', 'a\nb\n'), []);
    });

    it('finds the change on a line', () => {
        const changes = lineChanges(head, 'a\nB\nC\nd\ne\nf\n');
        assert.equal(changeAtLine(changes, 3)?.kind, 'modified');
        assert.equal(changeAtLine(changes, 6)?.kind, 'added');
        assert.equal(changeAtLine(changes, 1), undefined);
    });

    it('reverts every kind of change back to HEAD, wherever it is', () => {
        const buffers = [
            'a\nb\nnew\nc\nd\ne\n', // added in the middle
            'new\na\nb\nc\nd\ne\n', // added at the top
            'a\nb\nc\nd\ne\nnew', // added at the end, no final newline
            'a\nB\nC\nd\ne\n', // modified
            'a\nd\ne\n', // deleted in the middle
            'c\nd\ne\n', // deleted at the top
            'a\nb\nc\n', // deleted at the end
        ];
        for (const buffer of buffers) {
            const changes = lineChanges(head, buffer);
            assert.equal(changes.length, 1, buffer);
            const [change] = changes;
            assert.ok(change);
            assert.equal(apply(buffer, change), head, JSON.stringify(buffer));
        }
        const noNewline = 'a\nb';
        const [extra] = lineChanges(noNewline, 'a\nb\nc');
        assert.ok(extra);
        assert.equal(apply('a\nb\nc', extra), noNewline);
    });
});

describe('Inline blame (#175)', () => {
    const now = Date.UTC(2026, 10, 27, 12, 0, 0);
    const at = (msAgo: number): number => Math.floor((now - msAgo) / 1000);

    it('says how long ago', () => {
        assert.equal(relativeTime(at(10_000), now), 'just now');
        assert.equal(relativeTime(at(60_000), now), '1 minute ago');
        assert.equal(relativeTime(at(3 * 3600_000), now), '3 hours ago');
        assert.equal(relativeTime(at(3 * 86400_000), now), '3 days ago');
        assert.equal(relativeTime(at(400 * 86400_000), now), '1 year ago');
        assert.equal(relativeTime(at(-5000), now), 'just now', 'a clock in the future');
    });

    it('writes the author, the time and the summary', () => {
        const line = { line: 1, hash: 'abcdef12', author: 'Ada', authorMail: '<ada@x>', authorTime: at(2 * 86400_000), summary: 'Fix the parser', uncommitted: false };
        assert.equal(blameText(line, now), 'Ada, 2 days ago - Fix the parser');
        assert.equal(blameText({ ...line, uncommitted: true }, now), 'You, uncommitted changes');
        assert.match(blameText({ ...line, summary: 'x'.repeat(120) }, now), /x{79}\.\.\.$/);
    });
});

describe('Explorer decorations (#175)', () => {
    it('colours changed files and their folders, the strongest state winning', () => {
        const status: GitStatus = {
            ...emptyGitStatus('ok'),
            staged: [{ path: 'src/new.ts', letter: 'A' }],
            changes: [{ path: 'src/new.ts', letter: 'M' }, { path: 'src/lib/old.ts', letter: 'D' }, { path: 'README.md', letter: 'M' }],
            untracked: [{ path: 'notes/todo.txt', letter: 'U' }],
        };
        const decorations = explorerDecorations(status);
        assert.deepEqual(decorations.get('src/new.ts'), { state: 'modified', letter: 'M' });
        assert.deepEqual(decorations.get('src/lib/old.ts'), { state: 'deleted', letter: 'D' });
        assert.deepEqual(decorations.get('src/lib'), { state: 'deleted', letter: '' });
        assert.deepEqual(decorations.get('src'), { state: 'deleted', letter: '' });
        assert.deepEqual(decorations.get('notes'), { state: 'untracked', letter: '' });
        assert.deepEqual(decorations.get('README.md'), { state: 'modified', letter: 'M' });
        assert.equal(explorerDecorations(emptyGitStatus('restricted')).size, 0);
    });
});
