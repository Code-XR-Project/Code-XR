import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';
import { memoryStore, ProfileRegistry } from '../src/main/terminal/profileRegistry.ts';
import { MAX_TERMINALS_PER_WINDOW, TerminalService, terminalEnvironment, type PtyProcess, type SpawnOptions, type TerminalOwner } from '../src/main/terminal/terminalService.ts';
import type { TerminalDataEvent, TerminalExitEvent, TerminalProfile } from '../src/shared/api.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-terminal-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const linux = (files: readonly string[], shell = '/bin/bash') => ({
    platform: 'linux',
    env: { SHELL: shell },
    exists: (file: string) => Promise.resolve(files.includes(file)),
});

describe('ProfileRegistry', () => {
    it('defaults to the first detected shell and persists a new default across restarts', async () => {
        const file = path.join(base, 'settings', 'terminal-settings.json');
        const detection = linux(['/bin/bash', '/bin/sh']);
        const registry = new ProfileRegistry(new JsonKeyValueStore(file), detection);
        assert.equal((await registry.list()).defaultProfileId, 'bash');
        assert.equal((await registry.setDefault('sh')).defaultProfileId, 'sh');
        const restarted = new ProfileRegistry(new JsonKeyValueStore(file), detection);
        assert.equal((await restarted.list()).defaultProfileId, 'sh');
        assert.equal((await restarted.resolve(null)).path, '/bin/sh');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { defaultProfile: 'sh' });
    });

    it('falls back to the first profile when the saved default is gone', async () => {
        const store = memoryStore();
        await store.update('defaultProfile', 'zsh');
        const registry = new ProfileRegistry(store, linux(['/bin/bash']));
        assert.equal((await registry.list()).defaultProfileId, 'bash');
    });

    it('resolves only listed profile ids', async () => {
        const registry = new ProfileRegistry(memoryStore(), linux(['/bin/bash']));
        assert.equal((await registry.resolve('bash')).path, '/bin/bash');
        await assert.rejects(registry.resolve('/usr/bin/python3'), /Unknown terminal profile/);
        await assert.rejects(registry.resolve({ path: '/bin/sh' }), /Unknown terminal profile/);
        await assert.rejects(registry.setDefault('/bin/sh'), /Unknown terminal profile/);
        await assert.rejects(new ProfileRegistry(memoryStore(), linux([])).resolve(null), /No shell/);
    });

    it('adds, defaults to and removes a custom profile', async () => {
        const registry = new ProfileRegistry(memoryStore(), linux(['/bin/bash']));
        const added = await registry.addCustom('/usr/bin/fish', ['-l']);
        const custom = added.profiles.find((p) => p.source === 'custom');
        assert.ok(custom);
        assert.match(custom.id, /^custom-/);
        assert.equal(custom.name, 'fish');
        assert.deepEqual(custom.args, ['-l']);
        await registry.setDefault(custom.id);
        assert.equal((await registry.resolve(null)).path, '/usr/bin/fish');
        const removed = await registry.removeCustom(custom.id);
        assert.equal(removed.profiles.length, 1);
        assert.equal(removed.defaultProfileId, 'bash');
        await assert.rejects(registry.removeCustom('bash'), /Unknown custom profile/);
    });
});

class FakePty implements PtyProcess {
    readonly pid = 4242;
    readonly written: string[] = [];
    readonly sizes: Array<[number, number]> = [];
    killed = 0;
    private dataListener: ((data: string) => void) | undefined;
    private exitListener: ((event: { exitCode: number }) => void) | undefined;
    readonly file: string;
    readonly args: readonly string[];
    readonly options: SpawnOptions;

    constructor(file: string, args: readonly string[], options: SpawnOptions) {
        this.file = file;
        this.args = args;
        this.options = options;
    }

    onData(listener: (data: string) => void): void { this.dataListener = listener; }
    onExit(listener: (event: { exitCode: number }) => void): void { this.exitListener = listener; }
    write(data: string): void { this.written.push(data); }
    resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
    kill(): void { this.killed++; }
    emit(data: string): void { this.dataListener?.(data); }
    exit(exitCode: number): void { this.exitListener?.({ exitCode }); }
}

class FakeOwner implements TerminalOwner {
    readonly id: number;
    readonly events: Array<[string, TerminalDataEvent | TerminalExitEvent]> = [];
    destroyed = false;
    constructor(id: number) { this.id = id; }
    send(channel: string, payload: TerminalDataEvent | TerminalExitEvent): void { this.events.push([channel, payload]); }
    isDestroyed(): boolean { return this.destroyed; }
}

const BASH: TerminalProfile = { id: 'bash', name: 'bash', path: '/bin/bash', args: ['-l'], source: 'detected' };

