/**
 * #176: tasks. What a folder offers to run (its `package.json` scripts, its
 * Makefile targets and the person's own tasks in `.codexr/tasks.json`), how
 * each becomes a command line for the shell of the default terminal profile,
 * and what runs the file in the editor. Pure, unit-tested in Node; the main
 * process reads the files, checks the trust (#177) and starts the terminal.
 */
import type { Problem } from './problems.ts';
import type { TerminalCreated } from './api.ts';

export type TaskSource = 'npm' | 'make' | 'user';
/** The output parsers a task can feed the Problems panel with. */
export type ProblemMatcherName = 'tsc' | 'eslint';
export const PROBLEM_MATCHERS: readonly ProblemMatcherName[] = ['tsc', 'eslint'];

export interface TaskDefinition {
    /** `npm:build`, `make:test`, `user:Deploy`: stable while the file does not change. */
    readonly id: string;
    readonly label: string;
    readonly source: TaskSource;
    /** The command line the shell runs, in the open folder. */
    readonly command: string;
    readonly problemMatchers: readonly ProblemMatcherName[];
}

export interface TaskList {
    /** False in Restricted Mode (#177): the tasks are listed, none can run. */
    readonly trusted: boolean;
    readonly tasks: readonly TaskDefinition[];
    /** A file that exists but could not be read (bad JSON), for a notification. */
    readonly errors: readonly string[];
}

export interface TaskStarted extends TerminalCreated {
    readonly label: string;
    readonly command: string;
}

export interface TaskFinished {
    /** The terminal the task ran in. */
    readonly id: number;
    readonly label: string;
    readonly exitCode: number;
    /** What the task's problem matchers found; null when it has none (its last problems stay). */
    readonly problems: readonly Problem[] | null;
}

export interface TasksApi {
    list(): Promise<TaskList>;
    /** Runs a listed task in a new terminal of this size. Refused in Restricted Mode. */
    run(taskId: string, cols: number, rows: number): Promise<TaskStarted>;
    /** Runs a file of the folder with its interpreter (#176 "Run Current File"). Refused in Restricted Mode. */
    runFile(path: string, cols: number, rows: number): Promise<TaskStarted>;
    /** Creates `.codexr/tasks.json` with an example when it is missing; returns its workspace path. */
    configure(): Promise<string>;
    onFinished(listener: (event: TaskFinished) => void): () => void;
}

export const TASK_IPC_CHANNELS = {
    tasksList: 'codexr:tasks:list',
    tasksRun: 'codexr:tasks:run',
    tasksRunFile: 'codexr:tasks:run-file',
    tasksConfigure: 'codexr:tasks:configure',
} as const;

export const TASK_IPC_EVENTS = {
    tasksFinished: 'codexr:tasks:finished',
} as const;

export const USER_TASKS_PATH = '.codexr/tasks.json';
export const RESTRICTED_TASKS_MESSAGE = 'Tasks do not run in Restricted Mode: the folder is not trusted. Trust it to run its scripts.';
export const MAX_TASKS_PER_SOURCE = 200;
const MAX_COMMAND_LENGTH = 8000;

export const USER_TASKS_TEMPLATE = `${JSON.stringify({
    tasks: [
        { label: 'Example: list the folder', command: 'git status', problemMatchers: [] },
    ],
}, null, 4)}\n`;

// ---------------------------------------------------------------- detection

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** The package manager a folder uses, by its lock file. */
export function packageManagerOf(files: ReadonlySet<string>): PackageManager {
    if (files.has('pnpm-lock.yaml')) {
        return 'pnpm';
    }
    if (files.has('yarn.lock')) {
        return 'yarn';
    }
    if (files.has('bun.lockb') || files.has('bun.lock')) {
        return 'bun';
    }
    return 'npm';
}

