import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    createWorkspaceFileChecker,
    findFileLinks,
    readLogicalLine,
    toWorkspacePath,
    type BufferLike,
    type TerminalLinkContext,
} from '../src/renderer/terminal/terminalLinks.ts';

const posix: TerminalLinkContext = { root: '/home/dev/project', platform: 'linux' };
const windows: TerminalLinkContext = { root: 'C:\\Users\\dev\\project', platform: 'win32' };

/** The links of a line, as `[text, path, line, column]`. */
function links(text: string, context: TerminalLinkContext = posix): Array<[string, string, number | undefined, number | undefined]> {
    return findFileLinks(text, context).map((link) => {
        assert.equal(text.slice(link.start, link.end), link.text, 'the range covers the text');
        return [link.text, link.path, link.line, link.column];
    });
}

describe('findFileLinks: relative paths, lines and columns', () => {
    it('reads path:line:column, path:line and a bare path', () => {
        assert.deepEqual(links('error in src/a.ts:12:5 here'), [['src/a.ts:12:5', 'src/a.ts', 12, 5]]);
        assert.deepEqual(links('./a.py:3'), [['./a.py:3', 'a.py', 3, undefined]]);
        assert.deepEqual(links('see src/app/main.ts'), [['src/app/main.ts', 'src/app/main.ts', undefined, undefined]]);
        assert.deepEqual(links('package.json'), [['package.json', 'package.json', undefined, undefined]]);
    });

    it('reads the tsc and MSBuild form, a.js(12,5)', () => {
        assert.deepEqual(links('a.js(12,5): error TS2322'), [['a.js(12,5)', 'a.js', 12, 5]]);
        assert.deepEqual(links('src/b.ts(7): warning'), [['src/b.ts(7)', 'src/b.ts', 7, undefined]]);
        assert.deepEqual(links('src/b.ts(7, 9)'), [['src/b.ts(7, 9)', 'src/b.ts', 7, 9]]);
    });

    it('leaves a sentence full stop, quotes and brackets out of the link', () => {
        assert.deepEqual(links('Wrote src/out.txt.'), [['src/out.txt', 'src/out.txt', undefined, undefined]]);
        assert.deepEqual(links('"src/a.ts"'), [['src/a.ts', 'src/a.ts', undefined, undefined]]);
        assert.deepEqual(links('[src/a.ts:4]'), [['src/a.ts:4', 'src/a.ts', 4, undefined]]);
    });

    it('finds several links on one line, in order', () => {
        assert.deepEqual(links('src/a.ts:1 and lib/b.js:2:3'), [
            ['src/a.ts:1', 'src/a.ts', 1, undefined],
            ['lib/b.js:2:3', 'lib/b.js', 2, 3],
        ]);
    });

    it('does not take plain words, numbers, times or versions for files', () => {
        assert.deepEqual(links('Done in 12:30, all tests passed'), []);
        assert.deepEqual(links('node v24.1.0 ready at 10:20:30.123'), []);
        assert.deepEqual(links('...'), []);
    });

    it('ignores a line or column of 0', () => {
        assert.deepEqual(links('src/a.ts:0'), [['src/a.ts:0', 'src/a.ts', undefined, undefined]]);
        assert.deepEqual(links('src/a.ts:3:0'), [['src/a.ts:3:0', 'src/a.ts', 3, undefined]]);
    });

    it('rejects relative paths that climb out of the folder, and home paths', () => {
        assert.deepEqual(links('../other/a.ts:3'), []);
        assert.deepEqual(links('src/../../a.ts'), []);
        assert.deepEqual(links('~/notes.md'), []);
        assert.deepEqual(links('src/../a.ts'), [['src/../a.ts', 'a.ts', undefined, undefined]]);
    });
});

