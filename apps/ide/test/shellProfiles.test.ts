import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    GIT_FOR_WINDOWS_KEY,
    customProfileName,
    detectProfiles,
    isValidArgs,
    parseCustomProfiles,
    profileList,
    resolveDefaultProfile,
    splitArgs,
    type ProfileDetectionDeps,
} from '../src/main/terminal/shellProfiles.ts';

/** A fake machine: the files that exist (compared case-insensitively on Windows, like NTFS), its environment and registry. */
function machine(platform: string, files: readonly string[], env: Record<string, string | undefined> = {}, registry: Record<string, string> = {}): ProfileDetectionDeps {
    const norm = (p: string): string => (platform === 'win32' ? p.toLowerCase() : p);
    const set = new Set(files.map(norm));
    return {
        platform,
        env,
        exists: (file) => Promise.resolve(set.has(norm(file))),
        readRegistry: (key, value) => Promise.resolve(registry[`${key}\\${value}`]),
    };
}

const WIN_ENV = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local',
    SystemRoot: 'C:\\Windows',
};
const WIN_BASE = [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\System32\\cmd.exe',
];
const ids = async (deps: ProfileDetectionDeps): Promise<string[]> => (await detectProfiles(deps)).map((p) => p.id);

describe('detectProfiles on Windows', () => {
    it('puts Git Bash first when Git is installed in Program Files, started as a login shell', async () => {
        const profiles = await detectProfiles(machine('win32', [...WIN_BASE, 'C:\\Program Files\\Git\\bin\\bash.exe'], WIN_ENV));
        assert.deepEqual(profiles.map((p) => p.id), ['git-bash', 'powershell', 'cmd']);
        assert.equal(profiles[0]?.path, 'C:\\Program Files\\Git\\bin\\bash.exe');
        assert.deepEqual(profiles[0]?.args, ['--login', '-i']);
        assert.equal(profiles[0]?.name, 'Git Bash');
    });

    it('prefers the install folder recorded in the registry', async () => {
        const deps = machine('win32', [...WIN_BASE, 'D:\\Tools\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'], WIN_ENV,
            { [`${GIT_FOR_WINDOWS_KEY}\\InstallPath`]: 'D:\\Tools\\Git' });
        assert.equal((await detectProfiles(deps))[0]?.path, 'D:\\Tools\\Git\\bin\\bash.exe');
    });

    it('ignores a registry value that is not an absolute path, or a registry that throws', async () => {
        const relative = machine('win32', [...WIN_BASE, 'C:\\Program Files\\Git\\bin\\bash.exe'], WIN_ENV, { [`${GIT_FOR_WINDOWS_KEY}\\InstallPath`]: 'Git' });
        assert.equal((await detectProfiles(relative))[0]?.path, 'C:\\Program Files\\Git\\bin\\bash.exe');
        const throwing = { ...relative, readRegistry: () => Promise.reject(new Error('denied')) };
        assert.equal((await detectProfiles(throwing))[0]?.id, 'git-bash');
    });

    it('finds Git Bash under Program Files (x86) and in a per-user install', async () => {
        assert.equal((await detectProfiles(machine('win32', [...WIN_BASE, 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'], WIN_ENV)))[0]?.id, 'git-bash');
        const user = 'C:\\Users\\ada\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
        assert.equal((await detectProfiles(machine('win32', [...WIN_BASE, user], WIN_ENV)))[0]?.path, user);
    });

    it('reads environment variables case-insensitively and falls back to the usual folders', async () => {
        const env = { PROGRAMFILES: 'E:\\Apps', SYSTEMROOT: 'C:\\WINDOWS' };
        assert.deepEqual(await ids(machine('win32', ['E:\\Apps\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\cmd.exe'], env)), ['git-bash', 'cmd']);
        assert.deepEqual(await ids(machine('win32', ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\cmd.exe'], {})), ['git-bash', 'cmd']);
    });

    it('without Git, PowerShell 7 comes first, then Windows PowerShell, then cmd', async () => {
        assert.deepEqual(await ids(machine('win32', WIN_BASE, WIN_ENV)), ['powershell', 'cmd']);
        assert.deepEqual(await ids(machine('win32', [...WIN_BASE, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'], WIN_ENV)), ['pwsh', 'powershell', 'cmd']);
        const store = 'C:\\Users\\ada\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';
        assert.equal((await detectProfiles(machine('win32', [...WIN_BASE, store], WIN_ENV)))[0]?.path, store);
    });

    it('falls back to cmd alone, from ComSpec when it is set', async () => {
        const profiles = await detectProfiles(machine('win32', ['D:\\Win\\cmd.exe'], { ...WIN_ENV, ComSpec: 'D:\\Win\\cmd.exe' }));
        assert.deepEqual(profiles.map((p) => [p.id, p.path]), [['cmd', 'D:\\Win\\cmd.exe']]);
    });

    it('lists WSL last when wsl.exe exists', async () => {
        assert.deepEqual(await ids(machine('win32', [...WIN_BASE, 'C:\\Windows\\System32\\wsl.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'], WIN_ENV)),
            ['git-bash', 'powershell', 'cmd', 'wsl']);
    });

    it('lists nothing on a machine with no shell at all', async () => {
        assert.deepEqual(await ids(machine('win32', [], WIN_ENV)), []);
    });
});

describe('detectProfiles on macOS and Linux', () => {
    it('starts with $SHELL, then /bin/bash and /bin/sh', async () => {
        const profiles = await detectProfiles(machine('linux', ['/usr/bin/zsh', '/bin/bash', '/bin/sh'], { SHELL: '/usr/bin/zsh' }));
        assert.deepEqual(profiles.map((p) => [p.id, p.path]), [['zsh', '/usr/bin/zsh'], ['bash', '/bin/bash'], ['sh', '/bin/sh']]);
        assert.deepEqual(profiles[0]?.args, []);
    });

    it('starts login shells on macOS', async () => {
        const profiles = await detectProfiles(machine('darwin', ['/bin/zsh', '/bin/bash', '/bin/sh'], { SHELL: '/bin/zsh' }));
        assert.equal(profiles[0]?.id, 'zsh');
        assert.ok(profiles.every((p) => p.args.join(' ') === '-l'));
    });

    it('does not list the same shell twice', async () => {
        assert.deepEqual(await ids(machine('linux', ['/bin/bash', '/bin/sh'], { SHELL: '/bin/bash' })), ['bash', 'sh']);
        // A second bash elsewhere keeps the $SHELL one: ids stay unique and stable.
        assert.deepEqual(await ids(machine('darwin', ['/opt/homebrew/bin/bash', '/bin/bash', '/bin/sh'], { SHELL: '/opt/homebrew/bin/bash' })), ['bash', 'sh']);
    });

    it('skips a $SHELL that is missing, relative or unset', async () => {
        assert.deepEqual(await ids(machine('linux', ['/bin/bash', '/bin/sh'], { SHELL: '/usr/bin/fish' })), ['bash', 'sh']);
        assert.deepEqual(await ids(machine('linux', ['/bin/sh', 'fish'], { SHELL: 'fish' })), ['sh']);
        assert.deepEqual(await ids(machine('linux', ['/bin/sh'], {})), ['sh']);
    });
});

describe('resolveDefaultProfile', () => {
    const profiles = [
        { id: 'git-bash', name: 'Git Bash', path: 'a', args: [], source: 'detected' as const },
        { id: 'cmd', name: 'Command Prompt', path: 'b', args: [], source: 'detected' as const },
    ];
    it('keeps a saved choice that still exists, else takes the first profile', () => {
        assert.equal(resolveDefaultProfile(profiles, 'cmd'), 'cmd');
        assert.equal(resolveDefaultProfile(profiles, 'pwsh'), 'git-bash');
        assert.equal(resolveDefaultProfile(profiles, 42), 'git-bash');
        assert.equal(resolveDefaultProfile([], 'cmd'), null);
    });

    it('puts custom profiles after the detected ones', () => {
        const custom = { id: 'custom-1', name: 'fish', path: '/usr/bin/fish', args: [], source: 'custom' as const };
        const list = profileList(profiles, [custom], 'custom-1');
        assert.deepEqual(list.profiles.map((p) => p.id), ['git-bash', 'cmd', 'custom-1']);
        assert.equal(list.defaultProfileId, 'custom-1');
    });
});

describe('splitArgs', () => {
    it('splits on whitespace and groups quotes, without expanding anything', () => {
        assert.deepEqual(splitArgs(''), []);
        assert.deepEqual(splitArgs('  --login   -i '), ['--login', '-i']);
        assert.deepEqual(splitArgs('-c "echo $HOME" \'a b\' ""'), ['-c', 'echo $HOME', 'a b', '']);
        assert.deepEqual(splitArgs('--name="x y"z'), ['--name=x yz']);
    });

    it('refuses an unbalanced quote, NUL and too many arguments', () => {
        assert.throws(() => splitArgs('"open'), /Unbalanced/);
        assert.throws(() => splitArgs('a\0b'), /NUL/);
        assert.throws(() => splitArgs(Array.from({ length: 40 }, () => 'x').join(' ')), /At most/);
    });

    it('isValidArgs accepts only short string lists', () => {
        assert.equal(isValidArgs(['-l']), true);
        assert.equal(isValidArgs('-l'), false);
        assert.equal(isValidArgs([1]), false);
        assert.equal(isValidArgs(['x'.repeat(2000)]), false);
    });
});

describe('parseCustomProfiles', () => {
    it('keeps well-formed entries and drops everything else', () => {
        const data = [
            { id: 'custom-1', name: 'fish', path: '/usr/bin/fish', args: ['-l'] },
            { id: 'custom-1', name: 'duplicate', path: '/usr/bin/fish', args: [] },
            { id: 'git-bash', name: 'not custom', path: '/bin/bash', args: [] },
            { id: 'custom-2', name: 'relative', path: 'bin/fish', args: [] },
            { id: 'custom-3', name: 'bad args', path: '/bin/sh', args: 'x' },
            { id: 'custom-4', name: '', path: '/bin/sh', args: [] },
            null,
            'string',
        ];
        const profiles = parseCustomProfiles(data, 'linux');
        assert.deepEqual(profiles, [{ id: 'custom-1', name: 'fish', path: '/usr/bin/fish', args: ['-l'], source: 'custom' }]);
        assert.deepEqual(parseCustomProfiles({ not: 'a list' }, 'linux'), []);
    });

    it('judges absolute paths by the target OS', () => {
        const entry = { id: 'custom-a', name: 'nu', path: 'C:\\Tools\\nu.exe', args: [] };
        assert.equal(parseCustomProfiles([entry], 'win32').length, 1);
        assert.equal(parseCustomProfiles([entry], 'linux').length, 0);
    });

    it('names a custom profile after its executable', () => {
        assert.equal(customProfileName('C:\\Tools\\nu.exe', 'win32'), 'nu');
        assert.equal(customProfileName('/usr/local/bin/fish', 'darwin'), 'fish');
    });
});
