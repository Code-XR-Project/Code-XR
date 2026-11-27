import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_PRESET_IDS, type AgentPresetId, type InstallDescription } from '../../shared/agentSession.ts';
import { PRESETS, diskProbe, findOnPath, type FileProbe } from './agentCatalog.ts';

/**
 * AF2 (#267): installs a preset's ACP adapter for the person, on request.
 *
 * Nothing here runs on its own. `describe` reads the npm registry only when
 * the person pressed Install (or Update): the version, licence, size,
 * repository and publication date of the adapter, its direct dependencies,
 * the native binaries they bring for this platform and which packages run
 * install scripts. `install` then runs the system's npm, after the person
 * confirmed that exact description in a native dialog, into
 * `<userData>/agent-packages` (a private package.json of the IDE's own): no
 * global write, no change to the person's projects or npm configuration.
 *
 * Why the system npm: an adapter is an npm package whose dependency tree
 * (exact versions, optional platform packages, install scripts) only npm
 * resolves faithfully. Re-implementing that (registry metadata, semver
 * ranges, tarball extraction, `os`/`cpu`/`libc` selection, lifecycle
 * scripts) would be a second, weaker npm, and bundling npm would add a large
 * dependency the IDE does not otherwise need. A person who runs coding agents
 * from npm has Node.js; one who does not gets a clear message pointing to
 * nodejs.org. Once installed, the adapter runs with the IDE's own Electron as
 * Node (agentCatalog.ts), so only the install needs npm. npm reads the
 * person's own configuration (`.npmrc`, proxy, registry, CA), so it works
 * behind the same proxy their terminal does.
 *
 * Electron-free: the registry is read through an injected `fetchJson`, and
 * the tests use a local fake registry and a fake npm on PATH.
 */

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';

/** What a manifest from the registry looks like, as far as this file reads it. */
interface Manifest {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly license?: unknown;
    readonly repository?: unknown;
    readonly homepage?: unknown;
    readonly dependencies?: unknown;
    readonly optionalDependencies?: unknown;
    readonly scripts?: unknown;
    readonly hasInstallScript?: unknown;
    readonly os?: unknown;
    readonly cpu?: unknown;
    readonly libc?: unknown;
    readonly dist?: { readonly unpackedSize?: unknown };
}

export interface InstallerOptions {
    /** `<userData>/agent-packages`. */
    readonly packagesDir: string;
    /** GETs a registry URL and returns its JSON; throws on a failed request. */
    readonly fetchJson: (url: string) => Promise<unknown>;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly probe?: FileProbe;
    /** How long a description stays valid for the install that follows it, ms. */
    readonly descriptionTtlMs?: number;
    /** How long npm may run, ms. */
    readonly timeoutMs?: number;
    readonly now?: () => number;
}

export type LineSink = (line: string) => void;

const MAX_FETCHES = 24;
const MAX_LINE = 400;
const KEEP_LINES = 30;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const OS_TOKENS = /(^|[-_@/])(linux|darwin|macos|win32|windows|freebsd|android|sunos|aix)([-_.]|$)/i;

const PACKAGE_JSON = {
    name: 'codexr-agent-packages',
    private: true,
    description: 'Coding agent adapters installed by Code-XR IDE at the person\'s request. Managed by the IDE.',
    dependencies: {},
};

/** The preset a renderer argument names, or an error. */
export function parsePresetId(value: unknown): AgentPresetId {
    if (typeof value !== 'string' || !(AGENT_PRESET_IDS as readonly string[]).includes(value)) {
        throw new Error('Only Claude Code, Codex and Gemini CLI can be installed here.');
    }
    return value as AgentPresetId;
}

/** The registry npm uses, from its environment variables; only https (or a local http one, for tests). */
export function registryOf(env: Readonly<Record<string, string | undefined>>): string {
    const raw = env['npm_config_registry'] ?? env['NPM_CONFIG_REGISTRY'] ?? DEFAULT_REGISTRY;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return DEFAULT_REGISTRY;
    }
    const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (url.protocol !== 'https:' && !local) {
        return DEFAULT_REGISTRY;
    }
    return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

