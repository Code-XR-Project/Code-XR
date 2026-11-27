/**
 * #176: Run Task, Run Current File and Configure Tasks in the window. The
 * main process lists the folder's tasks, builds every command line and
 * refuses to run anything in Restricted Mode (#177); this picks, saves the
 * file first, puts each run in a terminal tab of its own and reports how it
 * ended, with what its problem matchers found sent to the Problems panel.
 */
import type { CodeXRApi, TerminalCreated } from '../shared/api.ts';
import type { Problem } from '../shared/problems.ts';
import { RESTRICTED_TASKS_MESSAGE, USER_TASKS_PATH, type TaskDefinition } from '../shared/tasks.ts';
import type { NotificationCenter } from './notifications.ts';

const CONFIGURE_ID = '\u0000configure';

export interface TaskRunnerOptions {
    readonly api: CodeXRApi['tasks'];
    readonly notifications: NotificationCenter;
    readonly pick: (label: string, items: readonly { id: string; label: string; description?: string }[], apply: (id: string) => void) => void;
    readonly runInTerminal: (label: string, start: (cols: number, rows: number) => Promise<TerminalCreated>) => Promise<number | null>;
    readonly activeFile: () => string | null;
    /** Saves the active editor when it has unsaved changes, so the file that runs is the one on screen. */
    readonly saveActiveIfDirty: () => Promise<void>;
    readonly openFile: (path: string) => void;
    readonly manageTrust: () => void;
    readonly showProblems: (task: string, problems: readonly Problem[]) => void;
    readonly setStatus: (message: string) => void;
}

export interface TaskRunner {
    runTask(): void;
    runCurrentFile(): void;
    configure(): void;
}

export function createTaskRunner(options: TaskRunnerOptions): TaskRunner {
    const { api, notifications } = options;
    api.onFinished(({ label, exitCode, problems }) => {
        if (problems) {
            options.showProblems(label, problems);
        }
        const found = problems && problems.length > 0 ? ` ${problems.length} problem${problems.length === 1 ? '' : 's'} found.` : '';
        if (exitCode === 0) {
            options.setStatus(`Task "${label}" finished.${found}`);
        } else {
            notifications.notify('warning', `Task "${label}" failed with exit code ${exitCode}.${found}`);
        }
    });

    function restricted(): void {
        notifications.notify('warning', RESTRICTED_TASKS_MESSAGE, {
            actions: [{ label: 'Manage Workspace Trust', run: () => options.manageTrust() }],
        });
    }

    async function start(label: string, run: (cols: number, rows: number) => Promise<TerminalCreated>): Promise<void> {
        await options.runInTerminal(label, run);
    }

    function runTask(): void {
        api.list().then((list) => {
            for (const error of list.errors) {
                notifications.notify('error', error);
            }
            if (!list.trusted) {
                restricted();
                return;
            }
            const items = [
                ...list.tasks.map((task) => ({ id: task.id, label: task.label, description: describe(task) })),
                { id: CONFIGURE_ID, label: list.tasks.length === 0 ? 'No tasks found. Configure Tasks…' : 'Configure Tasks…', description: USER_TASKS_PATH },
            ];
            options.pick('Select the task to run', items, (id) => {
                if (id === CONFIGURE_ID) {
                    configure();
                    return;
                }
                const task = list.tasks.find((candidate) => candidate.id === id);
                if (task) {
                    void start(task.label, (cols, rows) => api.run(task.id, cols, rows));
                }
            });
        }, (error: unknown) => notifications.notify('error', `Could not list the tasks: ${message(error)}`));
    }

    function runCurrentFile(): void {
        const file = options.activeFile();
        if (!file) {
            options.setStatus('Open a file to run it.');
            return;
        }
        void api.list().then(async (list) => {
            if (!list.trusted) {
                restricted();
                return;
            }
            await options.saveActiveIfDirty();
            const name = file.split('/').pop() ?? file;
            await start(name, (cols, rows) => api.runFile(file, cols, rows));
        }).catch((error: unknown) => notifications.notify('error', `Could not run ${file}: ${message(error)}`));
    }

    function configure(): void {
        api.configure().then(options.openFile, (error: unknown) => notifications.notify('error', `Could not open ${USER_TASKS_PATH}: ${message(error)}`));
    }

    return { runTask, runCurrentFile, configure };
}

function describe(task: TaskDefinition): string {
    const source = task.source === 'user' ? USER_TASKS_PATH : task.source === 'make' ? 'Makefile' : 'package.json';
    return task.problemMatchers.length > 0 ? `${source} · ${task.problemMatchers.join(', ')}` : source;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
}
