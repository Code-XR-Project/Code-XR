import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    currentFileConfiguration, DapMessageReader, debugTypeOf, encodeDapMessage, LAUNCH_TEMPLATE, parseLaunchJson, substituteVariables,
    type DebugEvent, type LaunchVariables,
} from '../src/shared/debug.ts';
import { DapClient, type DapTransport } from '../src/main/debug/dapClient.ts';
import { DebugSession, type DebugAdapter } from '../src/main/debug/debugSession.ts';
import { breakpointUrlRegex, formatRemoteObject, inspectorAddress, scriptPath, startNodeAdapter, withoutInspectorNoise } from '../src/main/debug/nodeAdapter.ts';

describe('Launch configurations (#180)', () => {
    it('reads .codexr/launch.json with comments, aliases and defaults', () => {
        const { configurations, errors } = parseLaunchJson(`{
            // a comment
            "configurations": [
                { "name": "App", "type": "debugpy", "request": "launch", "program": "\${workspaceFolder}/app.py", "args": ["-v", 3], "justMyCode": false, "python": "/opt/py/bin/python", },
                { "name": "Server", "type": "pwa-node", "program": "server.js", "cwd": "web", "env": { "PORT": "8080", "BAD": 1 }, "stopOnEntry": true },
            ],
        }`);
        assert.deepEqual(errors, []);
        assert.equal(configurations.length, 2);
        assert.deepEqual(configurations[0], {
            name: 'App', type: 'python', request: 'launch', program: '${workspaceFolder}/app.py', args: ['-v'], cwd: null, env: {},
            stopOnEntry: false, justMyCode: false, runtime: '/opt/py/bin/python',
        });
        assert.equal(configurations[1]?.type, 'node');
        assert.equal(configurations[1]?.cwd, 'web');
        assert.deepEqual(configurations[1]?.env, { PORT: '8080' });
        assert.equal(configurations[1]?.stopOnEntry, true);
        assert.equal(configurations[1]?.runtime, null);
    });

    it('reports what it cannot use and keeps the rest', () => {
        const { configurations, errors } = parseLaunchJson(JSON.stringify({
            configurations: [
                { name: 'Go', type: 'go', program: 'main.go' },
                { name: 'Attach', type: 'python', request: 'attach', program: 'x.py' },
                { name: 'No program', type: 'python' },
                { name: 'Ok', type: 'python', program: 'a.py' },
                { name: 'Ok', type: 'node', program: 'b.js' },
                'not an object',
            ],
        }));
        assert.deepEqual(configurations.map((configuration) => configuration.name), ['Ok']);
        assert.equal(errors.length, 4);
        assert.match(errors[0] ?? '', /cannot debug \(go\)/);
        assert.match(errors[1] ?? '', /only "launch"/);
        assert.match(errors[2] ?? '', /needs a "name" and a "program"/);
        assert.match(errors[3] ?? '', /two configurations are called "Ok"/);
        assert.deepEqual(parseLaunchJson('{ nope').errors, ['.codexr/launch.json is not valid JSON.']);
        assert.match(parseLaunchJson('{}').errors[0] ?? '', /no "configurations"/);
    });

    it('ships a template it can read itself', () => {
        const { configurations, errors } = parseLaunchJson(LAUNCH_TEMPLATE);
        assert.deepEqual(errors, []);
        assert.deepEqual(configurations.map((configuration) => configuration.type), ['python', 'node']);
    });

    it('picks the debugger of a file by its extension', () => {
        assert.equal(debugTypeOf('src/app.py'), 'python');
        assert.equal(debugTypeOf('tool.PYW'), 'python');
        for (const file of ['a.js', 'a.mjs', 'a.cjs', 'a.ts', 'a.mts', 'a.cts']) {
            assert.equal(debugTypeOf(file), 'node', file);
        }
        assert.equal(debugTypeOf('README.md'), null);
        assert.equal(debugTypeOf('Makefile'), null);
        assert.equal(currentFileConfiguration('python').program, '${file}');
    });

    it('fills the variables, and refuses unknown ones or a missing file', () => {
        const posix: LaunchVariables = { workspaceFolder: '/w/proj', file: '/w/proj/src/app.test.py', relativeFile: 'src/app.test.py', env: { HOME: '/home/a' }, separator: '/' };
        assert.equal(substituteVariables('${workspaceFolder}/x', posix), '/w/proj/x');
        assert.equal(substituteVariables('${file}', posix), '/w/proj/src/app.test.py');
        assert.equal(substituteVariables('${relativeFile}', posix), 'src/app.test.py');
        assert.equal(substituteVariables('${fileBasename}|${fileBasenameNoExtension}|${fileExtname}', posix), 'app.test.py|app.test|.py');
        assert.equal(substituteVariables('${fileDirname}', posix), '/w/proj/src');
        assert.equal(substituteVariables('${workspaceFolderBasename}', posix), 'proj');
        assert.equal(substituteVariables('${env:HOME}:${env:MISSING}', posix), '/home/a:');
        assert.throws(() => substituteVariables('${command:pickProcess}', posix), /Unknown variable/);
        assert.throws(() => substituteVariables('${file}', { ...posix, file: null, relativeFile: null }), /needs an open file/);
        const windows: LaunchVariables = { workspaceFolder: 'C:\\w\\proj', file: 'C:\\w\\proj\\src\\a.py', relativeFile: 'src/a.py', env: {}, separator: '\\' };
        assert.equal(substituteVariables('${relativeFile}', windows), 'src\\a.py');
        assert.equal(substituteVariables('${fileDirname}', windows), 'C:\\w\\proj\\src');
    });
});

