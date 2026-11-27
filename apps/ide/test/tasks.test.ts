import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    findProgram, interpreterFor, makeTargets, makeTasks, matchersFor, npmTasks, packageManagerOf, shellCommand, shellKind,
    stripJsonComments, USER_TASKS_TEMPLATE, userTasks,
} from '../src/shared/tasks.ts';
import { matchProblems, workspacePath } from '../src/main/tasks/problemMatchers.ts';
import { TerminalService, type PtyProcess, type TerminalOwner } from '../src/main/terminal/terminalService.ts';
import { shellInvocation } from '../src/main/agents/tools/commandTool.ts';
import type { TerminalDataEvent, TerminalExitEvent, TerminalProfile } from '../src/shared/api.ts';

describe('Task detection (#176)', () => {
    it('lists package.json scripts with the folder\'s package manager, without lifecycle hooks', () => {
        const json = JSON.stringify({ scripts: { build: 'tsc -p .', prebuild: 'rimraf dist', lint: 'eslint src', test: 'node --test', 'postinstall-like': 'x', bad: 3 } });
        const tasks = npmTasks(json, 'npm', '/bin/bash');
        assert.deepEqual(tasks.map((task) => task.id), ['npm:build', 'npm:lint', 'npm:test', 'npm:postinstall-like']);
        assert.equal(tasks[0]?.command, 'npm run build');
        assert.deepEqual(tasks[0]?.problemMatchers, ['tsc']);
        assert.deepEqual(tasks[1]?.problemMatchers, ['eslint']);
        assert.deepEqual(tasks[2]?.problemMatchers, []);
        assert.equal(npmTasks(json, 'pnpm', '/bin/bash')[0]?.label, 'pnpm: build');
        assert.equal(npmTasks('{"scripts":{"a b":"x"}}', 'npm', '/bin/bash')[0]?.command, "npm run 'a b'");
        assert.deepEqual(npmTasks('{}', 'npm', '/bin/bash'), []);
        assert.throws(() => npmTasks('{', 'npm', '/bin/bash'), /not valid JSON/);
    });

    it('picks the package manager by lock file', () => {
        assert.equal(packageManagerOf(new Set(['package.json'])), 'npm');
        assert.equal(packageManagerOf(new Set(['pnpm-lock.yaml'])), 'pnpm');
        assert.equal(packageManagerOf(new Set(['yarn.lock'])), 'yarn');
        assert.equal(packageManagerOf(new Set(['bun.lock'])), 'bun');
    });

    it('finds the explicit targets of a Makefile', () => {
        const makefile = [
            'CC := gcc', 'VERSION = 1', '.PHONY: all clean', 'all: build', 'build test: deps', '\tgcc -o x x.c', '%.o: %.c', 'clean:', 'docs/site:', 'x ::= y', '# comment:',
        ].join('\n');
        assert.deepEqual(makeTargets(makefile), ['all', 'build', 'test', 'clean', 'docs/site']);
        assert.equal(makeTasks('all:\n', 'cmd.exe')[0]?.command, 'make all');
    });

    it('reads user tasks, with comments, trailing commas and named matchers', () => {
        const text = `{
            // the person's own
            "tasks": [
                { "label": "Typecheck", "command": "npx tsc --noEmit", },
                { "label": "Lint", "command": "npm run lint", "problemMatchers": ["eslint", "nope"] },
                { "label": "Quiet", "command": "npx tsc", "problemMatchers": [] },
                { "label": "Typecheck", "command": "duplicate" },
                { "label": "", "command": "no label" },
                { "label": "No command" },
                "junk",
            ],
        }`;
        const tasks = userTasks(text);
        assert.deepEqual(tasks.map((task) => [task.id, task.command, task.problemMatchers]), [
            ['user:Typecheck', 'npx tsc --noEmit', ['tsc']],
            ['user:Lint', 'npm run lint', ['eslint']],
            ['user:Quiet', 'npx tsc', []],
        ]);
        assert.deepEqual(userTasks(USER_TASKS_TEMPLATE).length, 1);
        assert.throws(() => userTasks('{ "tasks": [ }'), /not valid JSON/);
        assert.equal(stripJsonComments('{"a": "//not a comment", /* x */ "b": [1,],}'), '{"a": "//not a comment",  "b": [1]}');
    });

    it('attaches matchers by what a command runs', () => {
        assert.deepEqual(matchersFor('tsc -p tsconfig.json && eslint .'), ['tsc', 'eslint']);
        assert.deepEqual(matchersFor('node_modules/.bin/tsc'), ['tsc']);
        assert.deepEqual(matchersFor('vue-tsc --noEmit'), ['tsc']);
        assert.deepEqual(matchersFor('echo tscx; eslintrc'), []);
    });
});