describe('findFileLinks: absolute paths and stack traces (POSIX)', () => {
    it('converts absolute paths inside the folder to workspace paths', () => {
        assert.deepEqual(links('/home/dev/project/src/a.ts:12:5'), [['/home/dev/project/src/a.ts:12:5', 'src/a.ts', 12, 5]]);
    });

    it('rejects absolute paths outside the folder, the folder itself and look-alike siblings', () => {
        assert.deepEqual(links('/usr/lib/node/x.js:1:1'), []);
        assert.deepEqual(links('/home/dev/project'), []);
        assert.deepEqual(links('/home/dev/project-other/a.ts'), []);
        assert.deepEqual(links('/home/dev/project/../secret/a.ts'), []);
    });

    it('reads Python tracebacks', () => {
        const line = '  File "/home/dev/project/pkg/x.py", line 12, in <module>';
        assert.deepEqual(links(line), [['/home/dev/project/pkg/x.py', 'pkg/x.py', 12, undefined]]);
        assert.deepEqual(links('  File "app.py", line 3, in main'), [['app.py', 'app.py', 3, undefined]]);
        assert.deepEqual(links('  File "/usr/lib/python3.12/runpy.py", line 198, in _run'), []);
    });

    it('reads Node stack frames, named, anonymous and file:// ones', () => {
        assert.deepEqual(links('    at fn (/home/dev/project/x.js:12:5)'), [['/home/dev/project/x.js:12:5', 'x.js', 12, 5]]);
        assert.deepEqual(links('    at /home/dev/project/lib/y.js:3:9'), [['/home/dev/project/lib/y.js:3:9', 'lib/y.js', 3, 9]]);
        assert.deepEqual(links('    at file:///home/dev/project/m%20n.mjs:4:2'), [['file:///home/dev/project/m%20n.mjs:4:2', 'm n.mjs', 4, 2]]);
        assert.deepEqual(links('    at Module._compile (node:internal/modules/cjs/loader:1554:14)'), [], 'a Node built-in frame is not a file');
    });

    it('treats backslashes and drive letters as not a path off Windows', () => {
        assert.deepEqual(links('C:\\Users\\dev\\project\\a.ts:3'), []);
        assert.deepEqual(links('src\\a.ts:3'), []);
    });
});

describe('findFileLinks: Windows paths', () => {
    it('converts drive paths inside the folder, with either separator and any case', () => {
        assert.deepEqual(links('C:\\Users\\dev\\project\\src\\a.ts:12:5', windows), [['C:\\Users\\dev\\project\\src\\a.ts:12:5', 'src/a.ts', 12, 5]]);
        assert.deepEqual(links('c:/users/DEV/project/src/a.ts(3,4)', windows), [['c:/users/DEV/project/src/a.ts(3,4)', 'src/a.ts', 3, 4]]);
    });

    it('reads relative paths with backslashes', () => {
        assert.deepEqual(links('.\\src\\a.ts:7', windows), [['.\\src\\a.ts:7', 'src/a.ts', 7, undefined]]);
        assert.deepEqual(links('src\\b.ts(2,1): error', windows), [['src\\b.ts(2,1)', 'src/b.ts', 2, 1]]);
    });

    it('rejects other drives, other folders, rooted paths without a drive and UNC paths', () => {
        assert.deepEqual(links('D:\\Users\\dev\\project\\a.ts', windows), []);
        assert.deepEqual(links('C:\\Windows\\system32\\x.dll', windows), []);
        assert.deepEqual(links('\\Users\\dev\\project\\a.ts', windows), []);
        assert.deepEqual(links('\\\\server\\share\\a.ts', windows), []);
    });

    it('reads Python tracebacks and Node frames with Windows paths', () => {
        assert.deepEqual(links('  File "C:\\Users\\dev\\project\\x.py", line 12, in f', windows), [['C:\\Users\\dev\\project\\x.py', 'x.py', 12, undefined]]);
        assert.deepEqual(links('    at f (C:\\Users\\dev\\project\\x.js:12:5)', windows), [['C:\\Users\\dev\\project\\x.js:12:5', 'x.js', 12, 5]]);
        assert.deepEqual(links('    at file:///C:/Users/dev/project/x.mjs:1:2', windows), [['file:///C:/Users/dev/project/x.mjs:1:2', 'x.mjs', 1, 2]]);
    });
});

describe('findFileLinks: URLs are not paths', () => {
    it('leaves http(s) and other scheme URLs to the web-links addon', () => {
        assert.deepEqual(links('open https://example.com/src/a.ts:12 now'), []);
        assert.deepEqual(links('http://localhost:5173/index.html'), []);
        assert.deepEqual(links('ssh://git@host/repo.git'), []);
    });

    it('still finds a path next to a URL', () => {
        assert.deepEqual(links('see https://x.org/a.js and src/a.ts:2'), [['src/a.ts:2', 'src/a.ts', 2, undefined]]);
    });
});