/** The matchers a command line deserves by what it runs: `tsc` and `eslint`. */
export function matchersFor(command: string): ProblemMatcherName[] {
    const matchers: ProblemMatcherName[] = [];
    if (/(^|[\s/\\&|;(])tsc(\.cmd)?(\s|$)|\bvue-tsc\b/.test(command)) {
        matchers.push('tsc');
    }
    if (/(^|[\s/\\&|;(])eslint(\.cmd)?(\s|$)/.test(command)) {
        matchers.push('eslint');
    }
    return matchers;
}

/** The `scripts` of a package.json, as `<manager> run <name>`. Lifecycle hooks (`pre…`/`post…` of another script) are left out. */
export function npmTasks(packageJson: string, manager: PackageManager, shellPath: string): TaskDefinition[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(packageJson);
    } catch {
        throw new Error('package.json is not valid JSON.');
    }
    const scripts = isRecord(parsed) && isRecord(parsed['scripts']) ? parsed['scripts'] : {};
    const names = Object.keys(scripts).filter((name) => typeof scripts[name] === 'string');
    const tasks: TaskDefinition[] = [];
    for (const name of names) {
        const hook = /^(pre|post)(.+)$/.exec(name);
        if (hook?.[2] && names.includes(hook[2])) {
            continue;
        }
        const body = String(scripts[name]);
        tasks.push({
            id: `npm:${name}`,
            label: `${manager}: ${name}`,
            source: 'npm',
            command: shellCommand(shellPath, [manager, 'run', name]),
            problemMatchers: matchersFor(body),
        });
        if (tasks.length >= MAX_TASKS_PER_SOURCE) {
            break;
        }
    }
    return tasks;
}

/**
 * The explicit targets of a Makefile: `name:` at the start of a line, not a
 * variable (`:=`), a pattern (`%`) or a special target (`.PHONY`).
 */
export function makeTargets(makefile: string): string[] {
    const targets: string[] = [];
    for (const line of makefile.split(/\r?\n/)) {
        const match = /^([A-Za-z0-9_][A-Za-z0-9_.\/-]*(?:[ \t]+[A-Za-z0-9_][A-Za-z0-9_.\/-]*)*)[ \t]*:(?![=:])/.exec(line);
        if (!match?.[1]) {
            continue;
        }
        for (const name of match[1].split(/[ \t]+/)) {
            if (!targets.includes(name)) {
                targets.push(name);
            }
        }
        if (targets.length >= MAX_TASKS_PER_SOURCE) {
            break;
        }
    }
    return targets;
}

export function makeTasks(makefile: string, shellPath: string): TaskDefinition[] {
    return makeTargets(makefile).map((target) => ({
        id: `make:${target}`,
        label: `make: ${target}`,
        source: 'make',
        command: shellCommand(shellPath, ['make', target]),
        problemMatchers: [],
    }));
}

/**
 * `.codexr/tasks.json`: `{ "tasks": [{ "label": "...", "command": "...", "problemMatchers": ["tsc"] }] }`.
 * Comments and trailing commas are accepted, as in the settings file.
 * Entries without a label or a command are skipped.
 */
export function userTasks(text: string): TaskDefinition[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripJsonComments(text));
    } catch {
        throw new Error(`${USER_TASKS_PATH} is not valid JSON.`);
    }
    const list = isRecord(parsed) && Array.isArray(parsed['tasks']) ? parsed['tasks'] : [];
    const tasks: TaskDefinition[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
        if (!isRecord(entry)) {
            continue;
        }
        const label = typeof entry['label'] === 'string' ? entry['label'].trim().slice(0, 200) : '';
        const command = typeof entry['command'] === 'string' ? entry['command'].trim() : '';
        if (!label || !command || command.length > MAX_COMMAND_LENGTH || seen.has(label)) {
            continue;
        }
        seen.add(label);
        const named = Array.isArray(entry['problemMatchers']) ? entry['problemMatchers'] : null;
        const problemMatchers = named
            ? PROBLEM_MATCHERS.filter((matcher) => named.includes(matcher))
            : matchersFor(command);
        tasks.push({ id: `user:${label}`, label, source: 'user', command, problemMatchers });
        if (tasks.length >= MAX_TASKS_PER_SOURCE) {
            break;
        }
    }
    return tasks;
}

/** Line and block comments and trailing commas out, strings untouched. */
export function stripJsonComments(text: string): string {
    let result = '';
    let index = 0;
    while (index < text.length) {
        const char = text[index] ?? '';
        if (char === '"') {
            const end = endOfString(text, index);
            result += text.slice(index, end);
            index = end;
        } else if (char === '/' && text[index + 1] === '/') {
            while (index < text.length && text[index] !== '\n') { index += 1; }
        } else if (char === '/' && text[index + 1] === '*') {
            const end = text.indexOf('*/', index + 2);
            index = end === -1 ? text.length : end + 2;
        } else {
            result += char;
            index += 1;
        }
    }
    return result.replace(/,(\s*[}\]])/g, '$1');
}

function endOfString(text: string, start: number): number {
    let index = start + 1;
    while (index < text.length) {
        if (text[index] === '\\') {
            index += 2;
        } else if (text[index] === '"') {
            return index + 1;
        } else {
            index += 1;
        }
    }
    return text.length;
}

// ---------------------------------------------------------------- run the current file

