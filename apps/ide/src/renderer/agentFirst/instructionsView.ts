import { el } from '../dom.ts';
import { instructionEntries, otherRuleFiles, splitWorkspacePath, type InstructionEntry } from './instructionsModel.ts';

/**
 * The "Project instructions" section of the Chats view (AF11, #276): which
 * instruction files the open project has, a click to open one, and a click
 * to create a missing one from a short template. The agents read these files
 * themselves; Code-XR only helps write them.
 */

export interface InstructionsViewDeps {
    listFiles(): Promise<readonly string[]>;
    createEntry(parent: string, name: string, kind: 'file' | 'directory'): Promise<string>;
    writeFile(path: string, text: string): Promise<unknown>;
    openFile(path: string): void;
    hasFolder(): boolean;
    onStatus(message: string): void;
}

export interface InstructionsView {
    readonly element: HTMLElement;
    refresh(): Promise<void>;
}

export function createInstructionsView(deps: InstructionsViewDeps): InstructionsView {
    const list = el('ul', { className: 'af-instr-list', attrs: { 'data-testid': 'af-instructions' } });
    const note = el('p', { className: 'muted af-agents-note', text: 'Write the project\'s rules once: every agent reads its file at the start of a chat.' });
    const element = el('details', { className: 'af-agents af-instructions' }, [
        el('summary', { className: 'af-section-title' }, [el('span', { text: 'Project instructions' })]),
        list,
        note,
    ]);
    let generation = 0;

    async function create(entry: InstructionEntry): Promise<void> {
        const { parent, name } = splitWorkspacePath(entry.path);
        try {
            if (parent) {
                await deps.createEntry('', parent, 'directory').catch(() => undefined);
            }
            const path = await deps.createEntry(parent, name, 'file');
            await deps.writeFile(path, entry.template);
            deps.openFile(path);
            await refresh();
        } catch (error) {
            deps.onStatus(`Could not create ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async function refresh(): Promise<void> {
        const mine = ++generation;
        if (!deps.hasFolder()) {
            list.replaceChildren(el('li', { className: 'muted af-instr-empty', text: 'Open a folder to see its instructions.' }));
            return;
        }
        let files: readonly string[] = [];
        try {
            files = await deps.listFiles();
        } catch {
            files = [];
        }
        if (mine !== generation) {
            return;
        }
        const rows = instructionEntries(files).map((entry) => {
            const action = el('button', {
                className: 'af-link-button',
                text: entry.exists ? 'Open' : 'Create',
                attrs: { type: 'button', 'data-testid': `af-instr-${entry.exists ? 'open' : 'create'}`, title: entry.exists ? `Open ${entry.path}` : `Create ${entry.path} from a template` },
            });
            action.addEventListener('click', () => {
                if (entry.exists) {
                    deps.openFile(entry.path);
                } else {
                    void create(entry);
                }
            });
            return el('li', { className: 'af-instr', attrs: { 'data-exists': String(entry.exists) } }, [
                el('span', { className: 'af-instr-main' }, [
                    el('span', { className: 'af-instr-name', text: entry.label }),
                    el('span', { className: 'af-session-sub muted', text: `Read by ${entry.readBy}` }),
                ]),
                action,
            ]);
        });
        for (const path of otherRuleFiles(files)) {
            const open = el('button', { className: 'af-link-button', text: 'Open', attrs: { type: 'button' } });
            open.addEventListener('click', () => deps.openFile(path));
            rows.push(el('li', { className: 'af-instr', attrs: { 'data-exists': 'true' } }, [
                el('span', { className: 'af-instr-main' }, [el('span', { className: 'af-instr-name', text: path })]),
                open,
            ]));
        }
        list.replaceChildren(...rows);
    }

    return { element, refresh };
}
