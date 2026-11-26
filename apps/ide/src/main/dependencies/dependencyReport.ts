import type { PythonEnvStatus } from '../../shared/api.ts';

/**
 * The IDE's dependencies and their state, as Help > About shows them (#161).
 * Pure, so every wording is unit-tested without Python, Electron or a network.
 */
export interface CloudflaredStatus {
    readonly state: 'ready' | 'missing' | 'installing' | 'failed' | 'unsupported';
    readonly version: string;
    readonly path?: string | undefined;
    /** `managed`: the IDE's own download; `system`: found on PATH. */
    readonly source?: 'managed' | 'system' | undefined;
    readonly error?: string | undefined;
}

export interface ParsersStatus {
    /** `unknown`: no environment to ask, or the check failed. */
    readonly state: 'ready' | 'partial' | 'missing' | 'unknown';
    readonly total: number;
    readonly missing: readonly string[];
}

export type DependencyState = 'ok' | 'working' | 'missing' | 'error';

export interface DependencyLine {
    readonly name: string;
    readonly state: DependencyState;
    readonly detail: string;
}

const MARK: Record<DependencyState, string> = { ok: '[ok]', working: '[installing]', missing: '[missing]', error: '[problem]' };

export function describeDependencies(python: PythonEnvStatus, parsers: ParsersStatus, cloudflared: CloudflaredStatus): DependencyLine[] {
    return [pythonLine(python), environmentLine(python), ...packageLines(python), parsersLine(python, parsers), cloudflaredLine(cloudflared)];
}

function pythonLine(python: PythonEnvStatus): DependencyLine {
    if (python.state === 'missing-python') {
        return { name: 'Python 3', state: 'missing', detail: 'not found on this computer' };
    }
    return { name: 'Python 3', state: 'ok', detail: python.pythonVersion ? `Python ${python.pythonVersion}` : 'found' };
}

function environmentLine(python: PythonEnvStatus): DependencyLine {
    switch (python.state) {
        case 'ready': return { name: 'Analysis environment', state: 'ok', detail: python.venvPath };
        case 'installing': return { name: 'Analysis environment', state: 'working', detail: python.message };
        case 'broken': return { name: 'Analysis environment', state: 'error', detail: python.message };
        default: return { name: 'Analysis environment', state: 'missing', detail: 'not set up' };
    }
}

function packageLines(python: PythonEnvStatus): DependencyLine[] {
    // The core checks the packages as a set: every one imports, or the environment is incomplete.
    const state: DependencyState = python.state === 'ready' ? 'ok' : python.state === 'installing' ? 'working' : 'missing';
    return python.packages.map((pkg) => ({ name: `${pkg.name} ${pkg.version}`, state, detail: pkg.purpose }));
}

function parsersLine(python: PythonEnvStatus, parsers: ParsersStatus): DependencyLine {
    const name = 'Language parsers (tree-sitter)';
    if (python.state === 'installing') {
        return { name, state: 'working', detail: 'installing with the environment' };
    }
    switch (parsers.state) {
        case 'ready': return { name, state: 'ok', detail: `${parsers.total} of ${parsers.total}` };
        case 'partial': return { name, state: 'error', detail: `${parsers.total - parsers.missing.length} of ${parsers.total}; missing ${parsers.missing.join(', ')} (pattern matching instead)` };
        case 'missing': return { name, state: 'missing', detail: `none of ${parsers.total} (dependency graph uses pattern matching)` };
        default: return { name, state: 'missing', detail: 'unknown until the environment is set up' };
    }
}

function cloudflaredLine(cloudflared: CloudflaredStatus): DependencyLine {
    const name = 'cloudflared';
    switch (cloudflared.state) {
        case 'ready': return { name, state: 'ok', detail: cloudflared.source === 'system' ? `on PATH (${cloudflared.path ?? ''})` : `${cloudflared.version}, installed by the IDE` };
        case 'installing': return { name, state: 'working', detail: `downloading ${cloudflared.version}` };
        case 'failed': return { name, state: 'error', detail: `install failed: ${cloudflared.error ?? 'unknown error'}` };
        case 'unsupported': return { name, state: 'missing', detail: 'no automatic download for this system: install it on PATH to share' };
        default: return { name, state: 'missing', detail: 'not installed (needed to share a scene)' };
    }
}

/** Whether Repair has something to do: a missing or failed dependency the IDE installs itself. */
export function canRepair(python: PythonEnvStatus, cloudflared: CloudflaredStatus): boolean {
    const pythonNeeds = python.state === 'not-installed' || python.state === 'broken';
    const cloudflaredNeeds = cloudflared.state === 'missing' || cloudflared.state === 'failed';
    return pythonNeeds || cloudflaredNeeds;
}

/** The dialog's text: one line per dependency, with a mark for its state. */
export function formatDependencies(lines: readonly DependencyLine[]): string {
    return lines.map((line) => `${MARK[line.state]} ${line.name}: ${line.detail}`).join('\n');
}

/** Reads `download_parsers.py --check` output (one JSON line). */
export function parseParsersCheck(stdout: string): ParsersStatus {
    for (const line of stdout.split(/\r?\n/).reverse()) {
        try {
            const value = JSON.parse(line) as { requested?: unknown; missing?: unknown };
            if (Array.isArray(value.requested) && Array.isArray(value.missing)) {
                const missing = value.missing.filter((item): item is string => typeof item === 'string');
                const total = value.requested.length;
                const state = missing.length === 0 ? 'ready' : missing.length >= total ? 'missing' : 'partial';
                return { state, total, missing };
            }
        } catch {
            // Not the summary line.
        }
    }
    return { state: 'unknown', total: 0, missing: [] };
}