describe('Run Current File (#176)', () => {
    it('chooses the interpreter by extension, with the configured ones first', () => {
        assert.deepEqual(interpreterFor('/p/a.py', 'linux', {}), { program: 'python3', args: [], setting: 'run.pythonInterpreter' });
        assert.equal(interpreterFor('C:\\p\\a.py', 'win32', {})?.program, 'python');
        assert.equal(interpreterFor('/p/a.py', 'darwin', { 'run.pythonInterpreter': ' /p/.venv/bin/python ' })?.program, '/p/.venv/bin/python');
        assert.equal(interpreterFor('/p/a.ts', 'linux', {})?.program, 'node');
        assert.equal(interpreterFor('/p/a.MJS', 'linux', { 'run.nodeInterpreter': 'bun' })?.program, 'bun');
        assert.deepEqual(interpreterFor('/p/main.go', 'linux', {}), { program: 'go', args: ['run'] });
        assert.equal(interpreterFor('/p/notes.txt', 'linux', {}), null);
        assert.equal(interpreterFor('/p/Makefile', 'linux', {}), null);
    });

    it('finds a program on PATH, with PATHEXT on Windows', async () => {
        const posix = new Set(['/usr/bin/python3', '/opt/py/bin/python']);
        const exists = (file: string): Promise<boolean> => Promise.resolve(posix.has(file) || windows.has(file));
        const windows = new Set(['C:\\Python\\python.EXE'.toLowerCase(), 'C:\\Python\\python.exe']);
        assert.equal(await findProgram('python3', { PATH: '/bin:/usr/bin' }, 'linux', exists), '/usr/bin/python3');
        assert.equal(await findProgram('/opt/py/bin/python', { PATH: '' }, 'linux', exists), '/opt/py/bin/python');
        assert.equal(await findProgram('ruby', { PATH: '/bin:/usr/bin' }, 'linux', exists), null);
        assert.equal(await findProgram('python', { Path: 'C:\\Windows;C:\\Python\\', PATHEXT: '.COM;.EXE' }, 'win32', exists), 'C:\\Python\\python.exe');
    });

    it('quotes a command line for the shell it runs in', () => {
        assert.equal(shellKind('/usr/bin/zsh'), 'posix');
        assert.equal(shellKind('C:\\Windows\\System32\\cmd.exe'), 'cmd');
        assert.equal(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'powershell');
        assert.equal(shellCommand('/bin/bash', ['/usr/bin/python3', "/p/it's here.py"]), `/usr/bin/python3 '/p/it'\\''s here.py'`);
        assert.equal(shellCommand('cmd.exe', ['C:\\Python\\python.exe', 'C:\\My Code\\a.py']), 'C:\\Python\\python.exe "C:\\My Code\\a.py"');
        assert.throws(() => shellCommand('cmd.exe', ['C:\\a%PATH%.py']), /safely/);
        assert.equal(shellCommand('pwsh', ['C:\\Program Files\\Python\\python.exe', "C:\\it's.py"]), "& 'C:\\Program Files\\Python\\python.exe' 'C:\\it''s.py'");
        assert.equal(shellCommand('pwsh', ['npm', 'run', 'build']), 'npm run build');
    });
});

