import path from 'node:path';
import type { TerminalProfile, TerminalProfileList } from '../../shared/api.ts';

/**
 * Shell profiles for the terminal panel (#137): which shells exist on this
 * machine, in the order the default is picked from, plus the custom profiles
 * the person saved. Pure: the file system, the environment and the Windows
 * registry are injected, so every OS is tested on every OS.
 */

export interface ProfileDetectionDeps {
    readonly platform: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    exists(file: string): Promise<boolean>;
    /** Reads a registry value (Windows only); undefined when it is missing or unreadable. */
    readRegistry?(key: string, value: string): Promise<string | undefined>;
}

/** Where Git for Windows records its install folder. */
export const GIT_FOR_WINDOWS_KEY = 'HKLM\\SOFTWARE\\GitForWindows';

interface Candidate {
    readonly id: string;
    readonly name: string;
    readonly paths: readonly string[];
    readonly args: readonly string[];
}

/** Detected profiles, most preferred first. The first one is the default until the person picks another. */
export async function detectProfiles(deps: ProfileDetectionDeps): Promise<TerminalProfile[]> {
    const candidates = deps.platform === 'win32' ? await windowsCandidates(deps) : posixCandidates(deps);
    const profiles: TerminalProfile[] = [];
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    for (const candidate of candidates) {
        if (seenIds.has(candidate.id)) {
            continue;
        }
        for (const file of candidate.paths) {
            const key = deps.platform === 'win32' ? file.toLowerCase() : file;
            if (seenPaths.has(key) || !(await deps.exists(file))) {
                continue;
            }
            seenIds.add(candidate.id);
            seenPaths.add(key);
            profiles.push({ id: candidate.id, name: candidate.name, path: file, args: candidate.args, source: 'detected' });
            break;
        }
    }
    return profiles;
}

/** Windows environment variables are case-insensitive; a plain object in a test is not. */
function envValue(env: ProfileDetectionDeps['env'], name: string): string | undefined {
    const direct = env[name];
    if (direct) {
        return direct;
    }
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(env)) {
        if (key.toLowerCase() === lower && value) {
            return value;
        }
    }
    return undefined;
}