describe('DAP framing (#180)', () => {
    it('reads messages split anywhere, including inside a UTF-8 character', () => {
        const first = encodeDapMessage({ seq: 1, type: 'event', event: 'output', body: { output: 'caf\u00e9 \u4e16\u754c\n' } });
        const second = encodeDapMessage({ seq: 2, type: 'response', request_seq: 1, success: true, command: 'initialize' });
        const all = new Uint8Array([...first, ...second]);
        for (let cut = 1; cut < all.length; cut += 7) {
            const reader = new DapMessageReader();
            const messages = [...reader.push(all.subarray(0, cut)), ...reader.push(all.subarray(cut))];
            assert.equal(messages.length, 2);
            assert.equal((messages[0]?.body as { output: string }).output, 'caf\u00e9 \u4e16\u754c\n');
            assert.equal(messages[1]?.command, 'initialize');
        }
    });

    it('rejects a header without a length and a body that is not DAP', () => {
        assert.throws(() => new DapMessageReader().push(new TextEncoder().encode('X-Thing: 1\r\n\r\n{}')), /without Content-Length/);
        assert.throws(() => new DapMessageReader().push(encodeDapMessage({ hello: 1 })), /not DAP/);
    });
});

/** Two ends of a pipe: what one writes, the other reads. */
function pipe(): { client: DapTransport; adapter: { send(message: object): void; received: unknown[]; close(): void; onMessage: ((message: Record<string, unknown>) => void) | undefined } } {
    let toClient: ((chunk: Uint8Array) => void) | null = null;
    let closed: (() => void) | null = null;
    const reader = new DapMessageReader();
    const adapter = {
        received: [] as unknown[],
        send(message: object): void { toClient?.(encodeDapMessage(message)); },
        close(): void { closed?.(); },
        onMessage: undefined as ((message: Record<string, unknown>) => void) | undefined,
    };
    return {
        adapter,
        client: {
            write: (bytes) => {
                for (const message of reader.push(bytes)) {
                    adapter.received.push(message);
                    adapter.onMessage?.(message as unknown as Record<string, unknown>);
                }
            },
            onData: (listener) => { toClient = listener; },
            onClose: (listener) => { closed = listener; },
        },
    };
}

describe('DAP client (#180)', () => {
    it('matches responses to requests, formats errors and answers the adapter\'s requests', async () => {
        const { client, adapter } = pipe();
        const events: string[] = [];
        const dap = new DapClient(client, {
            onEvent: (event) => events.push(event),
            onReverseRequest: (command) => Promise.reject(new Error(`no ${command}`)),
            onClosed: () => events.push('closed'),
        });
        adapter.onMessage = (message) => {
            if (message['command'] === 'threads') {
                adapter.send({ seq: 10, type: 'response', request_seq: message['seq'], success: true, command: 'threads', body: { threads: [{ id: 1 }] } });
            } else if (message['command'] === 'launch') {
                adapter.send({ seq: 11, type: 'response', request_seq: message['seq'], success: false, command: 'launch', body: { error: { format: 'No file {path}', variables: { path: '/x.py' } } } });
            }
        };
        assert.deepEqual(await dap.request('threads'), { threads: [{ id: 1 }] });
        await assert.rejects(dap.request('launch', {}), /No file \/x\.py/);
        adapter.send({ seq: 12, type: 'event', event: 'stopped', body: { threadId: 1 } });
        adapter.send({ seq: 13, type: 'request', command: 'runInTerminal', arguments: {} });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(events, ['stopped']);
        const answer = adapter.received.at(-1) as { type: string; success: boolean; message: string; request_seq: number };
        assert.equal(answer.type, 'response');
        assert.equal(answer.success, false);
        assert.equal(answer.request_seq, 13);
        assert.match(answer.message, /no runInTerminal/);
        const pending = dap.request('next', { threadId: 1 });
        adapter.close();
        await assert.rejects(pending, /has ended/);
        assert.deepEqual(events, ['stopped', 'closed']);
        await assert.rejects(dap.request('threads'), /has ended/);
    });

    it('times out a request the adapter never answers', async () => {
        const { client } = pipe();
        const dap = new DapClient(client, { onEvent: () => undefined, onReverseRequest: () => Promise.resolve(undefined), onClosed: () => undefined });
        await assert.rejects(dap.request('evaluate', {}, 20), /did not answer "evaluate"/);
    });
});