export interface Interpreter {
    /** The executable: a name looked up on PATH, or a path. */
    readonly program: string;
    /** Arguments before the file (`run` for `go run`). */
    readonly args: readonly string[];
    /** The setting that names it, when there is one. */
    readonly setting?: string;
}

export const PYTHON_INTERPRETER_SETTING = 'run.pythonInterpreter';
export const NODE_INTERPRETER_SETTING = 'run.nodeInterpreter';

/** What runs a file, by its extension; null for a file nothing runs. */
export function interpreterFor(path: string, platform: string, configured: Readonly<Record<string, string>>): Interpreter | null {
    const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
    const own = (setting: string, fallback: string): Interpreter => {
        const value = configured[setting]?.trim();
        return { program: value || fallback, args: [], setting };
    };
    switch (extension) {
        case 'py':
        case 'pyw':
            return own(PYTHON_INTERPRETER_SETTING, platform === 'win32' ? 'python' : 'python3');
        case 'js':
        case 'mjs':
        case 'cjs':
        case 'ts':
        case 'mts':
        case 'cts':
            // Node runs TypeScript itself since 22.18 and 23.6 (types are stripped).
            return own(NODE_INTERPRETER_SETTING, 'node');
        case 'sh':
        case 'bash':
            return { program: 'bash', args: [] };
        case 'ps1':
            return { program: platform === 'win32' ? 'powershell' : 'pwsh', args: ['-NoProfile', '-File'] };
        case 'rb':
            return { program: 'ruby', args: [] };
        case 'pl':
            return { program: 'perl', args: [] };
        case 'php':
            return { program: 'php', args: [] };
        case 'lua':
            return { program: 'lua', args: [] };
        case 'r':
            return { program: 'Rscript', args: [] };
        case 'go':
            return { program: 'go', args: ['run'] };
        case 'java':
            // Single-file source launcher, Java 11+.
            return { program: 'java', args: [] };
        case 'dart':
            return { program: 'dart', args: ['run'] };
        case 'jl':
            return { program: 'julia', args: [] };
        default:
            return null;
    }
}

/**
 * Where `program` is: itself when it names a path, otherwise the first match
 * on PATH (with PATHEXT on Windows). `exists` is injected for the tests.
 */
export async function findProgram(
    program: string,
    env: Readonly<Record<string, string | undefined>>,
    platform: string,
    exists: (file: string) => Promise<boolean>,
): Promise<string | null> {
    const windows = platform === 'win32';
    const separator = windows ? '\\' : '/';
    const extensions = windows
        ? ['', ...(env['PATHEXT'] ?? env['Pathext'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase())]
        : [''];
    if (/[\\/]/.test(program)) {
        for (const ext of extensions) {
            if (await exists(program + ext)) {
                return program + ext;
            }
        }
        return null;
    }
    const pathValue = env['PATH'] ?? env['Path'] ?? '';
    for (const dir of pathValue.split(windows ? ';' : ':').filter(Boolean)) {
        for (const ext of windows && /\.[a-z0-9]+$/i.test(program) ? [''] : extensions) {
            const candidate = `${dir.replace(/[\\/]+$/, '')}${separator}${program}${ext}`;
            if (await exists(candidate)) {
                return candidate;
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------- shell quoting

/** The kind of shell a path names, for quoting. */
export function shellKind(shellPath: string): 'posix' | 'cmd' | 'powershell' {
    const name = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
    if (name === 'cmd') {
        return 'cmd';
    }
    if (name === 'pwsh' || name === 'powershell') {
        return 'powershell';
    }
    return 'posix';
}

/** One command line of `parts` for that shell, each part quoted when it needs it. */
export function shellCommand(shellPath: string, parts: readonly string[]): string {
    const kind = shellKind(shellPath);
    const plain = /^[A-Za-z0-9_@%+=:,./\\-]+$/;
    const quoted = parts.map((part) => {
        if (part !== '' && plain.test(part) && !(kind === 'cmd' && part.includes('%'))) {
            return part;
        }
        if (kind === 'posix') {
            return `'${part.replace(/'/g, `'\\''`)}'`;
        }
        if (kind === 'powershell') {
            return `'${part.replace(/'/g, "''")}'`;
        }
        // cmd has no escape for `%` or `"` inside quotes; neither can be in a Windows file name, so refuse rather than guess.
        if (/["%]/.test(part)) {
            throw new Error(`Cannot pass ${part} to cmd.exe safely.`);
        }
        return `"${part}"`;
    });
    // PowerShell runs a quoted program only with the call operator.
    return kind === 'powershell' && quoted[0]?.startsWith("'") ? `& ${quoted.join(' ')}` : quoted.join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
