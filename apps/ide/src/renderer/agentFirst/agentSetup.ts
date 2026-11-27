import type { AgentSessionsApi, AgentView, ImportableSession, InstallDescription } from '../../shared/agentSession.ts';
import type { TerminalCreated } from '../../shared/api.ts';
import { el } from '../dom.ts';
import { describeRows, importedWhen, isUpToDate, setupActions } from './agentSetupModel.ts';

/**
 * The actions of one agent (AF1, AF2 #267), shared by the Agents section of
 * the Chats view and the first-run guide (AF13 #278): sign in, check, and for
 * the presets Install, Update and Remove.
 *
 * Install and Update first read the registry (only now, because the person
 * pressed the button) and show inline what would be installed; the install
 * itself then asks again in a native dialog of the main process, which the
 * page cannot answer, and only that dialog starts the download.
 */

export interface AgentSetupDeps {
    readonly api: AgentSessionsApi;
    onStatus(message: string): void;
    /** #297: runs a terminal sign-in in a terminal of its own in the panel (`TerminalPanel.runTask`). */
    runInTerminal?(label: string, start: (cols: number, rows: number) => Promise<TerminalCreated>): Promise<number | null>;
    /** Reloads the agents (and probes them when asked). */
    refresh(probe: boolean): Promise<void>;
    /** One agent's new view, after a check. */
    replace(view: AgentView): void;
}

/** The buttons of an agent and, below them, the slot where an install description opens. */
export function agentActions(agent: AgentView, deps: AgentSetupDeps): HTMLElement {
    const buttons = el('span', { className: 'af-agent-actions' });
    const panel = el('div', { className: 'af-install', attrs: { hidden: '', 'data-testid': 'af-install' } });
    const button = (text: string, title: string, run: (self: HTMLButtonElement) => void, extra = ''): HTMLButtonElement => {
        const self = el('button', { className: `secondary-button af-small-button${extra}`, text, attrs: { type: 'button', title, 'data-action': text.toLowerCase() } });
        self.addEventListener('click', (event) => {
            event.stopPropagation();
            run(self);
        });
        buttons.append(self);
        return self;
    };

    for (const action of setupActions(agent)) {
        if (action === 'login') {
            for (const method of (agent.authMethods ?? []).slice(0, 3)) {
                button(method.name, method.description ?? method.name, () => {
                    if (method.type === 'terminal' && deps.runInTerminal) {
                        // #297: the login program gets a terminal of its own in the panel, shown at once.
                        const label = `${agent.name}: ${method.name}`;
                        deps.runInTerminal(label, (cols, rows) => deps.api.login(agent.ref, method.id, cols, rows).then((opened) => {
                            if (!opened) {
                                throw new Error('The agent did not start a sign-in.');
                            }
                            return { ...opened.terminal, command: opened.command };
                        }))
                            .then((id) => {
                                if (id !== null) {
                                    deps.onStatus(`${agent.name}: follow the sign-in in the terminal. The agent is checked again when it ends.`);
                                }
                            })
                            .catch((error: unknown) => deps.onStatus(errorText(error)));
                        return;
                    }
                    deps.onStatus(`${agent.name}: signing in, follow the browser if it opens...`);
                    deps.api.login(agent.ref, method.id)
                        .then(() => {
                            deps.onStatus(`${agent.name}: signed in.`);
                            return deps.refresh(true);
                        })
                        .catch((error: unknown) => deps.onStatus(errorText(error)));
                });
            }
        } else if (action === 'check') {
            button('Check', 'Start the agent once to see whether it is ready', (self) => {
                self.disabled = true;
                self.textContent = 'Checking...';
                deps.api.probeAgent(agent.ref)
                    .then((view) => deps.replace(view))
                    .catch((error: unknown) => {
                        deps.onStatus(errorText(error));
                        self.disabled = false;
                        self.textContent = 'Check';
                    });
            });
        } else if (action === 'import') {
            button('Import chats', `Bring the chats ${agent.name} already has for this folder into the list`, (self) => {
                self.disabled = true;
                self.textContent = 'Looking...';
                const reset = (): void => {
                    self.disabled = false;
                    self.textContent = 'Import chats';
                };
                deps.api.listImportable(agent.ref)
                    .then((found) => showImport(panel, agent, found, deps, reset))
                    .catch((error: unknown) => {
                        reset();
                        showError(panel, `Could not read ${agent.name}'s chats: ${errorText(error)}`);
                    });
            });
        } else if (action === 'install' || action === 'update') {
            const label = action === 'install' ? 'Install' : 'Update';
            button(label, action === 'install' ? `See what installing ${agent.name} downloads, then confirm` : `See whether a newer ${agent.name} exists`, (self) => {
                if (!agent.preset) {
                    return;
                }
                const presetId = agent.preset;
                self.disabled = true;
                self.textContent = 'Reading the registry...';
                deps.api.describeInstall(presetId)
                    .then((description) => showDescription(panel, description, deps, () => {
                        self.disabled = false;
                        self.textContent = label;
                    }))
                    .catch((error: unknown) => {
                        self.disabled = false;
                        self.textContent = label;
                        showError(panel, `Could not read what ${agent.name} would install: ${errorText(error)}`);
                    });
            }, action === 'install' ? ' af-install-button' : '');
        } else if (action === 'remove') {
            button('Remove', `Remove ${agent.name} (${agent.installedVersion ?? ''}) from the IDE's folder`, (self) => {
                if (!agent.preset) {
                    return;
                }
                self.disabled = true;
                deps.api.uninstall(agent.preset)
                    .then((removed) => {
                        deps.onStatus(removed ? `${agent.name} was removed.` : 'Nothing was removed.');
                        return deps.refresh(false);
                    })
                    .catch((error: unknown) => showError(panel, `Could not remove ${agent.name}: ${errorText(error)}`))
                    .finally(() => {
                        self.disabled = false;
                    });
            }, ' is-danger');
        }
    }
    return el('div', { className: 'af-agent-setup' }, [buttons, panel]);
}