async function windowsCandidates(deps: ProfileDetectionDeps): Promise<Candidate[]> {
    const join = path.win32.join;
    const programFiles = envValue(deps.env, 'ProgramW6432') ?? envValue(deps.env, 'ProgramFiles') ?? 'C:\\Program Files';
    const programFilesX86 = envValue(deps.env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)';
    const localAppData = envValue(deps.env, 'LOCALAPPDATA');
    const systemRoot = envValue(deps.env, 'SystemRoot') ?? envValue(deps.env, 'windir') ?? 'C:\\Windows';
    const system32 = join(systemRoot, 'System32');

    let gitInstall: string | undefined;
    try {
        gitInstall = await deps.readRegistry?.(GIT_FOR_WINDOWS_KEY, 'InstallPath');
    } catch {
        gitInstall = undefined;
    }
    const gitBash = [
        ...(gitInstall && path.win32.isAbsolute(gitInstall) ? [join(gitInstall, 'bin', 'bash.exe')] : []),
        join(programFiles, 'Git', 'bin', 'bash.exe'),
        join(programFilesX86, 'Git', 'bin', 'bash.exe'),
        ...(localAppData ? [join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe')] : []),
    ];
    const pwsh = [
        join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
        join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
        ...(localAppData ? [join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe')] : []),
    ];
    const comSpec = envValue(deps.env, 'ComSpec');
    return [
        // Git Bash as a login, interactive shell: what its own shortcut starts, so ~/.bash_profile runs.
        { id: 'git-bash', name: 'Git Bash', paths: gitBash, args: ['--login', '-i'] },
        { id: 'pwsh', name: 'PowerShell', paths: pwsh, args: [] },
        { id: 'powershell', name: 'Windows PowerShell', paths: [join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')], args: [] },
        { id: 'cmd', name: 'Command Prompt', paths: [...(comSpec && path.win32.isAbsolute(comSpec) ? [comSpec] : []), join(system32, 'cmd.exe')], args: [] },
        { id: 'wsl', name: 'WSL', paths: [join(system32, 'wsl.exe')], args: [] },
    ];
}

function posixCandidates(deps: ProfileDetectionDeps): Candidate[] {
    // macOS terminals start login shells (Terminal.app, VS Code); Linux ones do not.
    const args = deps.platform === 'darwin' ? ['-l'] : [];
    const shell = envValue(deps.env, 'SHELL');
    const files = [...(shell && path.posix.isAbsolute(shell) ? [shell] : []), '/bin/bash', '/bin/sh'];
    return files.map((file) => {
        const name = path.posix.basename(file);
        return { id: name, name, paths: [file], args };
    });
}

/** The default for new terminals: the saved choice while it is still listed, otherwise the first profile. */
export function resolveDefaultProfile(profiles: readonly TerminalProfile[], savedId: unknown): string | null {
    if (typeof savedId === 'string' && profiles.some((profile) => profile.id === savedId)) {
        return savedId;
    }
    return profiles[0]?.id ?? null;
}

export function profileList(detected: readonly TerminalProfile[], custom: readonly TerminalProfile[], savedDefault: unknown): TerminalProfileList {
    const profiles = [...detected, ...custom];
    return { profiles, defaultProfileId: resolveDefaultProfile(profiles, savedDefault) };
}

export const MAX_CUSTOM_PROFILES = 20;
export const MAX_PROFILE_ARGS = 32;
const MAX_ARG_LENGTH = 1024;

/** True for an argument list a custom profile may carry. */
export function isValidArgs(args: unknown): args is string[] {
    return Array.isArray(args)
        && args.length <= MAX_PROFILE_ARGS
        && args.every((arg) => typeof arg === 'string' && arg.length <= MAX_ARG_LENGTH && !arg.includes('\0'));
}

/**
 * Splits the arguments typed for a custom profile, shell-style but without
 * any expansion: whitespace separates, single or double quotes group. Throws
 * on an unbalanced quote or a list `isValidArgs` would refuse.
 */
export function splitArgs(text: string): string[] {
    const args: string[] = [];
    let current = '';
    let inArg = false;
    let quote: '"' | "'" | null = null;
    for (const char of text) {
        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
            inArg = true;
        } else if (/\s/.test(char)) {
            if (inArg) {
                args.push(current);
                current = '';
                inArg = false;
            }
        } else {
            current += char;
            inArg = true;
        }
    }
    if (quote) {
        throw new Error(`Unbalanced ${quote} in the arguments.`);
    }
    if (inArg) {
        args.push(current);
    }
    if (!isValidArgs(args)) {
        throw new Error(`At most ${MAX_PROFILE_ARGS} arguments of up to ${MAX_ARG_LENGTH} characters, without NUL.`);
    }
    return args;
}

/** Custom profiles from the settings file; anything malformed is dropped. */
export function parseCustomProfiles(data: unknown, platform: string): TerminalProfile[] {
    if (!Array.isArray(data)) {
        return [];
    }
    const isAbsolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
    const profiles: TerminalProfile[] = [];
    const ids = new Set<string>();
    for (const item of data.slice(0, MAX_CUSTOM_PROFILES)) {
        const entry = item as Partial<Record<'id' | 'name' | 'path' | 'args', unknown>> | null;
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const { id, name, path: file, args } = entry;
        if (typeof id !== 'string' || !/^custom-[a-z0-9-]{1,64}$/.test(id) || ids.has(id)) {
            continue;
        }
        if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
            continue;
        }
        if (typeof file !== 'string' || file.includes('\0') || !isAbsolute(file) || !isValidArgs(args)) {
            continue;
        }
        ids.add(id);
        profiles.push({ id, name, path: file, args, source: 'custom' });
    }
    return profiles;
}

/** A display name for a custom profile: the executable's name without its extension. */
export function customProfileName(file: string, platform: string): string {
    const base = platform === 'win32' ? path.win32.basename(file) : path.posix.basename(file);
    return base.replace(/\.(exe|cmd|bat|com)$/i, '') || base;
}