/** `@scope/name` as the registry's path segment. */
function registryPath(name: string): string {
    return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/** `npm:@openai/codex@0.1.0-linux-x64` -> its real name and spec; other specs unchanged. */
export function resolveAlias(name: string, spec: string): { readonly name: string; readonly spec: string } {
    if (!spec.startsWith('npm:')) {
        return { name, spec };
    }
    const target = spec.slice(4);
    const at = target.lastIndexOf('@');
    return at > 0 ? { name: target.slice(0, at), spec: target.slice(at + 1) } : { name: target, spec: 'latest' };
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** True when `spec` is one exact version. */
export function isExactVersion(spec: string): boolean {
    return VERSION.test(spec.trim());
}

/**
 * Whether `version` satisfies `spec`, for the forms adapters use (exact,
 * `^`, `~`, `*`, `x`); null for a range this does not understand.
 */
export function satisfies(version: string, spec: string): boolean | null {
    const v = VERSION.exec(version);
    const trimmed = spec.trim();
    if (!v) {
        return null;
    }
    if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'latest') {
        return !v[4];
    }
    const match = /^([~^]|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed);
    if (!match) {
        return null;
    }
    const [major, minor, patch] = [Number(v[1]), Number(v[2]), Number(v[3])];
    const op = match[1] ?? '';
    const sMajor = Number(match[2]);
    const sMinor = match[3] === undefined || match[3] === 'x' || match[3] === '*' ? null : Number(match[3]);
    const sPatch = match[4] === undefined || match[4] === 'x' || match[4] === '*' ? null : Number(match[4]);
    const sPre = match[5];
    if (v[4] && !(sPre && major === sMajor && minor === sMinor && patch === sPatch)) {
        // A prerelease only satisfies a range that names a prerelease of the same version.
        return false;
    }
    const cmp = (a: readonly number[], b: readonly number[]): number => {
        for (let i = 0; i < a.length; i += 1) {
            const d = (a[i] ?? 0) - (b[i] ?? 0);
            if (d !== 0) {
                return d;
            }
        }
        return 0;
    };
    const atLeast = cmp([major, minor, patch], [sMajor, sMinor ?? 0, sPatch ?? 0]) >= 0;
    if (op === '^') {
        if (!atLeast) {
            return false;
        }
        if (sMajor > 0 || sMinor === null) {
            return major === sMajor;
        }
        if (sMinor > 0 || sPatch === null) {
            return major === 0 && minor === sMinor;
        }
        return major === 0 && minor === 0 && patch === sPatch;
    }
    if (op === '~') {
        return atLeast && major === sMajor && (sMinor === null || minor === sMinor);
    }
    if (sPre && !v[4]) {
        return false;
    }
    return major === sMajor && (sMinor === null || minor === sMinor) && (sPatch === null || patch === sPatch) && (!sPre || sPre === v[4]);
}

function stringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function sizeOf(manifest: Manifest | null): number | null {
    const size = manifest?.dist?.unpackedSize;
    return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null;
}

function licenseOf(manifest: Manifest): string | null {
    const license = manifest.license;
    if (typeof license === 'string' && license.trim()) {
        return license.trim().slice(0, 100);
    }
    if (license && typeof license === 'object' && typeof (license as { type?: unknown }).type === 'string') {
        return String((license as { type: string }).type).slice(0, 100);
    }
    return null;
}

/** A repository field as a browsable https URL, or null. */
export function repositoryUrl(repository: unknown): string | null {
    const raw = typeof repository === 'string' ? repository : repository && typeof repository === 'object' ? (repository as { url?: unknown }).url : null;
    if (typeof raw !== 'string') {
        return null;
    }
    let url = raw.trim().replace(/^git\+/, '').replace(/\.git$/, '');
    if (/^github:/.test(url) || /^[\w.-]+\/[\w.-]+$/.test(url)) {
        url = `https://github.com/${url.replace(/^github:/, '')}`;
    }
    url = url.replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/^git@([^:]+):/, 'https://$1/');
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
        return null;
    }
}

function hasInstallScript(manifest: Manifest): boolean {
    const scripts = stringRecord(manifest.scripts);
    return manifest.hasInstallScript === true || INSTALL_SCRIPTS.some((name) => name in scripts);
}

/** The platform an optional dependency name targets, as npm's `os-cpu` naming does. */
function targetsPlatform(name: string): boolean {
    return OS_TOKENS.test(name);
}

