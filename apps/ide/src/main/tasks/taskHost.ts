import type { IpcMainInvokeEvent, WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { settingOf } from '../../shared/settings.ts';
import {
    findProgram, interpreterFor, makeTasks, NODE_INTERPRETER_SETTING, npmTasks, packageManagerOf, PYTHON_INTERPRETER_SETTING,
    RESTRICTED_TASKS_MESSAGE, shellCommand, TASK_IPC_CHANNELS, TASK_IPC_EVENTS, USER_TASKS_PATH, USER_TASKS_TEMPLATE, userTasks,
    type ProblemMatcherName, type TaskDefinition, type TaskList, type TaskStarted,
} from '../../shared/tasks.ts';
import { log } from '../log.ts';
import type { SettingsService } from '../settings/settingsService.ts';
import type { TerminalHost } from '../terminal/terminalHost.ts';
import { isWorkspaceTrusted } from '../trust/workspaceTrust.ts';
import type { Workspace } from '../workspace/workspace.ts';
import { workspaceOrNull } from '../workspace/workspaceWindows.ts';
import { matchProblems } from './problemMatchers.ts';

type Handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

/**
 * #176: tasks in the main process. The renderer names a task by the id this
 * listed, or a file by its workspace path; the command line is always built
 * here, from the folder's own files, and runs only in a trusted folder (#177).
 * Each task gets a terminal of its own (#137), whose output is kept (capped)
 * for the problem matchers until it exits.
 */

const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
const MAX_MATCHED_OUTPUT = 4 * 1024 * 1024;

export function registerTaskHandlers(handle: Handle, terminal: TerminalHost, settings: SettingsService): void {
    handle(TASK_IPC_CHANNELS.tasksList, (event) => listTasks(event.sender, terminal));
    handle(TASK_IPC_CHANNELS.tasksRun, async (event, taskId, cols, rows) => {
        const workspace = requireTrusted(event.sender);
        const { tasks } = await detectTasks(workspace, await terminal.defaultShellPath());
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (!task) {
            throw new Error('That task is no longer in the folder.');
        }
        return start(event.sender, terminal, workspace, task.label, task.command, task.problemMatchers, cols, rows);
    });
    handle(TASK_IPC_CHANNELS.tasksRunFile, async (event, file, cols, rows) => {
        const workspace = requireTrusted(event.sender);
        const absolute = await workspace.runnableFile(file);
        const report = await settings.snapshot(workspace);
        const configured = {
            [PYTHON_INTERPRETER_SETTING]: settingOf<string>(report, PYTHON_INTERPRETER_SETTING),
            [NODE_INTERPRETER_SETTING]: settingOf<string>(report, NODE_INTERPRETER_SETTING),
        };
        const interpreter = interpreterFor(absolute, process.platform, configured);
        if (!interpreter) {
            throw new Error(`Nothing is set up to run ${path.basename(absolute)}.`);
        }
        const program = await findProgram(interpreter.program, process.env, process.platform, isFile);
        if (!program) {
            const where = interpreter.setting ? ` Set it in Settings (${interpreter.setting}).` : '';
            throw new Error(`${interpreter.program} was not found on PATH.${where}`);
        }
        const shell = await terminal.defaultShellPath();
        const command = shellCommand(shell, [program, ...interpreter.args, absolute]);
        return start(event.sender, terminal, workspace, path.basename(absolute), command, [], cols, rows);
    });
    handle(TASK_IPC_CHANNELS.tasksConfigure, async (event) => {
        const workspace = workspaceOrNull(event.sender);
        if (!workspace) {
            throw new Error('Open a folder to configure its tasks.');
        }
        const existing = await workspace.readFile(USER_TASKS_PATH).then(() => true, () => false);
        if (!existing) {
            const [dir = '', name = ''] = USER_TASKS_PATH.split('/');
            await workspace.createEntry('', dir, 'directory').catch(() => undefined);
            await workspace.createEntry(dir, name, 'file').catch(() => undefined);
            await workspace.writeFile(USER_TASKS_PATH, USER_TASKS_TEMPLATE);
        }
        return USER_TASKS_PATH;
    });
}

function requireTrusted(contents: WebContents): Workspace {
    const workspace = workspaceOrNull(contents);
    if (!workspace) {
        throw new Error('Open a folder to run its tasks.');
    }
    if (!isWorkspaceTrusted(contents)) {
        throw new Error(RESTRICTED_TASKS_MESSAGE);
    }
    return workspace;
}

async function listTasks(contents: WebContents, terminal: TerminalHost): Promise<TaskList> {
    const workspace = workspaceOrNull(contents);
    if (!workspace) {
        return { trusted: false, tasks: [], errors: [] };
    }
    const detected = await detectTasks(workspace, await terminal.defaultShellPath());
    return { trusted: isWorkspaceTrusted(contents), ...detected };
}

/** Reads the three sources of the folder's root; one that cannot be read is reported and skipped. */
export async function detectTasks(workspace: Workspace, shellPath: string): Promise<{ tasks: TaskDefinition[]; errors: string[] }> {
    const names = new Set((await workspace.listDirectory('').catch(() => [])).filter((entry) => entry.kind === 'file').map((entry) => entry.name));
    const read = async (file: string): Promise<string | null> => {
        const content = await workspace.readFile(file).catch(() => null);
        return content?.kind === 'text' ? content.text : null;
    };
    const tasks: TaskDefinition[] = [];
    const errors: string[] = [];
    const collect = (build: () => TaskDefinition[]): void => {
        try {
            tasks.push(...build());
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    };
    const user = await read(USER_TASKS_PATH);
    if (user !== null) {
        collect(() => userTasks(user));
    }
    if (names.has('package.json')) {
        const text = await read('package.json');
        if (text !== null) {
            collect(() => npmTasks(text, packageManagerOf(names), shellPath));
        }
    }
    const makefile = MAKEFILES.find((name) => names.has(name));
    if (makefile) {
        const text = await read(makefile);
        if (text !== null) {
            collect(() => makeTasks(text, shellPath));
        }
    }
    return { tasks, errors };
}

async function start(
    contents: WebContents,
    terminal: TerminalHost,
    workspace: Workspace,
    label: string,
    command: string,
    matchers: readonly ProblemMatcherName[],
    cols: unknown,
    rows: unknown,
): Promise<TaskStarted> {
    let output = '';
    const created = await terminal.runCommand(contents, command, workspace.root, cols, rows, {
        onData: (data) => {
            if (matchers.length > 0 && output.length < MAX_MATCHED_OUTPUT) {
                output += data;
            }
        },
        onExit: (id, exitCode) => {
            log.info(`Task "${label}" exited with code ${exitCode}`);
            if (contents.isDestroyed()) {
                return;
            }
            const problems = matchers.length > 0 ? matchProblems(output, matchers, workspace.root) : null;
            contents.send(TASK_IPC_EVENTS.tasksFinished, { id, label, exitCode, problems });
        },
    });
    log.info(`Task "${label}": ${command}`);
    return { ...created, label, command };
}

function isFile(file: string): Promise<boolean> {
    return fs.promises.stat(file).then((stat) => stat.isFile(), () => false);
}