describe('toWorkspacePath', () => {
    it('normalises the root, trailing separators included', () => {
        assert.equal(toWorkspacePath('/home/dev/project/a.ts', { root: '/home/dev/project/', platform: 'linux' }), 'a.ts');
        assert.equal(toWorkspacePath('C:\\p\\a.ts', { root: 'C:\\p\\', platform: 'win32' }), 'a.ts');
        assert.equal(toWorkspacePath('/a.ts', { root: '/', platform: 'linux' }), 'a.ts');
    });

    it('refuses NUL and empty paths', () => {
        assert.equal(toWorkspacePath('a\0.ts', posix), null);
        assert.equal(toWorkspacePath('', posix), null);
        assert.equal(toWorkspacePath('./', posix), null);
    });
});

describe('readLogicalLine', () => {
    /** A buffer of fixed-width rows; `wrapped` marks rows continuing the previous one. */
    function buffer(rows: ReadonlyArray<{ text: string; wrapped?: boolean; wide?: number }>, cols: number): BufferLike {
        return {
            length: rows.length,
            getLine(y) {
                const row = rows[y];
                if (!row) { return undefined; }
                // A wide character at index `wide` takes two cells; the second has width 0.
                const cells: Array<{ chars: string; width: number }> = [];
                for (let i = 0; i < row.text.length; i++) {
                    cells.push({ chars: row.text[i] ?? '', width: i === row.wide ? 2 : 1 });
                    if (i === row.wide) { cells.push({ chars: '', width: 0 }); }
                }
                while (cells.length < cols) { cells.push({ chars: '', width: 1 }); }
                return {
                    isWrapped: row.wrapped ?? false,
                    length: cols,
                    getCell: (x) => {
                        const cell = cells[x];
                        return cell ? { getChars: () => cell.chars, getWidth: () => cell.width } : undefined;
                    },
                };
            },
        };
    }

    it('joins wrapped rows and maps each character to its cell', () => {
        const buf = buffer([{ text: 'x' }, { text: 'at /home/d' }, { text: 'ev/a.ts:3', wrapped: true }, { text: 'next' }], 10);
        for (const y of [1, 2]) {
            const line = readLogicalLine(buf, y);
            assert.equal(line.text, 'at /home/dev/a.ts:3');
            assert.equal(line.cells.length, line.text.length);
            assert.deepEqual(line.cells[3], { x: 3, y: 1 });
            assert.deepEqual(line.cells[10], { x: 0, y: 2 });
            assert.deepEqual(line.cells.at(-1), { x: 8, y: 2 });
        }
        assert.equal(readLogicalLine(buf, 3).text, 'next');
    });

    it('skips the second cell of a wide character', () => {
        const line = readLogicalLine(buffer([{ text: '\u4e2d a.ts', wide: 0 }], 12), 0);
        assert.equal(line.text, '\u4e2d a.ts');
        assert.deepEqual(line.cells[2], { x: 3, y: 0 });
    });
});

describe('createWorkspaceFileChecker', () => {
    const tree: Record<string, Array<{ path: string; kind: 'file' | 'directory' }>> = {
        '': [{ path: 'src', kind: 'directory' }, { path: 'README.md', kind: 'file' }],
        src: [{ path: 'src/a.ts', kind: 'file' }],
    };

    it('answers with the file, null for a folder or a missing file, and reuses listings for a while', async () => {
        let calls = 0;
        let time = 0;
        const check = createWorkspaceFileChecker(async (path) => {
            calls++;
            const entries = tree[path];
            if (!entries) { throw new Error('no such folder'); }
            return entries;
        }, 'linux', 1000, () => time);
        assert.equal(await check('src/a.ts'), 'src/a.ts');
        assert.equal(await check('src/b.ts'), null);
        assert.equal(calls, 1);
        assert.equal(await check('src'), null, 'a folder is not a file link');
        assert.equal(await check('SRC/A.TS'), null, 'case matters on Linux');
        assert.equal(await check('lib/x.ts'), null, 'a listing that fails is no file');
        time = 2000;
        assert.equal(await check('src/a.ts'), 'src/a.ts');
        assert.equal(calls, 5);
    });

    it('matches without case on Windows and macOS, answering the real name', async () => {
        for (const platform of ['win32', 'darwin']) {
            const check = createWorkspaceFileChecker(async (path) => tree[path] ?? [], platform);
            assert.equal(await check('readme.MD'), 'README.md');
        }
    });
});