function showError(panel: HTMLElement, message: string): void {
    panel.hidden = false;
    panel.replaceChildren(el('p', { className: 'af-install-error', text: message, attrs: { role: 'alert' } }));
}

/** #298: the agent's earlier chats with a box each; the chosen ones are added to the list. */
function showImport(panel: HTMLElement, agent: AgentView, found: readonly ImportableSession[], deps: AgentSetupDeps, reset: () => void): void {
    const close = (): void => {
        panel.hidden = true;
        panel.replaceChildren();
        reset();
    };
    const cancel = el('button', { className: 'secondary-button af-small-button', text: found.length ? 'Cancel' : 'Close', attrs: { type: 'button' } });
    cancel.addEventListener('click', (event) => {
        event.stopPropagation();
        close();
    });
    panel.hidden = false;
    if (found.length === 0) {
        panel.replaceChildren(
            el('p', { className: 'muted af-install-note', text: `${agent.name} has no other chats for this folder.` }),
            el('div', { className: 'af-install-actions' }, [cancel]),
        );
        return;
    }
    const boxes = found.map((session) => {
        const box = el('input', { attrs: { type: 'checkbox', checked: '', 'data-id': session.agentSessionId } });
        const when = importedWhen(session.updatedAt);
        return { session, box, row: el('label', { className: 'af-import-row' }, [box, el('span', { className: 'af-import-title', text: session.title }), ...(when ? [el('span', { className: 'muted af-import-when', text: when })] : [])]) };
    });
    const go = el('button', { className: 'primary-button af-small-button', text: `Import ${found.length}`, attrs: { type: 'button', 'data-testid': 'af-import-confirm' } });
    const count = (): void => {
        const chosen = boxes.filter((entry) => entry.box.checked).length;
        go.textContent = `Import ${chosen}`;
        go.disabled = chosen === 0;
    };
    for (const entry of boxes) {
        entry.box.addEventListener('change', count);
    }
    go.addEventListener('click', (event) => {
        event.stopPropagation();
        go.disabled = true;
        cancel.disabled = true;
        const chosen = boxes.filter((entry) => entry.box.checked).map((entry) => entry.session);
        deps.api.importSessions(agent.ref, chosen)
            .then((added) => {
                deps.onStatus(added === 1 ? `1 chat of ${agent.name} imported. Its messages load when you open it.` : `${added} chats of ${agent.name} imported. Their messages load when you open them.`);
                close();
            })
            .catch((error: unknown) => {
                reset();
                showError(panel, `Could not import: ${errorText(error)}`);
            });
    });
    panel.replaceChildren(
        el('p', { className: 'af-install-title', text: `${agent.name}: chats for this folder` }),
        el('div', { className: 'af-import-list', attrs: { 'data-testid': 'af-import-list' } }, boxes.map((entry) => entry.row)),
        el('p', { className: 'muted af-install-note', text: `${agent.name} reads them from its own history; they stay there too.` }),
        el('div', { className: 'af-install-actions' }, [go, cancel]),
    );
}

function showDescription(panel: HTMLElement, description: InstallDescription, deps: AgentSetupDeps, reset: () => void): void {
    const upToDate = isUpToDate(description);
    const list = el('dl', { className: 'af-install-list' }, describeRows(description).flatMap(([term, value]) => [el('dt', { text: term }), el('dd', { text: value })]));
    const go = el('button', { className: 'primary-button af-small-button', text: description.installedVersion ? `Update to ${description.version}...` : 'Install...', attrs: { type: 'button', 'data-testid': 'af-install-confirm', title: 'Code-XR IDE asks you to confirm in a dialog before downloading anything' } });
    go.disabled = upToDate;
    const cancel = el('button', { className: 'secondary-button af-small-button', text: upToDate ? 'Close' : 'Cancel', attrs: { type: 'button' } });
    const note = el('p', { className: 'muted af-install-note', text: upToDate
        ? `${description.agentName} ${description.version} is the latest version.`
        : 'Installed into the IDE\'s own folder with your npm, nothing global. You confirm once more before the download starts.' });
    const close = (): void => {
        panel.hidden = true;
        panel.replaceChildren();
        reset();
    };
    cancel.addEventListener('click', (event) => {
        event.stopPropagation();
        close();
    });
    go.addEventListener('click', (event) => {
        event.stopPropagation();
        go.disabled = true;
        cancel.disabled = true;
        go.textContent = 'Waiting for your confirmation...';
        deps.api.install(description.presetId)
            .then((installed) => {
                deps.onStatus(installed ? `${description.agentName} ${description.version} is installed.` : 'The install was cancelled; nothing was downloaded.');
                close();
                return installed ? deps.refresh(true) : undefined;
            })
            .catch((error: unknown) => {
                reset();
                showError(panel, `${description.agentName} was not installed: ${errorText(error)}`);
            });
    });
    panel.hidden = false;
    panel.replaceChildren(
        el('p', { className: 'af-install-title', text: description.installedVersion ? `Update ${description.agentName} (${description.installedVersion} installed)` : `Install ${description.agentName}` }),
        list,
        note,
        el('div', { className: 'af-install-actions' }, [go, cancel]),
    );
}

export function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
