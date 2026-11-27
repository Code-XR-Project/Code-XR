import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXCLUDED_NAMES, isIgnored, parseGitignore } from '../src/main/workspace/ignoreRules.ts';

function check(gitignore: string, cases: Array<[string, boolean, boolean]>): void {
    const rules = parseGitignore(gitignore);
    for (const [entry, isDir, expected] of cases) {
        assert.equal(isIgnored(entry, isDir, rules), expected, `${entry} (${isDir ? 'dir' : 'file'}) with ${JSON.stringify(gitignore)}`);
    }
}

describe('parseGitignore / isIgnored', () => {
    it('skips comments and blank lines', () => {
        assert.equal(parseGitignore('# comment\n\n   \n').length, 0);
    });

    it('matches a bare name at any depth', () => {
        check('out', [['out', true, true], ['apps/ide/out', true, true], ['outside', true, false], ['src/out.ts', false, false]]);
    });

    it('anchors a pattern with a slash to the root', () => {
        check('/dist\nbuild/cache', [['dist', true, true], ['apps/dist', true, false], ['build/cache', true, true], ['x/build/cache', true, false]]);
    });

    it('applies a trailing slash to folders only', () => {
        check('logs/', [['logs', true, true], ['logs', false, false], ['a/logs', true, true]]);
    });

    it('supports *, ? and character classes within a segment', () => {
        check('*.log\nfile?.txt\n[ab].md', [
            ['debug.log', false, true], ['a/b/debug.log', false, true], ['log', false, false],
            ['file1.txt', false, true], ['file10.txt', false, false],
            ['a.md', false, true], ['c.md', false, false],
        ]);
    });

    it('supports ** across folders', () => {
        check('**/temp\ndocs/**/*.pdf\ncache/**', [
            ['temp', true, true], ['a/b/temp', true, true],
            ['docs/x.pdf', false, true], ['docs/a/b/x.pdf', false, true], ['other/x.pdf', false, false],
            ['cache/a', false, true], ['cache', true, false],
        ]);
    });

    it('lets the last matching rule win, so ! re-includes', () => {
        check('*.env\n!example.env', [['prod.env', false, true], ['example.env', false, false]]);
    });

    it('honours escapes and CRLF line endings', () => {
        check('\\#notes\r\n\\!important\r\n', [['#notes', false, true], ['!important', false, true]]);
    });

    it('treats regex characters literally', () => {
        check('a+b.(x)', [['a+b.(x)', false, true], ['aab.(x)', false, false]]);
    });
});

describe('EXCLUDED_NAMES', () => {
    it('never lists .git or node_modules', () => {
        assert.ok(EXCLUDED_NAMES.has('.git'));
        assert.ok(EXCLUDED_NAMES.has('node_modules'));
    });
});