describe('Node.js adapter helpers (#180)', () => {
    it('finds the inspector address and drops its messages from stderr', () => {
        const stderr = 'Debugger listening on ws://127.0.0.1:40123/0f5e-11\nFor help, see: https://nodejs.org/en/docs/inspector\n';
        assert.equal(inspectorAddress(stderr), 'ws://127.0.0.1:40123/0f5e-11');
        assert.equal(inspectorAddress('nothing'), null);
        assert.equal(withoutInspectorNoise(`${stderr}Debugger attached.\nreal error\nWaiting for the debugger to disconnect...\n`), 'real error\n');
    });

    it('matches a file by path or file URL, in any case on Windows', () => {
        const posix = new RegExp(breakpointUrlRegex('/home/a/my app/x.js', 'linux'));
        assert.ok(posix.test('/home/a/my app/x.js'));
        assert.ok(posix.test('file:///home/a/my%20app/x.js'));
        assert.ok(!posix.test('/home/a/my app/x.jsx'));
        assert.ok(!posix.test('/home/a/my app/y.js'));
        const windows = new RegExp(breakpointUrlRegex('C:\\Work\\app.js', 'win32'));
        assert.ok(windows.test('c:\\work\\APP.js'));
        assert.ok(windows.test('file:///C:/Work/app.js'));
        assert.ok(!windows.test('C:\\Work\\app.jsx'));
    });

    it('reads script URLs and formats values', () => {
        assert.equal(scriptPath('node:internal/main'), null);
        assert.equal(scriptPath('/a/b.js'), '/a/b.js');
        assert.equal(scriptPath(new URL('file:///a/b%20c.mjs').href), path.sep === '/' ? '/a/b c.mjs' : scriptPath(new URL('file:///a/b%20c.mjs').href));
        assert.equal(formatRemoteObject({ type: 'string', value: 'hi "you"' }), '"hi \\"you\\""');
        assert.equal(formatRemoteObject({ type: 'number', value: 3 }), '3');
        assert.equal(formatRemoteObject({ type: 'number', unserializableValue: 'NaN' }), 'NaN');
        assert.equal(formatRemoteObject({ type: 'bigint', unserializableValue: '10n' }), '10n');
        assert.equal(formatRemoteObject({ type: 'undefined' }), 'undefined');
        assert.equal(formatRemoteObject({ type: 'object', subtype: 'null', value: null }), 'null');
        assert.equal(formatRemoteObject({ type: 'object', className: 'Array', description: 'Array(3)' }), 'Array(3)');
        assert.equal(formatRemoteObject({ type: 'function', description: 'function total(list) {\n  return 1;\n}' }), 'function total(list)');
        assert.equal(formatRemoteObject({ type: 'string', value: 'x'.repeat(5000) }).length, 1000);
    });
});

