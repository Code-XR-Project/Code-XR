import type { AgentChatEvent, AgentProfile, ApprovalRequest, EditReviewRequest, EditReviewResult, AgentsApi, ChatMessageView, ChatSession, ChatSessionSummary, ModelInfo, ProviderView, ToolInfo } from '../../shared/agents.ts';
import { el, icon } from '../dom.ts';
import { createAttachmentBar, labelOf, type AttachmentSources } from './chatAttachments.ts';
import { renderMarkdown } from './chatMarkdown.ts';
import { renderApproval, renderToolRuns, upsertToolRun } from './chatTools.ts';
import { createProvidersSection } from './providersSection.ts';

/**
 * The Agents view of the side bar (epic #189). Two faces in one pane:
 * - home: the folder's chats (A5), the agents (A4) and the providers (A1);
 * - chat: one conversation streaming from the main process (A3), with
 *   attachments (A6) and the tools the agent runs, risky ones after approval (A7).
 * Everything goes through `window.codexr.agents`; no key or provider call
 * ever happens here.
 */

const ICONS = {
    back: 'M15 5l-7 7 7 7',
    plus: 'M12 5v14M5 12h14',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    copy: 'M8 8h11v12H8zM5 16V4h11',
    download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
} as const;

export interface AgentsView {
    refresh(): Promise<void>;
    /** "Agents: Add AI Provider". */
    addProvider(): void;
    /** "Agents: New Chat": opens a chat with the first agent that has a provider. */
    newChat(): Promise<void>;
}