/** How well a platform package's name fits this machine (higher is better, 0 is not at all). */
export function platformFit(name: string, platform: NodeJS.Platform, arch: string): number {
    const lower = name.toLowerCase();
    const os = platform === 'win32' ? ['win32', 'windows'] : platform === 'darwin' ? ['darwin', 'macos'] : [platform];
    if (!os.some((token) => lower.includes(token)) || !lower.includes(arch)) {
        return 0;
    }
    // The glibc build before the musl one: a glibc system is the common case.
    return lower.includes('musl') ? 1 : 2;
}

function lastLines(lines: readonly string[]): string {
    return lines.slice(-8).join('\n');
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** How to start npm without a shell. */
export interface NpmCommand {
    readonly command: string;
    readonly prefixArgs: readonly string[];
    /** Where it was found, for messages. */
    readonly path: string;
}

export class AgentInstaller {
    private readonly options: InstallerOptions;
    private readonly probe: FileProbe;
    private readonly registry: string;
    private readonly descriptions = new Map<AgentPresetId, { readonly description: InstallDescription; readonly at: number }>();
    private busy: string | null = null;

    constructor(options: InstallerOptions) {
        this.options = options;
        this.probe = options.probe ?? diskProbe;
        this.registry = registryOf(options.env);
    }

    /** The operation running now ("Installing Codex"), or null. */
    get running(): string | null {
        return this.busy;
    }

    private preset(id: AgentPresetId): (typeof PRESETS)[number] {
        const preset = PRESETS.find((candidate) => candidate.id === id);
        if (!preset) {
            throw new Error('Unknown agent.');
        }
        return preset;
    }

    private packageDir(packageName: string): string {
        return path.join(this.options.packagesDir, 'node_modules', ...packageName.split('/'));
    }

    /** The version of a preset's adapter the IDE installed, or null. */
    async installedVersion(presetId: AgentPresetId): Promise<string | null> {
        const text = await this.probe.readText(path.join(this.packageDir(this.preset(presetId).packageName), 'package.json'));
        if (text === null) {
            return null;
        }
        try {
            const version = (JSON.parse(text) as { version?: unknown }).version;
            return typeof version === 'string' && VERSION.test(version) ? version : null;
        } catch {
            return null;
        }
    }

    /** Finds npm on PATH; on Windows, the `node.exe` + `npm-cli.js` next to `npm.cmd`, so no shell is needed. */
    async findNpm(): Promise<NpmCommand | null> {
        const { env, platform } = this.options;
        if (platform !== 'win32') {
            const found = await findOnPath('npm', env, platform, this.probe);
            return found ? { command: found, prefixArgs: [], path: found } : null;
        }
        const found = await findOnPath('npm', env, platform, this.probe);
        if (!found) {
            return null;
        }
        if (/\.exe$/i.test(found)) {
            return { command: found, prefixArgs: [], path: found };
        }
        const dir = path.win32.dirname(found);
        const node = path.win32.join(dir, 'node.exe');
        const cli = path.win32.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if ((await this.probe.isExecutable(node)) && (await this.probe.readText(cli)) !== null) {
            return { command: node, prefixArgs: [cli], path: found };
        }
        const nodeOnPath = await findOnPath('node', env, platform, this.probe);
        if (nodeOnPath && (await this.probe.readText(cli)) !== null) {
            return { command: nodeOnPath, prefixArgs: [cli], path: found };
        }
        return null;
    }

    private async fetchManifest(name: string, spec: string, budget: { left: number }): Promise<Manifest | null> {
        if (budget.left <= 0) {
            return null;
        }
        budget.left -= 1;
        const real = resolveAlias(name, spec);
        const exact = isExactVersion(real.spec);
        const tag = exact ? real.spec.trim().replace(/^v/, '') : 'latest';
        let manifest: Manifest;
        try {
            const raw = await this.options.fetchJson(`${this.registry}${registryPath(real.name)}/${encodeURIComponent(tag)}`);
            if (!raw || typeof raw !== 'object') {
                return null;
            }
            manifest = raw as Manifest;
        } catch {
            return null;
        }
        // A range the latest version does not satisfy: npm picks another version, whose details are not known here.
        if (!exact && typeof manifest.version === 'string' && satisfies(manifest.version, real.spec) !== true && real.spec !== 'latest') {
            return null;
        }
        return manifest;
    }

    /** Reads the registry: the only network access before the person confirms. */
    async describe(presetIdInput: unknown): Promise<InstallDescription> {
        const presetId = parsePresetId(presetIdInput);
        const preset = this.preset(presetId);
        let raw: unknown;
        try {
            raw = await this.options.fetchJson(`${this.registry}${registryPath(preset.packageName)}/latest`);
        } catch (error) {
            throw new Error(`Could not read ${preset.packageName} from ${this.registry}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const manifest = (raw && typeof raw === 'object' ? raw : {}) as Manifest;
        if (manifest.name !== preset.packageName || typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) {
            throw new Error(`The registry did not describe ${preset.packageName}.`);
        }
        const version = manifest.version;
        const { platform, arch } = this.options;
        const budget = { left: MAX_FETCHES };
        const dependencies = stringRecord(manifest.dependencies);
        const optional = stringRecord(manifest.optionalDependencies);
        const installScripts = hasInstallScript(manifest) ? [preset.packageName] : [];
        const nativeBinaries: { name: string; size: number | null }[] = [];
        let dependenciesSize = 0;
        let anySize = false;
        const addSize = (size: number | null): void => {
            if (size !== null) {
                dependenciesSize += size;
                anySize = true;
            }
        };

        const seenBinaries = new Set<string>();
        /** Optional platform packages: npm installs the one that fits; it is listed and its size counted. */
        const platformPackages = async (owner: string, entries: Record<string, string>): Promise<Record<string, string>> => {
            const platformNames = Object.keys(entries).filter((name) => targetsPlatform(`${name} ${entries[name] ?? ''}`));
            if (platformNames.length < 2) {
                return entries;
            }
            const scored = platformNames
                .map((name) => ({ name, fit: platformFit(`${name} ${entries[name] ?? ''}`, platform, arch) }))
                .filter((candidate) => candidate.fit > 0)
                .sort((a, b) => b.fit - a.fit);
            const chosen = scored[0];
            if (chosen && seenBinaries.has(chosen.name)) {
                return Object.fromEntries(Object.entries(entries).filter(([name]) => !platformNames.includes(name)));
            }
            if (chosen) {
                seenBinaries.add(chosen.name);
            }
            let size: number | null = null;
            if (chosen) {
                const binary = await this.fetchManifest(chosen.name, entries[chosen.name] ?? 'latest', budget);
                size = sizeOf(binary);
                addSize(size);
                if (binary && hasInstallScript(binary)) {
                    installScripts.push(chosen.name);
                }
            }
            nativeBinaries.push({ name: chosen ? `${owner}: ${chosen.name}` : `${owner}: none of its ${platformNames.length} platform packages fits ${platform}-${arch}`, size });
            return Object.fromEntries(Object.entries(entries).filter(([name]) => !platformNames.includes(name)));
        };

        const rest = await platformPackages(preset.packageName, optional);
        const direct = Object.entries({ ...dependencies, ...rest });
        const manifests = await Promise.all(direct.map(([name, spec]) => this.fetchManifest(name, spec, budget)));
        for (let i = 0; i < direct.length; i += 1) {
            const [name] = direct[i] as [string, string];
            const dependency = manifests[i] ?? null;
            if (!dependency) {
                continue;
            }
            addSize(sizeOf(dependency));
            if (hasInstallScript(dependency)) {
                installScripts.push(name);
            }
            const nested = stringRecord(dependency.optionalDependencies);
            if (Object.keys(nested).length > 0) {
                await platformPackages(name, nested);
            }
        }

        const installedVersion = await this.installedVersion(presetId);
        const description: InstallDescription = {
            presetId,
            agentName: preset.name,
            packageName: preset.packageName,
            version,
            license: licenseOf(manifest),
            unpackedSize: sizeOf(manifest),
            dependenciesSize: anySize ? dependenciesSize : null,
            repository: repositoryUrl(manifest.repository),
            homepage: typeof manifest.homepage === 'string' && /^https:\/\//.test(manifest.homepage) ? manifest.homepage : null,
            published: await this.publishedAt(preset.packageName, version, budget),
            registry: this.registry,
            dependencies: Object.entries({ ...dependencies, ...optional }).map(([name, spec]) => `${name}@${spec}`),
            nativeBinaries,
            installScripts,
            targetDir: this.options.packagesDir,
            command: `npm ${this.installArgs(`${preset.packageName}@${version}`).join(' ')}`,
            installedVersion,
        };
        this.descriptions.set(presetId, { description, at: this.now() });
        return description;
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    /** The publication date, from the full document's `time` (it can be large, so it is read last and optional). */
    private async publishedAt(name: string, version: string, budget: { left: number }): Promise<string | null> {
        if (budget.left <= 0) {
            return null;
        }
        budget.left -= 1;
        try {
            const doc = (await this.options.fetchJson(`${this.registry}${registryPath(name)}`)) as { time?: Record<string, unknown> } | null;
            const time = doc?.time?.[version];
            return typeof time === 'string' && !Number.isNaN(Date.parse(time)) ? new Date(time).toISOString() : null;
        } catch {
            return null;
        }
    }

    private installArgs(spec: string): string[] {
        return ['install', '--prefix', this.options.packagesDir, '--no-audit', '--no-fund', '--omit=dev', '--save-exact', '--ignore-scripts=false', '--loglevel=http', '--progress=false', spec];
    }

    /** The description to confirm: the one just shown, or a fresh one when it is old. */
    async descriptionFor(presetIdInput: unknown): Promise<InstallDescription> {
        const presetId = parsePresetId(presetIdInput);
        const cached = this.descriptions.get(presetId);
        if (cached && this.now() - cached.at < (this.options.descriptionTtlMs ?? 10 * 60_000)) {
            return cached.description;
        }
        return this.describe(presetId);
    }

    /**
     * Installs (or updates to) the version `confirm` is shown. Resolves false
     * when the person declines; throws with npm's last lines when it fails.
     */
    async install(presetIdInput: unknown, confirm: (description: InstallDescription) => Promise<boolean>, onLine: LineSink): Promise<boolean> {
        const presetId = parsePresetId(presetIdInput);
        this.assertIdle();
        const npm = await this.findNpm();
        if (!npm) {
            throw new Error(`npm was not found on PATH. Installing an agent needs Node.js, which includes npm: get it from ${NODE_DOWNLOAD_URL}, then restart Code-XR IDE and try again.`);
        }
        const description = await this.descriptionFor(presetId);
        if (!(await confirm(description))) {
            return false;
        }
        this.assertIdle();
        this.busy = `Installing ${description.agentName}`;
        try {
            await this.ensurePackageJson();
            onLine(`Installing ${description.packageName}@${description.version} into ${description.targetDir}`);
            await this.runNpm(npm, this.installArgs(`${description.packageName}@${description.version}`), onLine);
            const installed = await this.installedVersion(presetId);
            if (installed !== description.version) {
                throw new Error(`npm finished but ${description.packageName}@${description.version} is not in ${description.targetDir}.`);
            }
            this.descriptions.delete(presetId);
            return true;
        } finally {
            this.busy = null;
        }
    }

    /** Removes an adapter the IDE installed, after `confirm`. */
    async uninstall(presetIdInput: unknown, confirm: (packageName: string, version: string) => Promise<boolean>, onLine: LineSink): Promise<boolean> {
        const presetId = parsePresetId(presetIdInput);
        const preset = this.preset(presetId);
        this.assertIdle();
        const version = await this.installedVersion(presetId);
        if (!version) {
            throw new Error(`${preset.name} was not installed by Code-XR IDE; remove it the way you installed it.`);
        }
        if (!(await confirm(preset.packageName, version))) {
            return false;
        }
        this.assertIdle();
        this.busy = `Removing ${preset.name}`;
        try {
            const npm = await this.findNpm();
            if (npm) {
                await this.runNpm(npm, ['uninstall', '--prefix', this.options.packagesDir, '--no-audit', '--no-fund', '--loglevel=http', '--progress=false', preset.packageName], onLine);
            }
            // Without npm (or if it left it behind), the package's own folder goes; its dependencies stay until the next npm run.
            await fs.promises.rm(this.packageDir(preset.packageName), { recursive: true, force: true });
            await this.dropDependency(preset.packageName);
            this.descriptions.delete(presetId);
            onLine(`Removed ${preset.packageName}@${version}.`);
            return true;
        } finally {
            this.busy = null;
        }
    }

    private assertIdle(): void {
        if (this.busy) {
            throw new Error(`${this.busy} is still running; wait for it to finish.`);
        }
    }

    private async ensurePackageJson(): Promise<void> {
        await fs.promises.mkdir(this.options.packagesDir, { recursive: true });
        const file = path.join(this.options.packagesDir, 'package.json');
        if ((await this.probe.readText(file)) === null) {
            await fs.promises.writeFile(file, `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`, 'utf8');
        }
    }

    private async dropDependency(packageName: string): Promise<void> {
        const file = path.join(this.options.packagesDir, 'package.json');
        const text = await this.probe.readText(file);
        if (text === null) {
            return;
        }
        try {
            const json = JSON.parse(text) as { dependencies?: Record<string, string> };
            if (json.dependencies && packageName in json.dependencies) {
                delete json.dependencies[packageName];
                await fs.promises.writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
            }
        } catch {
            // A package.json the IDE cannot read is left alone.
        }
    }

    /** The environment npm runs with: the person's own (proxy, npm config, CA), without Electron's switches. */
    private npmEnv(): Record<string, string> {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(this.options.env)) {
            if (value !== undefined && !/^ELECTRON_/i.test(key) && key.toUpperCase() !== 'NODE_OPTIONS') {
                env[key] = value;
            }
        }
        return { ...env, NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false', npm_config_color: 'false' };
    }

    private runNpm(npm: NpmCommand, args: readonly string[], onLine: LineSink): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const tail: string[] = [];
            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(npm.command, [...npm.prefixArgs, ...args], { cwd: this.options.packagesDir, env: this.npmEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (error) {
                reject(new Error(`Could not start npm (${npm.path}): ${error instanceof Error ? error.message : String(error)}`));
                return;
            }
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`npm took longer than ${Math.round((this.options.timeoutMs ?? 20 * 60_000) / 60_000)} minutes and was stopped.\n${lastLines(tail)}`));
            }, this.options.timeoutMs ?? 20 * 60_000);
            const reader = (): ((chunk: Buffer) => void) => {
                let pending = '';
                return (chunk) => {
                    pending += chunk.toString('utf8');
                    const lines = pending.split(/\r?\n|\r/);
                    pending = lines.pop() ?? '';
                    for (const raw of lines) {
                        const line = stripAnsi(raw).trimEnd().slice(0, MAX_LINE);
                        if (line.trim()) {
                            tail.push(line);
                            if (tail.length > KEEP_LINES) {
                                tail.shift();
                            }
                            onLine(line);
                        }
                    }
                };
            };
            child.stdout?.on('data', reader());
            child.stderr?.on('data', reader());
            child.on('error', (error) => {
                clearTimeout(timer);
                reject(new Error(`Could not start npm (${npm.path}): ${error.message}`));
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`npm failed (${signal ?? `exit code ${String(code)}`}).${tail.length ? `\n${lastLines(tail)}` : ''}`));
                }
            });
        });
    }
}

/** "3.4 MB". */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

/** The text of the consent dialog: what will be downloaded, from where, and what runs. */
export function consentDetail(description: InstallDescription): string {
    const size = [
        description.unpackedSize !== null ? `${formatBytes(description.unpackedSize)} (the adapter)` : 'unknown (the registry does not say)',
        description.dependenciesSize !== null ? `at least ${formatBytes(description.dependenciesSize)} more for its dependencies on this platform` : null,
    ].filter(Boolean).join(', ');
    const lines = [
        `Package: ${description.packageName}@${description.version}${description.installedVersion ? ` (installed now: ${description.installedVersion})` : ''}`,
        `Licence: ${description.license ?? 'not stated'}`,
        `Size once unpacked: ${size}`,
        `Source: ${description.registry}${description.repository ? `\nRepository: ${description.repository}` : ''}`,
        ...(description.published ? [`Published: ${description.published.slice(0, 10)}`] : []),
        ...(description.dependencies.length ? [`Dependencies: ${description.dependencies.join(', ')}`] : []),
        ...(description.nativeBinaries.length ? [`Native binaries (one per platform, npm picks yours): ${description.nativeBinaries.map((binary) => `${binary.name}${binary.size !== null ? ` (${formatBytes(binary.size)})` : ''}`).join('; ')}`] : []),
        description.installScripts.length ? `Install scripts will run for: ${description.installScripts.join(', ')}` : 'Install scripts: none declared by the adapter or its direct dependencies.',
        '',
        `Code-XR IDE will run, with your npm configuration and network settings:\n${description.command}`,
        `Into: ${description.targetDir} (nothing is installed globally).`,
        '',
        `The adapter then runs as ${description.agentName}'s agent with your permissions, inside the project folders you trust. Only install software you trust.`,
    ];
    return lines.join('\n');
}