/** Runs one program under the debugger: stops at line 5, steps, reads variables, continues to the end. */
async function debugRoundTrip(adapter: DebugAdapter, type: 'python' | 'node', program: string, launch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const root = path.dirname(program);
    const name = path.basename(program);
    const events: DebugEvent[] = [];
    let wake: (() => void) | null = null;
    const session = new DebugSession({
        id: 1, name: 'test', type, adapter, launchArguments: launch,
        breakpoints: new Map([[name, [5]]]),
        toAbsolute: (file) => path.join(root, file),
        toWorkspace: (absolute) => (path.dirname(absolute) === root ? path.basename(absolute) : null),
        emit: (event) => {
            events.push(event);
            if (event.kind === 'session' && event.session.state === 'stopped') {
                wake?.();
            }
        },
        log: () => undefined,
    });
    const stopped = (): Promise<void> => new Promise((resolve) => { wake = resolve; });
    let next = stopped();
    await session.start();
    await next;
    const thread = session.info().threadId ?? 0;
    const frames = await session.stackTrace(thread);
    const scopes = await session.scopes(frames[0]?.id ?? 0);
    // The innermost scope: Python's locals, the loop body's block in JavaScript.
    const locals = scopes[0];
    const variables = await session.variables(locals?.variablesReference ?? 0);
    const evaluated = await session.evaluate(type === 'python' ? 'total * 10' : 'total * 10', frames[0]?.id ?? null, 'watch');
    next = stopped();
    await session.step('next', null);
    await next;
    const afterStep = (await session.stackTrace(session.info().threadId ?? 0))[0]?.line;
    await session.setBreakpoints(name, []);
    const ended = new Promise<void>((resolve) => session.onEnded(resolve));
    await session.step('continue', null);
    await ended;
    return {
        top: { path: frames[0]?.path, line: frames[0]?.line, name: frames[0]?.name },
        variables: Object.fromEntries(variables.map((variable) => [variable.name, variable.value])),
        evaluated: evaluated.result,
        afterStep,
        output: events.flatMap((event) => (event.kind === 'output' ? [event.text] : [])).join(''),
        verified: events.some((event) => event.kind === 'breakpoints' && event.breakpoints.some((breakpoint) => breakpoint.verified)),
        ended: session.ended,
    };
}

describe('Debug sessions, end to end (#180)', () => {
    it('debugs a Node.js program through the IDE\'s own adapter', { timeout: 60_000 }, async () => {
        // The real path: macOS's temp folder is a symlink, and the debuggers report real paths.
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-debug-node-')));
        const program = path.join(dir, 'prog.js');
        fs.writeFileSync(program, 'function sum(list) {\n    let total = 0;\n    for (const item of list) {\n        const add = item;\n        total += add;\n    }\n    return total;\n}\nconsole.log("result", sum([1, 2, 3]));\n');
        try {
            const result = await debugRoundTrip(startNodeAdapter({ runtime: process.execPath, log: () => undefined }), 'node', program, {
                program, args: [], cwd: dir, env: {}, stopOnEntry: false,
            });
            assert.deepEqual(result['top'], { path: 'prog.js', line: 5, name: 'sum' });
            assert.equal((result['variables'] as Record<string, string>)['add'], '1');
            assert.equal(result['evaluated'], '0');
            assert.equal(result['afterStep'], 3);
            assert.equal(result['output'], 'result 6\n');
            assert.equal(result['verified'], true);
            assert.equal(result['ended'], true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    const python = process.platform === 'win32' ? 'python' : 'python3';
    let hasDebugpy = false;
    try {
        execFileSync(python, ['-c', 'import debugpy'], { stdio: 'ignore' });
        hasDebugpy = true;
    } catch {
        hasDebugpy = false;
    }
    it('debugs a Python program through debugpy', { skip: hasDebugpy ? false : 'debugpy is not installed for this Python', timeout: 60_000 }, async () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-debug-python-')));
        const program = path.join(dir, 'prog.py');
        fs.writeFileSync(program, 'def sum_all(values):\n    total = 0\n    for item in values:\n        add = item\n        total += add\n    return total\n\nprint("result", sum_all([1, 2, 3]))\n');
        const child = spawn(python, ['-m', 'debugpy.adapter'], { stdio: ['pipe', 'pipe', 'pipe'] });
        const adapter: DebugAdapter = {
            adapterId: 'python',
            transport: {
                write: (bytes) => { child.stdin.write(bytes); },
                onData: (listener) => { child.stdout.on('data', (chunk: Buffer) => listener(new Uint8Array(chunk))); },
                onClose: (listener) => { child.on('close', () => listener()); },
            },
            kill: () => { child.kill(); },
        };
        try {
            const result = await debugRoundTrip(adapter, 'python', program, {
                type: 'python', request: 'launch', program, args: [], cwd: dir, env: {}, console: 'internalConsole', redirectOutput: true, justMyCode: true, python: [python],
            });
            assert.deepEqual(result['top'], { path: 'prog.py', line: 5, name: 'sum_all' });
            assert.equal((result['variables'] as Record<string, string>)['add'], '1');
            assert.equal(result['evaluated'], '0');
            assert.equal(result['afterStep'], 3);
            assert.match(String(result['output']), /result 6/);
            assert.equal(result['ended'], true);
        } finally {
            child.kill();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
