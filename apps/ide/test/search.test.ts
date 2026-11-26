import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SearchQuery } from '../src/shared/api.ts';
import { compileQuery, expandReplacement, findInText, replaceInText, type CompiledQuery } from '../src/shared/searchText.ts';
import { compileGlobs, pathMatches, searchWorkspace } from '../src/main/workspace/textSearch.ts';
import { parseSearchQuery } from '../src/main/workspace/searchService.ts';
import { parseGitignore } from '../src/main/workspace/ignoreRules.ts';
import { Workspace } from '../src/main/workspace/workspace.ts';
import { searchSummary } from '../src/renderer/search/searchModel.ts';

const q = (pattern: string, overrides: Partial<SearchQuery> = {}): SearchQuery => ({
    pattern, isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', ...overrides,
});
const compiled = (query: SearchQuery): CompiledQuery => {
    const result = compileQuery(query);
    assert.ok(!('error' in result), 'query should compile');
    return result;
};

async function tree(files: Record<string, string | Buffer>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'codexr-search-'));
    for (const [relative, content] of Object.entries(files)) {
        const absolute = path.join(root, ...relative.split('/'));
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, content);
    }
    return root;
}

describe('search text (#165)', () => {
    it('escapes a literal query and honours case and whole word', () => {
        assert.equal(findInText('a.b axb A.B', compiled(q('a.b')).regex).total, 2);
        assert.equal(findInText('a.b axb A.B', compiled(q('a.b', { matchCase: true })).regex).total, 1);
        assert.equal(findInText('cat concat cat_x cats', compiled(q('cat', { wholeWord: true })).regex).total, 1);
        assert.equal(findInText('x1 x22', compiled(q('x\\d+', { isRegex: true })).regex).total, 2);
    });

    it('reports an invalid regular expression or an empty query instead of throwing', () => {
        assert.match((compileQuery(q('(', { isRegex: true })) as { error: string }).error, /Invalid regular expression/);
        assert.match((compileQuery(q('')) as { error: string }).error, /Type something/);
    });

    it('gives 1-based lines and columns, works on CRLF text and skips empty matches', () => {
        const found = findInText('first\r\nsecond foo\r\nfoo', compiled(q('foo')).regex);
        assert.deepEqual(found.matches.map((match) => [match.line, match.column, match.length]), [[2, 8, 3], [3, 1, 3]]);
        assert.equal(findInText('aaa\nbbb', compiled(q('x*', { isRegex: true })).regex).total, 0);
        assert.equal(findInText('end\nend', compiled(q('$', { isRegex: true })).regex).total, 0);
        assert.equal(findInText('foo\nbar', compiled(q('^bar$', { isRegex: true })).regex).total, 1);
    });

    it('cuts a long line around the match and points at it inside the preview', () => {
        const line = `${'x'.repeat(100)}NEEDLE${'y'.repeat(300)}`;
        const [match] = findInText(line, compiled(q('needle')).regex).matches;
        assert.ok(match);
        assert.equal(match.preview.slice(match.previewStart, match.previewStart + match.length), 'NEEDLE');
        assert.ok(match.preview.startsWith('…'));
        assert.ok(match.preview.length < 220);
    });

    it('caps the listed matches but counts them all', () => {
        const found = findInText('a a a a a', compiled(q('a')).regex, 2);
        assert.equal(found.matches.length, 2);
        assert.equal(found.total, 5);
    });

    it('replaces literally, keeping $ signs and line endings', () => {
        const result = replaceInText('price: x\r\nx', compiled(q('x')).regex, '$1 & $&', false);
        assert.equal(result.text, 'price: $1 & $&\r\n$1 & $&');
        assert.equal(result.count, 2);
    });

    it('expands groups in a regular-expression replacement', () => {
        const query = q('(\\w+)@(\\w+)', { isRegex: true });
        assert.equal(replaceInText('ana@host bob@srv', compiled(query).regex, '$2:$1 [$&] $$', true).text, 'host:ana [ana@host] $ srv:bob [bob@srv] $');
        const named = q('(?<word>\\w+)!', { isRegex: true });
        assert.equal(replaceInText('hi!', compiled(named).regex, '<$<word>>', true).text, '<hi>');
        assert.equal(expandReplacement('$10', ['ab', 'a', 0, 'ab']), 'a0');
        assert.equal(replaceInText('aaa', compiled(q('x*', { isRegex: true })).regex, '-', true).count, 0);
    });
});

