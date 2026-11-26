import path from 'node:path';

/**
 * Which program serves each language (#21). The renderer never names one:
 * TypeScript/JavaScript run the `typescript-language-server` the IDE ships,
 * on the IDE's own TypeScript (never a project's, which would run code from
 * the folder just by opening it), with automatic type acquisition off so it
 * downloads nothing. Python uses a server already on PATH, or none.
 * Pure (file system and environment injected), so every OS is unit-tested.
 */

export interface ServerCommand {
    /** For the Output panel. */
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly initializationOptions?: Readonly<Record<string, unknown>>;
}

/** Electron's own switches and the dev server URL stay out of a server's environment, as for the terminal. */
const STRIPPED_ENV = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|ELECTRON_ENABLE_LOGGING|CODEXR_IDE_DEV_SERVER_URL|NODE_OPTIONS)$/i;

export function serverEnvironment(env: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && !STRIPPED_ENV.test(key)) {
            result[key] = value;
        }
    }
    return { ...result, ...extra };
}

/**
 * typescript-language-server run by Electron's own Node (`ELECTRON_RUN_AS_NODE`),
 * so it needs no Node on the machine; it forks tsserver the same way.
 */
export function typescriptServerCommand(paths: { readonly execPath: string; readonly cliPath: string; readonly tsserverPath: string }, env: Readonly<Record<string, string | undefined>>): ServerCommand {
    return {
        name: 'typescript-language-server',
        command: paths.execPath,
        args: [paths.cliPath, '--stdio', '--log-level', '2'],
        env: serverEnvironment(env, { ELECTRON_RUN_AS_NODE: '1' }),
        initializationOptions: {
            hostInfo: 'code-xr-ide',
            tsserver: { path: paths.tsserverPath },
            disableAutomaticTypingAcquisition: true,
            preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true },
        },
    };
}

/** The Python servers looked for on PATH, in order, with the arguments that put them on stdio. */
export const PYTHON_SERVERS: readonly { readonly name: string; readonly args: readonly string[] }[] = [
    { name: 'pyright-langserver', args: ['--stdio'] },
    { name: 'pylsp', args: [] },
];

export interface PathLookup {
    readonly platform: NodeJS.Platform;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly isFile: (file: string) => Promise<boolean>;
}

/**
 * The first executable called `name` on PATH. On Windows only `.exe` counts:
 * a `.cmd` shim would need a shell, and a server never runs through one.
 */
export async function findOnPath(name: string, lookup: PathLookup): Promise<string | null> {
    const win = lookup.platform === 'win32';
    const p = win ? path.win32 : path.posix;
    const pathValue = win ? (lookup.env['Path'] ?? lookup.env['PATH'] ?? '') : (lookup.env['PATH'] ?? '');
    for (const dir of pathValue.split(win ? ';' : ':')) {
        if (dir === '' || !p.isAbsolute(dir)) {
            continue; // a relative PATH entry would resolve against the folder that is open
        }
        const candidate = p.join(dir, win ? `${name}.exe` : name);
        if (await lookup.isFile(candidate)) {
            return candidate;
        }
    }
    return null;
}

/** The Python language server to run, or null when none is installed. */
export async function findPythonServer(lookup: PathLookup): Promise<ServerCommand | null> {
    for (const server of PYTHON_SERVERS) {
        const command = await findOnPath(server.name, lookup);
        if (command) {
            return { name: server.name, command, args: server.args, env: serverEnvironment(lookup.env) };
        }
    }
    return null;
}
