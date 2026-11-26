/**
 * A pure parser for `git blame --porcelain` (#17), the base for inline blame
 * and gutter markers (#175). Unit-tested on strings (test/git.test.ts).
 *
 * Format reference: git-blame(1), "The Porcelain Format". Each line of the
 * file is a header `<sha> <orig-line> <final-line> [<group-size>]`, then the
 * commit's key-value lines the first time that commit appears, then the
 * line's content prefixed by a TAB.
 */

/** A commit as blame describes it. Lines not committed yet carry the all-zero hash and `uncommitted: true`. */
export interface BlameCommit {
    readonly hash: string;
    readonly author: string;
    readonly authorMail: string;
    /** Seconds since the epoch. */
    readonly authorTime: number;
    /** The author's offset, `+0100` style. */
    readonly authorTz: string;
    readonly committer: string;
    readonly committerTime: number;
    readonly summary: string;
    /** The commit has no parent in the blamed range (`boundary`). */
    readonly boundary: boolean;
    readonly uncommitted: boolean;
}

export interface BlameLine {
    /** 1-based line in the current file. */
    readonly line: number;
    /** 1-based line in `commit`'s version of the file. */
    readonly originalLine: number;
    /** The file's path in that commit, relative to the top of the work tree (differs after a rename). */
    readonly originalPath: string;
    readonly commit: BlameCommit;
    readonly content: string;
}

const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/;
const ZERO = /^0+$/;

interface MutableCommit {
    hash: string;
    author: string;
    authorMail: string;
    authorTime: number;
    authorTz: string;
    committer: string;
    committerTime: number;
    summary: string;
    boundary: boolean;
    uncommitted: boolean;
    filename: string;
}

export function parseBlamePorcelain(output: string): BlameLine[] {
    const commits = new Map<string, MutableCommit>();
    const lines: BlameLine[] = [];
    let current: { commit: MutableCommit; originalLine: number; line: number } | null = null;
    for (const raw of output.split('\n')) {
        if (current === null) {
            const match = HEADER.exec(raw);
            if (!match) {
                continue;
            }
            const hash = match[1] ?? '';
            let commit = commits.get(hash);
            if (!commit) {
                commit = {
                    hash, author: '', authorMail: '', authorTime: 0, authorTz: '', committer: '', committerTime: 0,
                    summary: '', boundary: false, uncommitted: ZERO.test(hash), filename: '',
                };
                commits.set(hash, commit);
            }
            current = { commit, originalLine: Number(match[2]), line: Number(match[3]) };
            continue;
        }
        if (raw.startsWith('\t')) {
            const { commit, originalLine, line } = current;
            lines.push({ line, originalLine, originalPath: commit.filename, commit: freeze(commit), content: raw.slice(1) });
            current = null;
            continue;
        }
        const space = raw.indexOf(' ');
        const key = space < 0 ? raw : raw.slice(0, space);
        const value = space < 0 ? '' : raw.slice(space + 1);
        const commit = current.commit;
        switch (key) {
            case 'author': commit.author = value; break;
            case 'author-mail': commit.authorMail = value.replace(/^<|>$/g, ''); break;
            case 'author-time': commit.authorTime = Number(value) || 0; break;
            case 'author-tz': commit.authorTz = value; break;
            case 'committer': commit.committer = value; break;
            case 'committer-time': commit.committerTime = Number(value) || 0; break;
            case 'summary': commit.summary = value; break;
            case 'boundary': commit.boundary = true; break;
            case 'filename': commit.filename = value; break;
            default: break;
        }
    }
    return lines;
}

/** One frozen view per commit, shared by its lines. */
const frozen = new WeakMap<MutableCommit, BlameCommit>();
function freeze(commit: MutableCommit): BlameCommit {
    let view = frozen.get(commit);
    if (!view) {
        const { filename: _filename, ...rest } = commit;
        view = Object.freeze(rest);
        frozen.set(commit, view);
    }
    return view;
}
