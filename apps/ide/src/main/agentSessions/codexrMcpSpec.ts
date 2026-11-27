import path from 'node:path';

/**
 * The stdio MCP server spec that hands Code-XR's analysis to an external
 * agent (AF10). The IDE passes it in ACP `session/new` (`mcpServers`), and
 * the agent (Claude Code, Codex, Gemini CLI) starts the server itself.
 *
 * The server is the IDE's own bundle out/codexrMcp/index.cjs, run by the
 * IDE's own binary in Node mode (ELECTRON_RUN_AS_NODE=1): no system Node is
 * needed, and ACP wants an absolute command, which `execPath` is.
 *
 * Packaged, `appPath` (app.getAppPath()) is resources/app.asar and the bundle
 * stays inside the archive: Electron's patched fs loads a script from an asar
 * in Node mode too (checked by running the built bundle from a packed
 * app.asar), so it needs no asarUnpack entry and both layouts resolve the
 * same way. `isPackaged` is accepted so a caller passes the whole picture
 * and a future layout difference has a place to go.
 */

export interface CodexrMcpSpecOptions {
    /** process.execPath of the IDE: Electron itself, or the packaged executable. */
    readonly execPath: string;
    /** app.getAppPath(): the folder (or app.asar) that holds out/. */
    readonly appPath: string;
    /** The project open in the window (absolute). */
    readonly root: string;
    /** The window's analysis output folder, or null when no analysis has run. */
    readonly analysisDir: string | null;
    readonly isPackaged: boolean;
}

/** ACP's McpServerStdio: `env` is a list of name/value pairs, not a map. */
export interface CodexrMcpServerSpec {
    readonly name: string;
    readonly command: string;
    readonly args: string[];
    readonly env: { name: string; value: string }[];
}

export const CODEXR_MCP_SERVER_NAME = 'code-xr';

/** The bundle's path inside `appPath` (see the build target in scripts/viteConfigs.mjs). */
export function codexrMcpEntry(appPath: string): string {
    return path.join(appPath, 'out', 'codexrMcp', 'index.cjs');
}

export function codexrMcpServerSpec(options: CodexrMcpSpecOptions): CodexrMcpServerSpec {
    return {
        name: CODEXR_MCP_SERVER_NAME,
        command: options.execPath,
        args: [codexrMcpEntry(options.appPath), '--root', options.root, '--analysis', options.analysisDir ?? ''],
        env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    };
}