describe('Problem matchers (#176)', () => {
    const root = '/work/proj';

    it('reads tsc output, plain and pretty, coloured or not', () => {
        const output = [
            'src/a.ts(3,7): error TS2322: Type \'string\' is not assignable to type \'number\'.',
            '\u001b[96msrc/b.ts\u001b[0m:\u001b[93m10\u001b[0m:\u001b[93m2\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name \'x\'.',
            '/elsewhere/c.ts(1,1): error TS1: outside',
            'Found 2 errors.',
        ].join('\r\n');
        const problems = matchProblems(output, ['tsc'], root, 'linux');
        assert.deepEqual(problems.map((p) => [p.path, p.startLine, p.startColumn, p.severity, p.code, p.source, p.origin]), [
            ['src/a.ts', 3, 7, 'error', 'TS2322', 'tsc', 'task'],
            ['src/b.ts', 10, 2, 'error', 'TS2304', 'tsc', 'task'],
        ]);
        assert.equal(problems[1]?.message, 'Cannot find name \'x\'.');
    });

    it('reads ESLint\'s stylish report', () => {
        const output = [
            '',
            '/work/proj/src/a.js',
            '   1:10  error    \'x\' is defined but never used  no-unused-vars',
            '  12:3   warning  Unexpected console statement    no-console',
            '',
            '/work/proj/src/b.js',
            '  4:1  error  Parsing error: Unexpected token',
            '',
            '✖ 3 problems (2 errors, 1 warning)',
        ].join('\n');
        const problems = matchProblems(output, ['eslint'], root, 'linux');
        assert.deepEqual(problems.map((p) => [p.path, p.startLine, p.startColumn, p.severity, p.code]), [
            ['src/a.js', 1, 10, 'error', 'no-unused-vars'],
            ['src/a.js', 12, 3, 'warning', 'no-console'],
            ['src/b.js', 4, 1, 'error', undefined],
        ]);
        assert.equal(problems[0]?.message, '\'x\' is defined but never used');
        assert.deepEqual(matchProblems(output, ['tsc'], root, 'linux'), [], 'only the named matchers run');
    });

    it('keeps paths inside the folder, on both path styles', () => {
        assert.equal(workspacePath('src\\a.ts', 'C:\\work', 'win32'), 'src/a.ts');
        assert.equal(workspacePath('C:\\work\\src\\a.ts', 'C:\\work', 'win32'), 'src/a.ts');
        assert.equal(workspacePath('D:\\x.ts', 'C:\\work', 'win32'), null);
        assert.equal(workspacePath('../x.ts', '/work', 'linux'), null);
        assert.equal(workspacePath('/work', '/work', 'linux'), null);
    });
});

describe('Task terminals (#176)', () => {
    class FakePty implements PtyProcess {
        readonly pid = 1;
        private data: ((data: string) => void) | undefined;
        private exitListener: ((event: { exitCode: number }) => void) | undefined;
        readonly file: string;
        readonly args: readonly string[];
        constructor(file: string, args: readonly string[]) {
            this.file = file;
            this.args = args;
        }
        onData(listener: (data: string) => void): void { this.data = listener; }
        onExit(listener: (event: { exitCode: number }) => void): void { this.exitListener = listener; }
        write(): void {}
        resize(): void {}
        kill(): void {}
        emit(data: string): void { this.data?.(data); }
        exit(exitCode: number): void { this.exitListener?.({ exitCode }); }
    }
    const owner: TerminalOwner & { events: Array<[string, TerminalDataEvent | TerminalExitEvent]> } = {
        id: 7,
        events: [],
        send(channel, payload) { this.events.push([channel, payload]); },
        isDestroyed: () => false,
    };
    const profile: TerminalProfile = { id: 'bash', name: 'bash', path: '/bin/bash', args: ['-l'], source: 'detected' };

    it('runs one command with the default shell and reports its output and exit code', async () => {
        const ptys: FakePty[] = [];
        const terminals = new TerminalService({
            spawn: (file, args) => {
                const pty = new FakePty(file, args);
                ptys.push(pty);
                return pty;
            },
            resolveProfile: () => Promise.resolve(profile),
            env: {},
            dataChannel: 'data',
            exitChannel: 'exit',
            flushDelayMs: 0,
        });
        const heard: string[] = [];
        let finished: [number, number] | null = null;
        const created = await terminals.createCommand(owner, 80, 24, '/work', (p) => shellInvocation(p.path, 'npm run build'), {
            onData: (data) => heard.push(data),
            onExit: (id, exitCode) => { finished = [id, exitCode]; },
        });
        const [pty] = ptys;
        assert.ok(pty);
        assert.deepEqual(pty.args, ['-c', 'npm run build'], 'the profile\'s own arguments are not used');
        pty.emit('ok\r\n');
        pty.exit(2);
        assert.deepEqual(heard, ['ok\r\n']);
        assert.deepEqual(finished, [created.id, 2]);
        assert.ok(owner.events.some(([channel, payload]) => channel === 'exit' && 'exitCode' in payload && payload.exitCode === 2));
        assert.equal(terminals.size, 0);
        await assert.rejects(terminals.createCommand(owner, 0, 24, '/work', () => [], {}), /Invalid terminal size/);
    });
});
