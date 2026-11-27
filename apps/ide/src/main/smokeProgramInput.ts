import type { WebContents } from 'electron';
import type { TerminalHost } from './terminal/terminalHost.ts';
import { terminalEnvironment } from './terminal/terminalService.ts';

/**
 * #297: a sign-in runs a console program in a terminal of its own, with no
 * shell between (`TerminalHost.runProgram`), and the person types into it
 * (a code, an answer). The smoke run checks that typing reaches the program
 * on every platform, both for a native program and for a JavaScript one run
 * by the IDE's own executable (`ELECTRON_RUN_AS_NODE`, how agents installed
 * by the IDE start).
 *
 * On Windows the second case is known to fail (the GUI executable gets no
 * console: nothing printed, no keyboard; seen on windows-latest), which is
 * why sign-ins never run that way there (`nativeLoginProgram`,
 * `consoleLoginProgram`). It is still run and reported, not required.
 */
export interface ProgramInputCase {
    readonly name: string;
    /** The program printed its prompt. */
    readonly prompted: boolean;
    /** It printed back what was typed. */
    readonly answered: boolean;
    readonly output: string;
    readonly error?: string;
}

const NODE_SCRIPT = "process.stdout.write('ready>');process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',(d)=>{s+=d;const m=/^(.*?)[\\r\\n]/.exec(s);if(m){process.stdout.write('\\ngot:'+m[1]+'\\n');process.exit(0);}});";

function nativeCase(platform: NodeJS.Platform, env: Record<string, string>): { file: string; args: string[] } {
    if (platform === 'win32') {
        const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows';
        return { file: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: ['-NoLogo', '-NoProfile', '-Command', "$x = Read-Host 'ready>'; Write-Output ('got:' + $x)"] };
    }
    return { file: '/bin/sh', args: ['-c', 'printf "ready>"; read x; echo "got:$x"'] };
}

async function runCase(host: TerminalHost, contents: WebContents, cwd: string, name: string, program: { file: string; args: string[]; env: Record<string, string> }): Promise<ProgramInputCase> {
    let output = '';
    let exited = false;
    try {
        const created = await host.runProgram(contents, { ...program, name: `smoke ${name}` }, cwd, 80, 24, {
            onData: (data) => {
                output += data;
            },
            onExit: () => {
                exited = true;
            },
        });
        const wait = async (test: () => boolean, ms: number): Promise<boolean> => {
            const until = Date.now() + ms;
            while (!test() && Date.now() < until) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return test();
        };
        const prompted = await wait(() => output.includes('ready>'), 30000);
        host.input(contents, created.id, 'codexr-ping\r');
        const answered = await wait(() => output.includes('got:codexr-ping'), 15000);
        if (!exited) {
            host.kill(contents, created.id);
        }
        return { name, prompted, answered, output: output.slice(-400) };
    } catch (error) {
        return { name, prompted: false, answered: false, output: output.slice(-400), error: error instanceof Error ? error.message : String(error) };
    }
}

export async function probeProgramInput(host: TerminalHost, contents: WebContents, cwd: string): Promise<ProgramInputCase[]> {
    const env = terminalEnvironment(process.env);
    return [
        await runCase(host, contents, cwd, 'native', { ...nativeCase(process.platform, env), env }),
        await runCase(host, contents, cwd, 'node-in-ide', { file: process.execPath, args: ['-e', NODE_SCRIPT], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }),
    ];
}