describe('workspace search (#165)', () => {
    it('finds matches across files, honouring include, exclude and ignore rules, and skipping binary files', async () => {
        const root = await tree({
            'src/a.ts': 'const needle = 1;\n', 'src/b.test.ts': 'needle\n', 'docs/n.md': 'needle', 'build/x.js': 'needle',
            'img.png': Buffer.from([0x89, 0x50, 0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]), 'other.txt': 'nothing here',
        });
        try {
            const run = async (overrides: Partial<SearchQuery>) => {
                const query = q('needle', overrides);
                const seen: string[] = [];
                const stats = await searchWorkspace(root, parseGitignore('build/\n'), query, compiled(query), (file) => seen.push(file), new AbortController().signal);
                return { seen: seen.sort(), stats };
            };
            const all = await run({});
            assert.deepEqual(all.seen, ['docs/n.md', 'src/a.ts', 'src/b.test.ts']);
            assert.deepEqual([all.stats.files, all.stats.matches, all.stats.limitHit, all.stats.cancelled], [3, 3, false, false]);
            assert.deepEqual((await run({ include: 'src' })).seen, ['src/a.ts', 'src/b.test.ts']);
            assert.deepEqual((await run({ include: 'src', exclude: '*.test.ts' })).seen, ['src/a.ts']);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('stops at the match limit, and when cancelled', async () => {
        const root = await tree({ 'a.txt': 'x x x', 'b.txt': 'x x x', 'c.txt': 'x' });
        try {
            const query = q('x');
            const limited = await searchWorkspace(root, [], query, compiled(query), () => undefined, new AbortController().signal, 4);
            assert.equal(limited.limitHit, true);
            const controller = new AbortController();
            controller.abort();
            const cancelled = await searchWorkspace(root, [], query, compiled(query), () => undefined, controller.signal);
            assert.equal(cancelled.cancelled, true);
            assert.equal(cancelled.files, 0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('matches globs against the file or any of its folders', () => {
        const rules = compileGlobs('src, *.md')!;
        assert.ok(pathMatches('src/deep/a.ts', rules));
        assert.ok(pathMatches('docs/readme.md', rules));
        assert.ok(!pathMatches('lib/a.ts', rules));
        assert.equal(compileGlobs(' , '), null);
    });

    it('replaces on disk through the workspace, checking every path', async () => {
        const root = await tree({ 'a.txt': 'old old\n', 'b.txt': 'nothing\n' });
        try {
            const workspace = await Workspace.open(root);
            const query = q('old');
            const result = await workspace.replaceInFiles(query, compiled(query), 'new', ['a.txt', 'b.txt', '../outside.txt']);
            assert.equal(result.files, 1);
            assert.equal(result.replacements, 2);
            assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'new new\n');
            assert.deepEqual(result.failed.map((failure) => failure.path), ['../outside.txt']);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('accepts only a well-formed query from the renderer', () => {
        assert.deepEqual(parseSearchQuery(q('x')), q('x'));
        assert.throws(() => parseSearchQuery({ ...q('x'), isRegex: 'yes' }), /isRegex/);
        assert.throws(() => parseSearchQuery({ ...q('x'), pattern: 'p'.repeat(5000) }), /pattern/);
        assert.throws(() => parseSearchQuery(null), /Invalid search query/);
    });
});

describe('search summary (#165)', () => {
    const base = { hasQuery: true, files: 2, matches: 5, done: true, limitHit: false, error: null };
    it('says how many results were found, while searching and at the limit', () => {
        assert.equal(searchSummary(base), '5 results in 2 files');
        assert.equal(searchSummary({ ...base, matches: 1, files: 1 }), '1 result in 1 file');
        assert.equal(searchSummary({ ...base, done: false }), '5 results in 2 files, searching…');
        assert.match(searchSummary({ ...base, limitHit: true }), /stopped at its limit/);
        assert.match(searchSummary({ ...base, matches: 0, files: 0 }), /No results found/);
        assert.equal(searchSummary({ ...base, error: 'Invalid regular expression: x' }), 'Invalid regular expression: x');
        assert.equal(searchSummary({ ...base, hasQuery: false }), '');
    });
});
