import type { AgentSessionsApi, AgentView, InstallDescription } from '../../shared/agentSession.ts';
import { el } from '../dom.ts';
import { describeRows, isUpToDate, setupActions } from './agentSetupModel.ts';

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
    /** Shows the terminal panel (terminal sign-ins). */
    showTerminal?(): void;
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
                    deps.api.login(agent.ref, method.id)
                        .then(() => {
                            if (method.type === 'terminal') {
                                deps.showTerminal?.();
                                deps.onStatus(`${agent.name}: finish the sign-in in the terminal, then press Check.`);
                            } else {
                                deps.onStatus(`${agent.name}: signed in.`);
                            }
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