export function createAgentsView(container: HTMLElement, api: AgentsApi, callbacks: { onStatus(message: string): void; reviewEdit(request: EditReviewRequest): Promise<EditReviewResult>; showScene(): void } & Omit<AttachmentSources, 'onStatus'>): AgentsView {
    let agents: readonly AgentProfile[] = [];
    let toolCatalog: readonly ToolInfo[] | null = null;
    let providers: readonly ProviderView[] = [];
    let open: { session: ChatSession; transcript: HTMLElement; streaming: HTMLElement | null; streamTools: HTMLElement | null; streamText: string; render(): void } | null = null;

    const copy = (text: string): void => {
        navigator.clipboard.writeText(text).then(() => callbacks.onStatus('Copied to the clipboard.'), () => callbacks.onStatus('Could not copy.'));
    };
    const toolActions = {
        showScene: callbacks.showScene,
        copy,
        cancelRun: (runId: string): void => {
            if (open) {
                api.cancelRun(open.session.id, runId).catch((error: unknown) => callbacks.onStatus(errorText(error)));
            }
        },
    };
    const iconButton = (label: string, path: string, onClick: () => void): HTMLButtonElement => {
        const button = el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label } }, [icon(path)]);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick();
        });
        return button;
    };
    const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

    // ---- Home --------------------------------------------------------------
    const providersSection = createProvidersSection(api, { onStatus: callbacks.onStatus, onChanged: () => void refresh() });
    const agentSelect = el('select', { className: 'agents-input', attrs: { 'aria-label': 'Agent for a new chat', 'data-testid': 'agents-new-chat-agent' } });
    const newChatButton = el('button', { className: 'primary-button agents-inline-button', text: 'New chat', attrs: { type: 'button', 'data-action': 'new-chat' } });
    newChatButton.addEventListener('click', () => void startChat(agentSelect.value));
    const sessionList = el('ul', { className: 'agents-list', attrs: { 'data-testid': 'agents-sessions' } });
    const sessionEmpty = el('p', { className: 'muted side-note', text: 'No chats in this folder yet.' });
    const agentList = el('ul', { className: 'agents-list', attrs: { 'data-testid': 'agents-profiles' } });
    const agentFormSlot = el('div');
    const newAgentButton = el('button', { className: 'secondary-button agents-block-button', text: 'New agent', attrs: { type: 'button', 'data-action': 'new-agent' } });
    newAgentButton.addEventListener('click', () => openAgentForm(null));

    const home = el('div', { className: 'agents-home' }, [
        el('h2', { className: 'side-bar-title', text: 'Agents' }),
        el('section', { className: 'agents-section', attrs: { 'aria-labelledby': 'agents-chats-heading' } }, [
            el('h3', { className: 'side-bar-subtitle', text: 'Chats', attrs: { id: 'agents-chats-heading' } }),
            el('div', { className: 'agents-new-chat' }, [agentSelect, newChatButton]),
            sessionList,
            sessionEmpty,
        ]),
        el('section', { className: 'agents-section', attrs: { 'aria-labelledby': 'agents-agents-heading' } }, [
            el('h3', { className: 'side-bar-subtitle', text: 'Agents', attrs: { id: 'agents-agents-heading' } }),
            agentList,
            agentFormSlot,
            newAgentButton,
        ]),
        providersSection.element,
    ]);
    const chatPane = el('div', { className: 'agents-chat', attrs: { hidden: '', 'data-testid': 'agents-chat' } });
    container.replaceChildren(home, chatPane);

    const providerOf = (agent: AgentProfile): ProviderView | undefined => providers.find((provider) => provider.id === agent.providerId);
    const ready = (agent: AgentProfile): boolean => providerOf(agent) !== undefined && agent.model !== '';
    const agentSummary = (agent: AgentProfile): string => {
        const provider = providerOf(agent);
        if (!provider) {
            return 'Needs a provider';
        }
        return agent.model ? `${provider.label} · ${agent.model}` : `${provider.label} · needs a model`;
    };

    async function refresh(): Promise<void> {
        const [nextProviders, nextAgents, sessions] = await Promise.all([api.listProviders(), api.listAgents(), api.listSessions(), providersSection.refresh()]);
        providers = nextProviders;
        agents = nextAgents;
        const previous = agentSelect.value;
        agentSelect.replaceChildren(...agents.map((agent) => el('option', { text: ready(agent) ? agent.name : `${agent.name} (not set up)`, attrs: { value: agent.id } })));
        agentSelect.value = agents.some((agent) => agent.id === previous) ? previous : agents.find(ready)?.id ?? agents[0]?.id ?? '';
        newChatButton.disabled = agents.length === 0;
        renderSessions(sessions);
        renderAgents();
    }

    function renderSessions(sessions: readonly ChatSessionSummary[]): void {
        sessionEmpty.hidden = sessions.length > 0;
        sessionList.replaceChildren(...sessions.map((session) => {
            const agent = agents.find((candidate) => candidate.id === session.agentId);
            const row = el('li', { className: 'agents-row', attrs: { tabindex: '0', role: 'button', 'data-session-id': session.id, title: session.title } }, [
                el('span', { className: 'agents-row-main' }, [
                    el('span', { className: 'agents-row-title', text: session.title }),
                    el('span', { className: 'agents-row-sub muted', text: `${agent?.name ?? 'Deleted agent'} · ${formatWhen(session.updatedAt)}` }),
                ]),
                el('span', { className: 'agents-row-actions' }, [
                    iconButton('Rename chat', ICONS.edit, () => renameInline(row, session)),
                    iconButton('Delete chat', ICONS.trash, () => {
                        if (window.confirm(`Delete the chat "${session.title}"?`)) {
                            api.deleteSession(session.id).then(() => refresh(), (error: unknown) => callbacks.onStatus(errorText(error)));
                        }
                    }),
                ]),
            ]);
            const openIt = (): void => void openChat(session.id);
            row.addEventListener('click', openIt);
            row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openIt();
                }
            });
            return row;
        }));
    }

    /** Rename in place (Electron has no window.prompt): Enter saves, Escape cancels. */
    function renameInline(row: HTMLElement, session: ChatSessionSummary): void {
        const titleNode = row.querySelector('.agents-row-title');
        if (!titleNode) {
            return;
        }
        const input = el('input', { className: 'tree-input', attrs: { type: 'text', maxlength: '100', 'aria-label': 'Chat title' } });
        input.value = session.title;
        let done = false;
        const finish = (save: boolean): void => {
            if (done) {
                return;
            }
            done = true;
            if (save && input.value.trim() && input.value.trim() !== session.title) {
                api.renameSession(session.id, input.value).then(() => refresh(), (error: unknown) => callbacks.onStatus(errorText(error)));
            } else {
                void refresh();
            }
        };
        input.addEventListener('click', (event) => event.stopPropagation());
        input.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
                finish(true);
            } else if (event.key === 'Escape') {
                finish(false);
            }
        });
        input.addEventListener('blur', () => finish(true));
        titleNode.replaceWith(input);
        input.select();
    }

    function renderAgents(): void {
        agentList.replaceChildren(...agents.map((agent) => el('li', { className: 'agents-row is-static', attrs: { 'data-agent-id': agent.id } }, [
            el('span', { className: 'agents-row-main' }, [
                el('span', { className: 'agents-row-title', text: agent.name }),
                el('span', { className: ready(agent) ? 'agents-row-sub muted' : 'agents-row-sub agents-warn', text: agentSummary(agent) }),
            ]),
            el('span', { className: 'agents-row-actions is-visible' }, [
                iconButton(`Edit ${agent.name}`, ICONS.edit, () => openAgentForm(agent)),
                iconButton(`Duplicate ${agent.name}`, ICONS.copy, () => {
                    const { id: _id, ...rest } = agent;
                    api.saveAgent({ ...rest, name: `${agent.name} copy`.slice(0, 60) }).then(() => refresh(), (error: unknown) => callbacks.onStatus(errorText(error)));
                }),
                iconButton(`Delete ${agent.name}`, ICONS.trash, () => {
                    if (window.confirm(`Delete the agent "${agent.name}"? Its chats stay, but cannot continue.`)) {
                        api.removeAgent(agent.id).then(() => refresh(), (error: unknown) => callbacks.onStatus(errorText(error)));
                    }
                }),
            ]),
        ])));
    }

    /** The agent form (A4): provider, model (listed from the provider), instructions, temperature. */
    function openAgentForm(existing: AgentProfile | null): void {
        newAgentButton.hidden = true;
        const name = el('input', { className: 'agents-input', attrs: { id: 'agent-name', type: 'text', maxlength: '60', autocomplete: 'off' } });
        name.value = existing?.name ?? '';
        const provider = el('select', { className: 'agents-input', attrs: { id: 'agent-provider', 'data-testid': 'agent-provider' } }, [
            el('option', { text: providers.length ? 'Choose a provider' : 'Add a provider below first', attrs: { value: '' } }),
            ...providers.map((candidate) => el('option', { text: candidate.label, attrs: { value: candidate.id } })),
        ]);
        provider.value = existing?.providerId || providers[0]?.id || '';
        const model = el('input', { className: 'agents-input', attrs: { id: 'agent-model', type: 'text', list: 'agent-models', autocomplete: 'off', spellcheck: 'false', placeholder: 'Model id', 'data-testid': 'agent-model' } });
        model.value = existing?.model ?? '';
        const modelList = el('datalist', { attrs: { id: 'agent-models' } });
        const modelNote = el('p', { className: 'muted small agents-help' });
        const loadModels = (): void => {
            modelList.replaceChildren();
            modelNote.textContent = '';
            if (!provider.value) {
                return;
            }
            modelNote.textContent = 'Loading models…';
            api.testProvider(provider.value).then((result) => {
                if (result.ok) {
                    modelList.replaceChildren(...result.models.map((entry: ModelInfo) => el('option', { attrs: { value: entry.id, label: entry.label } })));
                    modelNote.textContent = `${result.models.length} models available; type to filter.`;
                } else {
                    modelNote.textContent = `Could not list models: ${result.error}`;
                }
            }, (error: unknown) => { modelNote.textContent = errorText(error); });
        };
        provider.addEventListener('change', loadModels);
        loadModels();
        const instructions = el('textarea', { className: 'agents-input agents-textarea', attrs: { id: 'agent-instructions', rows: '5', spellcheck: 'true' } });
        instructions.value = existing?.instructions ?? '';
        const temperature = el('input', { className: 'agents-input', attrs: { id: 'agent-temperature', type: 'number', min: '0', max: '2', step: '0.1', placeholder: 'Provider default' } });
        temperature.value = existing?.temperature !== undefined ? String(existing.temperature) : '';
        const parallel = el('input', { className: 'agents-input', attrs: { id: 'agent-parallel', type: 'number', min: '1', max: '8', step: '1', placeholder: '3', title: 'How many sub-agents delegate_task may run at once' } });
        parallel.value = existing?.maxParallel !== undefined ? String(existing.maxParallel) : '';
        const toolBoxes = el('fieldset', { className: 'agents-tools', attrs: { 'data-testid': 'agent-tools' } }, [el('legend', { text: 'Tools' })]);
        const chosen = new Set(existing?.tools ?? []);
        const fillTools = (catalog: readonly ToolInfo[]): void => {
            toolBoxes.append(...catalog.map((tool) => {
                const box = el('input', { attrs: { type: 'checkbox', value: tool.name, 'data-tool': tool.name } });
                // A new agent starts with every read-only tool, like the starters; delegating (A11) is opt-in.
                box.checked = existing ? chosen.has(tool.name) : tool.risk === 'read' && tool.name !== 'delegate_task';
                const always = (existing?.alwaysAllow ?? []).includes(tool.name);
                const note = tool.risk === 'read' ? 'runs without asking' : always ? 'always allowed' : 'asks first';
                return el('label', { className: 'agents-tool', attrs: { title: tool.description } }, [
                    box,
                    el('span', { className: 'agents-tool-main' }, [el('span', { text: tool.title }), el('span', { className: 'muted small', text: ` · ${note}` })]),
                ]);
            }));
            if (existing?.alwaysAllow?.length) {
                const reset = el('button', { className: 'link-button small', text: 'Ask again before every risky tool', attrs: { type: 'button' } });
                reset.addEventListener('click', () => {
                    resetAlways = true;
                    reset.textContent = 'Will ask again after saving.';
                    reset.disabled = true;
                });
                toolBoxes.append(reset);
            }
        };
        let resetAlways = false;
        if (toolCatalog) {
            fillTools(toolCatalog);
        } else {
            api.tools().then((catalog) => { toolCatalog = catalog; fillTools(catalog); }, (failure: unknown) => toolBoxes.append(el('p', { className: 'error small', text: errorText(failure) })));
        }
        const error = el('p', { className: 'error small', attrs: { hidden: '', role: 'alert' } });
        const save = el('button', { className: 'primary-button', text: existing ? 'Save' : 'Create', attrs: { type: 'submit' } });
        const cancel = el('button', { className: 'secondary-button', text: 'Cancel', attrs: { type: 'button' } });
        const field = (label: string, id: string, ...controls: Node[]): HTMLElement =>
            el('div', { className: 'agents-field' }, [el('label', { text: label, attrs: { for: id } }), ...controls]);
        const form = el('form', { className: 'agents-form', attrs: { 'aria-label': existing ? `Edit ${existing.name}` : 'New agent' } }, [
            field('Name', 'agent-name', name),
            field('Provider', 'agent-provider', provider),
            field('Model', 'agent-model', model, modelList, modelNote),
            field('Instructions', 'agent-instructions', instructions),
            field('Temperature', 'agent-temperature', temperature),
            field('Parallel sub-agents (delegate_task)', 'agent-parallel', parallel),
            toolBoxes,
            error,
            el('div', { className: 'env-actions' }, [save, cancel]),
        ]);
        const close = (): void => {
            agentFormSlot.replaceChildren();
            newAgentButton.hidden = false;
        };
        cancel.addEventListener('click', close);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            save.disabled = true;
            const temperatureValue = temperature.value.trim() === '' ? undefined : Number(temperature.value);
            api.saveAgent({
                name: name.value,
                providerId: provider.value,
                model: model.value.trim(),
                instructions: instructions.value,
                ...(temperatureValue !== undefined ? { temperature: temperatureValue } : {}),
                ...(parallel.value.trim() !== '' ? { maxParallel: Number(parallel.value) } : {}),
                tools: [...toolBoxes.querySelectorAll<HTMLInputElement>('input[data-tool]')].filter((box) => box.checked).map((box) => box.value),
                ...(existing?.alwaysAllow && !resetAlways ? { alwaysAllow: existing.alwaysAllow } : {}),
            }, existing?.id).then((saved) => {
                close();
                callbacks.onStatus(`Saved ${saved.name}.`);
                return refresh();
            }, (failure: unknown) => {
                error.hidden = false;
                error.textContent = errorText(failure);
            }).finally(() => { save.disabled = false; });
        });
        agentFormSlot.replaceChildren(form);
        name.focus();
    }

    // ---- Chat --------------------------------------------------------------
    async function startChat(agentId: string): Promise<void> {
        if (!agentId) {
            return;
        }
        try {
            const session = await api.createSession(agentId);
            showChat(session);
        } catch (error) {
            callbacks.onStatus(errorText(error));
        }
    }

    async function openChat(id: string): Promise<void> {
        try {
            showChat(await api.getSession(id));
        } catch (error) {
            callbacks.onStatus(errorText(error));
            void refresh();
        }
    }

    function showHome(): void {
        open = null;
        chatPane.hidden = true;
        home.hidden = false;
        void refresh();
    }

    function showChat(initial: ChatSession): void {
        const agent = agents.find((candidate) => candidate.id === initial.agentId);
        const title = el('span', { className: 'agents-chat-title', text: initial.title });
        const transcript = el('div', { className: 'agents-transcript', attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation', 'data-testid': 'agents-transcript' } });
        const input = el('textarea', { className: 'agents-input agents-chat-input', attrs: { rows: '3', placeholder: `Message ${agent?.name ?? 'the agent'} (Enter to send, Shift+Enter for a new line)`, 'aria-label': 'Message', 'data-testid': 'agents-chat-input' } });
        const send = el('button', { className: 'primary-button agents-inline-button', text: 'Send', attrs: { type: 'button', 'data-action': 'send' } });
        const meta = el('span', { className: 'muted small agents-chat-meta', text: agent ? agentSummary(agent) : 'Deleted agent' });
        const attachments = createAttachmentBar(input, { listFiles: callbacks.listFiles, activeSelection: callbacks.activeSelection, onStatus: callbacks.onStatus });

        const state = {
            session: initial,
            transcript,
            streaming: null as HTMLElement | null,
            streamTools: null as HTMLElement | null,
            streamText: '',
            render(): void {
                transcript.replaceChildren(...state.session.messages.map((message) => renderMessage(message)));
                if (state.session.messages.length === 0) {
                    transcript.append(el('p', { className: 'muted agents-chat-empty', text: agent && !ready(agent)
                        ? `${agent.name} is not set up yet: ${agentSummary(agent).toLowerCase()}. Edit it from the Agents list.`
                        : 'Ask anything about your code. Answers stream here; this chat is saved with the folder.' }));
                }
                transcript.scrollTop = transcript.scrollHeight;
            },
        };
        open = state;

        const running = (busy: boolean): void => {
            send.textContent = busy ? 'Stop' : 'Send';
            send.dataset['action'] = busy ? 'stop' : 'send';
            chatPane.setAttribute('aria-busy', String(busy));
        };
        const submit = (): void => {
            if (send.dataset['action'] === 'stop') {
                void api.stop(state.session.id);
                return;
            }
            const text = input.value;
            if (!text.trim()) {
                return;
            }
            const attached = attachments.items();
            input.value = '';
            attachments.clear();
            const userTurn: ChatMessageView = { role: 'user', content: text, at: new Date().toISOString(), ...(attached.length > 0 ? { attachments: attached.map(labelOf) } : {}) };
            state.session = { ...state.session, messages: [...state.session.messages, userTurn] };
            state.render();
            running(true);
            api.send(state.session.id, text, attached).catch((error: unknown) => {
                input.value = text;
                for (const item of attached) {
                    attachments.restore(item);
                }
                callbacks.onStatus(errorText(error));
                state.session = { ...state.session, messages: state.session.messages.slice(0, -1) };
                state.render();
            }).finally(() => {
                running(false);
                void api.getSession(state.session.id).then((fresh) => {
                    if (open === state) {
                        state.session = fresh;
                        title.textContent = fresh.title;
                    }
                }, () => undefined);
                input.focus();
            });
        };
        send.addEventListener('click', submit);
        input.addEventListener('keydown', (event) => {
            if (attachments.handleKey(event)) {
                return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                submit();
            }
        });

        chatPane.replaceChildren(
            el('div', { className: 'agents-chat-header' }, [
                iconButton('Back to chats', ICONS.back, showHome),
                title,
                iconButton('Copy chat as Markdown', ICONS.download, () => {
                    api.exportSession(state.session.id).then(copy, (error: unknown) => callbacks.onStatus(errorText(error)));
                }),
                iconButton('New chat with this agent', ICONS.plus, () => void startChat(state.session.agentId)),
            ]),
            transcript,
            el('div', { className: 'agents-composer' }, [
                attachments.chips,
                el('div', { className: 'agents-composer-input' }, [attachments.popup, input]),
                el('div', { className: 'agents-composer-row' }, [meta, el('span', { className: 'agents-composer-actions' }, [attachments.attachButton, send])]),
            ]),
        );
        home.hidden = true;
        chatPane.hidden = false;
        state.render();
        running(initial.running);
        input.focus();
    }

    function renderMessage(message: ChatMessageView): HTMLElement {
        const isUser = message.role === 'user';
        const body = el('div', { className: 'agents-message-body' });
        if (isUser) {
            body.append(el('p', { className: 'chat-paragraph agents-user-text', text: message.content }));
            if (message.attachments?.length) {
                body.append(el('div', { className: 'chat-chips is-static', attrs: { 'aria-label': 'Attached' } }, message.attachments.map((label) => el('span', { className: 'chat-chip', attrs: { title: label } }, [el('span', { className: 'chat-chip-label', text: label })]))));
            }
        } else {
            if (message.toolRuns?.length) {
                body.append(renderToolRuns(message.toolRuns, toolActions));
            }
            body.append(renderMarkdown(message.content, { copy }));
        }
        const notes: HTMLElement[] = [];
        if (message.stopped) {
            notes.push(el('p', { className: 'muted small', text: 'Stopped.' }));
        }
        if (message.error) {
            notes.push(el('p', { className: 'error small agents-message-error', text: message.error, attrs: { role: 'alert' } }));
        }
        const footer = !isUser && message.usage
            ? [el('p', { className: 'muted small agents-usage', text: `${message.model ?? ''} · ${message.usage.inputTokens} in / ${message.usage.outputTokens} out tokens` })]
            : [];
        const actions = isUser || !message.content ? [] : [iconButton('Copy answer', ICONS.copy, () => copy(message.content))];
        return el('article', { className: `agents-message ${isUser ? 'is-user' : 'is-assistant'}`, attrs: { 'data-role': message.role } }, [
            el('div', { className: 'agents-message-head' }, [el('span', { className: 'agents-message-author', text: isUser ? 'You' : agentName(message) }), ...actions]),
            body,
            ...notes,
            ...footer,
        ]);
    }

    function agentName(_message: ChatMessageView): string {
        return agents.find((agent) => agent.id === open?.session.agentId)?.name ?? 'Agent';
    }

    api.onChat((event: AgentChatEvent) => {
        if (event.type === 'review') {
            // The diff opens over the editor whichever chat is on screen, so a review is never lost.
            callbacks.reviewEdit(event.request).then(
                (result) => api.resolveReview(event.request.id, result),
                (error: unknown) => api.resolveReview(event.request.id, { outcome: 'failed', accepted: 0, total: 0, message: errorText(error) }),
            ).catch((error: unknown) => callbacks.onStatus(errorText(error)));
            return;
        }
        if (event.type === 'approval' && open?.session.id !== event.sessionId) {
            // An approval for a chat that is not on screen: bring that chat up so the card can be answered.
            void openChat(event.sessionId).then(() => {
                if (open?.session.id === event.sessionId) {
                    addApproval(open.transcript, event.request);
                }
            });
            return;
        }
        const state = open;
        if (!state || event.sessionId !== state.session.id) {
            return;
        }
        if (event.type === 'start') {
            state.streamText = '';
            state.streamTools = el('div', { className: 'chat-tools', attrs: { 'aria-label': 'Tools used' } });
            state.streaming = el('div', { className: 'agents-message-body' });
            const article = el('article', { className: 'agents-message is-assistant is-streaming', attrs: { 'data-role': 'assistant' } }, [
                el('div', { className: 'agents-message-head' }, [el('span', { className: 'agents-message-author', text: agentName({ role: 'assistant', content: '', at: '' }) }), el('span', { className: 'muted small', text: event.model })]),
                ...(event.trimmed > 0 ? [el('p', { className: 'muted small', text: `The ${event.trimmed} oldest messages were left out to fit the model's context.` })] : []),
                state.streamTools,
                state.streaming,
            ]);
            state.transcript.append(article);
        } else if (event.type === 'delta' && state.streaming) {
            state.streamText += event.text;
            const nearBottom = state.transcript.scrollHeight - state.transcript.scrollTop - state.transcript.clientHeight < 60;
            state.streaming.replaceChildren(renderMarkdown(state.streamText, { copy }));
            if (nearBottom) {
                state.transcript.scrollTop = state.transcript.scrollHeight;
            }
        } else if (event.type === 'tool' && state.streamTools) {
            upsertToolRun(state.streamTools, event.run, toolActions);
        } else if (event.type === 'approval') {
            addApproval(state.streaming?.parentElement ?? state.transcript, event.request);
        } else if (event.type === 'end') {
            state.streaming = null;
            state.streamTools = null;
            state.session = { ...state.session, messages: [...state.session.messages, event.message] };
            state.render();
        }
    });

    function addApproval(parent: HTMLElement, request: ApprovalRequest): void {
        const card = renderApproval(request, (decision) => api.approve(request.id, decision).catch((error: unknown) => callbacks.onStatus(errorText(error))));
        parent.append(card);
        if (open) {
            open.transcript.scrollTop = open.transcript.scrollHeight;
        }
        card.querySelector('button')?.focus();
    }

    return {
        refresh,
        addProvider: () => {
            showHome();
            providersSection.addProvider();
        },
        async newChat(): Promise<void> {
            if (agents.length === 0) {
                await refresh();
            }
            const agent = agents.find(ready) ?? agents[0];
            if (agent) {
                await startChat(agent.id);
            }
        },
    };
}

function formatWhen(iso: string): string {
    const date = new Date(iso);
    const today = new Date();
    return date.toDateString() === today.toDateString()
        ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