function service(): { service: TerminalService; ptys: FakePty[] } {
    const ptys: FakePty[] = [];
    return {
        ptys,
        service: new TerminalService({
            spawn: (file, args, options) => {
                const pty = new FakePty(file, args, options);
                ptys.push(pty);
                return pty;
            },
            resolveProfile: (id) => (id === null || id === 'bash' ? Promise.resolve(BASH) : Promise.reject(new Error('Unknown terminal profile.'))),
            env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' },
            dataChannel: 'data',
            exitChannel: 'exit',
            flushDelayMs: 0,
        }),
    };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('TerminalService', () => {
    it('spawns the resolved profile in the given folder, with a terminal environment', async () => {
        const { service: terminals, ptys } = service();
        const created = await terminals.create(new FakeOwner(1), null, 80, 24, '/work');
        assert.equal(created.profile.id, 'bash');
        assert.equal(created.cwd, '/work');
        const [pty] = ptys;
        assert.ok(pty);
        assert.equal(pty.file, '/bin/bash');
        assert.deepEqual(pty.args, ['-l']);
        assert.equal(pty.options.cwd, '/work');
        assert.equal(pty.options.env['TERM'], 'xterm-256color');
        assert.equal(pty.options.env['PATH'], '/usr/bin');
        assert.equal(pty.options.env['ELECTRON_RUN_AS_NODE'], undefined);
        assert.equal(pty.options.env['NODE_OPTIONS'], undefined);
    });

    it('refuses unknown profiles and bad sizes before spawning anything', async () => {
        const { service: terminals, ptys } = service();
        const owner = new FakeOwner(1);
        await assert.rejects(terminals.create(owner, '/bin/sh', 80, 24, '/'), /Unknown terminal profile/);
        await assert.rejects(terminals.create(owner, null, 0, 24, '/'), /Invalid terminal size/);
        await assert.rejects(terminals.create(owner, null, 80.5, 24, '/'), /Invalid terminal size/);
        await assert.rejects(terminals.create(owner, null, '80', 24, '/'), /Invalid terminal size/);
        assert.equal(ptys.length, 0);
    });

    it('forwards input, resize and output, batched, to the owning window only', async () => {
        const { service: terminals, ptys } = service();
        const owner = new FakeOwner(1);
        const other = new FakeOwner(2);
        const { id } = await terminals.create(owner, 'bash', 80, 24, '/');
        const pty = ptys[0]!;
        terminals.input(owner, id, 'ls\r');
        terminals.resize(owner, id, 120, 30);
        assert.deepEqual(pty.written, ['ls\r']);
        assert.deepEqual(pty.sizes, [[120, 30]]);
        pty.emit('a');
        pty.emit('b');
        await tick();
        assert.deepEqual(owner.events, [['data', { id, data: 'ab' }]]);
        assert.throws(() => terminals.input(other, id, 'rm -rf /\r'), /Unknown terminal/);
        assert.throws(() => terminals.resize(other, id, 10, 10), /Unknown terminal/);
        terminals.kill(other, id);
        assert.equal(pty.killed, 0);
        assert.equal(other.events.length, 0);
        assert.throws(() => terminals.input(owner, id, 42), /Invalid terminal input/);
        assert.throws(() => terminals.input(owner, 999, 'x'), /Unknown terminal/);
    });

    it('reports the exit code and forgets the terminal', async () => {
        const { service: terminals, ptys } = service();
        const owner = new FakeOwner(1);
        const { id } = await terminals.create(owner, null, 80, 24, '/');
        ptys[0]!.emit('bye');
        ptys[0]!.exit(3);
        assert.deepEqual(owner.events, [['data', { id, data: 'bye' }], ['exit', { id, exitCode: 3 }]]);
        assert.equal(terminals.size, 0);
        assert.throws(() => terminals.input(owner, id, 'x'), /Unknown terminal/);
    });

    it('kills the terminals of a closed window, and every terminal on quit', async () => {
        const { service: terminals, ptys } = service();
        const first = new FakeOwner(1);
        const second = new FakeOwner(2);
        await terminals.create(first, null, 80, 24, '/');
        await terminals.create(first, null, 80, 24, '/');
        await terminals.create(second, null, 80, 24, '/');
        terminals.killOwnedBy(1);
        assert.deepEqual(ptys.map((p) => p.killed), [1, 1, 0]);
        assert.equal(terminals.size, 1);
        terminals.killAll();
        assert.deepEqual(ptys.map((p) => p.killed), [1, 1, 1]);
        assert.equal(terminals.size, 0);
        // A pty that exits after being killed is not killed twice and reaches no closed window.
        first.destroyed = true;
        ptys[0]!.exit(0);
        assert.equal(first.events.length, 0);
    });

    it('lets a quit wait for the shells to go, but not forever', async () => {
        const { service: terminals, ptys } = service();
        const owner = new FakeOwner(1);
        await terminals.create(owner, null, 80, 24, '/');
        await terminals.create(owner, null, 80, 24, '/');
        let settled = false;
        const quitting = terminals.killAll(60_000).then(() => {
            settled = true;
        });
        ptys[0]!.exit(0);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false, 'one shell is still going');
        ptys[1]!.exit(0);
        await quitting;
        await terminals.create(owner, null, 80, 24, '/');
        const started = Date.now();
        await terminals.killAll(50);
        assert.ok(Date.now() - started < 5000, 'a shell that never exits does not hold the quit');
    });

    it('caps the terminals per window', async () => {
        const { service: terminals } = service();
        const owner = new FakeOwner(1);
        for (let i = 0; i < MAX_TERMINALS_PER_WINDOW; i++) {
            await terminals.create(owner, null, 80, 24, '/');
        }
        await assert.rejects(terminals.create(owner, null, 80, 24, '/'), /At most/);
        await terminals.create(new FakeOwner(2), null, 80, 24, '/');
    });
});

describe('terminalEnvironment', () => {
    it('drops the IDE process switches and announces the terminal', () => {
        const env = terminalEnvironment({ HOME: '/home/ada', Electron_Run_As_Node: '1', CODEXR_IDE_DEV_SERVER_URL: 'http://x', EMPTY: undefined });
        assert.deepEqual(env, { HOME: '/home/ada', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'codexr' });
    });
});
