import type { ChatAttachment } from '../../shared/agents.ts';
import {
    applySessionEvent, type AgentSessionMessage, type AgentSessionState, type AgentSessionsApi, type ConfigOptionView,
    type PlanEntryView, type PromptAttachment, type ToolContentView, type TranscriptItem,
} from '../../shared/agentSession.ts';
import { renderMarkdown } from '../agents/chatMarkdown.ts';
import { createAttachmentBar, type AttachmentSources } from '../agents/chatAttachments.ts';
import { el, icon } from '../dom.ts';
import {
    changeCounts, composerAction, diffLinesForCard, displayPath, formatTokens, lastUserIndex, slashSuggestions, TOOL_ICONS, toolStatusLabel, turnChanges,
} from './chatModel.ts';

/**
 * One agent chat (AF3, #268): a normal coding chat, the way the person works
 * with Claude Code, Codex, Gemini CLI or the built-in agent. It is drawn in an
 * editor tab of the agent-first workbench:
 * - the transcript: the person's messages, the agent's Markdown answers, its
 *   thinking (collapsed), a card per tool call (read, edit, run...) with its
 *   diff or terminal output, and approval cards;
 * - the agent's plan, pinned above the composer as a checklist;
 * - the composer: `@` attachments, the agent's slash commands, its modes and
 *   options (model, reasoning...), Send, Stop, and messages queued while the
 *   agent works.
 * The state is the shared `AgentSessionState`; every change arrives as a
 * `SessionEvent` and goes through the same reducer the main process uses.
 */

export interface ChatViewDeps {
    readonly api: AgentSessionsApi;
    readonly attachments: AttachmentSources;
    openFile(path: string, line?: number): void;
    copy(text: string): void;
    onStatus(message: string): void;
    /** Called whenever the title or status changes, so the tab and the sessions list follow. */
    onDidChange?(state: AgentSessionState): void;
    /** AF6: puts the project's files back as they were before a message. */
    restoreCheckpoint?(state: AgentSessionState, checkpointId: string): Promise<void>;
    /** AF5: opens the review of the chat's pending changes. */
    openChanges?(state: AgentSessionState): void;
    /** AF9: lets the analysis add its line under a finished turn. */
    decorateTurn?(state: AgentSessionState, turnStart: number, footer: HTMLElement): void;
}

export interface ChatView {
    readonly element: HTMLElement;
    readonly sessionId: string;
    readonly state: AgentSessionState | null;
    /** Feeds a message from the main process; ignored when it is for another session. */
    handle(message: AgentSessionMessage): void;
    focus(): void;
    /** Puts text in the composer (for "Ask about this selection" and the like). */
    insert(text: string): void;
    reload(): Promise<void>;
    dispose(): void;
}

const ICONS = {
    send: 'M5 12h14M13 6l6 6-6 6',
    stop: 'M7 7h10v10H7z',
    changes: 'M6 3v12M6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM18 9a3 3 0 1 0 0-6a3 3 0 1 0 0 6zM18 9c0 6-12 3-12 6',
    restore: 'M4 12a8 8 0 1 0 3-6.2M4 4v5h5',
    copy: 'M8 8h11v12H8zM5 16V4h11',
    chevron: 'M9 6l6 6-6 6',
} as const;

export function createChatView(sessionId: string, deps: ChatViewDeps): ChatView {
    let state: AgentSessionState | null = null;
    let disposed = false;
    const queue: { text: string; attachments: PromptAttachment[] }[] = [];
    const rendered = new Map<string, { item: TranscriptItem; node: HTMLElement }>();
    let frame = 0;

    // ---- Header ------------------------------------------------------------
    const title = el('h2', { className: 'af-chat-title', text: 'Chat' });
    const agentLabel = el('span', { className: 'af-chat-agent muted' });
    const statusPill = el('span', { className: 'af-status-pill', attrs: { 'data-testid': 'af-chat-status' } });
    const changesButton = el('button', { className: 'af-header-button', attrs: { type: 'button', hidden: '', 'data-testid': 'af-chat-changes' } }, [icon(ICONS.changes), el('span', { text: 'Changes' })]);
    changesButton.addEventListener('click', () => {
        if (state) {
            deps.openChanges?.(state);
        }
    });
    const usageMeter = el('span', { className: 'af-usage muted', attrs: { hidden: '', 'data-testid': 'af-chat-usage' } });
    const header = el('header', { className: 'af-chat-header' }, [
        el('div', { className: 'af-chat-heading' }, [title, el('div', { className: 'af-chat-sub' }, [agentLabel, statusPill])]),
        usageMeter,
        changesButton,
    ]);

    // ---- Transcript --------------------------------------------------------
    const transcript = el('div', { className: 'af-transcript', attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation', 'data-testid': 'af-transcript' } });
    const empty = el('div', { className: 'af-empty' }, [
        el('h3', { text: 'What do you want to build?' }),
        el('p', { className: 'muted', text: 'Describe a change, ask about the code, or type / for the agent\'s commands. Attach files with @. The live analysis on the right follows every change the agent makes.' }),
    ]);
    transcript.append(empty);
    let stickToBottom = true;
    transcript.addEventListener('scroll', () => {
        stickToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    });

    // ---- Plan --------------------------------------------------------------
    const planList = el('ol', { className: 'af-plan-list' });
    const planSummary = el('summary', { className: 'af-plan-summary' });
    const plan = el('details', { className: 'af-plan', attrs: { open: '', hidden: '', 'data-testid': 'af-plan' } }, [planSummary, planList]);

    // ---- Composer ----------------------------------------------------------
    const input = el('textarea', { className: 'af-input', attrs: { rows: '3', placeholder: 'Ask the agent to build, fix or explain something. @ to attach, / for commands.', 'aria-label': 'Message', 'data-testid': 'af-input' } });
    const bar = createAttachmentBar(input, deps.attachments);
    const slashPopup = el('ul', { className: 'chat-mention af-slash', attrs: { role: 'listbox', hidden: '', 'aria-label': 'Commands' } });
    let slashItems: ReturnType<typeof slashSuggestions> = [];
    let slashSelected = 0;
    const queueNote = el('p', { className: 'af-queue muted', attrs: { hidden: '', 'data-testid': 'af-queue' } });
    const modeSelect = el('select', { className: 'af-select', attrs: { 'aria-label': 'Agent mode', hidden: '', 'data-testid': 'af-mode' } });
    const optionsSlot = el('span', { className: 'af-options' });
    const sendButton = el('button', { className: 'af-send', attrs: { type: 'button', 'aria-label': 'Send', title: 'Send (Enter)', 'data-testid': 'af-send' } }, [icon(ICONS.send)]);
    const composer = el('div', { className: 'af-composer' }, [
        bar.chips,
        el('div', { className: 'af-input-wrap' }, [input, bar.popup, slashPopup]),
        queueNote,
        el('div', { className: 'af-composer-row' }, [bar.attachButton, modeSelect, optionsSlot, el('span', { className: 'af-spacer' }), sendButton]),
    ]);

    const element = el('section', { className: 'af-chat', attrs: { 'data-testid': 'af-chat', 'data-session': sessionId } }, [header, transcript, plan, composer]);

    // ---- Rendering ---------------------------------------------------------
    function schedule(): void {
        if (frame || disposed) {
            return;
        }
        frame = requestAnimationFrame(() => {
            frame = 0;
            render();
        });
    }

    function render(): void {
        if (!state) {
            return;
        }
        title.textContent = state.title;
        agentLabel.textContent = state.agentName;
        statusPill.textContent = statusText(state);
        statusPill.dataset['status'] = state.status;
        changesButton.hidden = state.pendingChanges === 0 || !deps.openChanges;
        changesButton.lastElementChild!.textContent = `Changes (${state.pendingChanges})`;
        usageMeter.hidden = !state.usage;
        if (state.usage) {
            usageMeter.textContent = `Context ${formatTokens(state.usage.used, state.usage.size)}`;
            usageMeter.title = `${state.usage.used.toLocaleString()} of ${state.usage.size.toLocaleString()} tokens of context used`;
        }
        renderItems(state);
        markStreaming(state);
        renderPlan(state.plan);
        renderControls(state);
        updateSendButton();
        if (stickToBottom) {
            transcript.scrollTop = transcript.scrollHeight;
        }
    }

    /** The caret sits on the reply being written, and only while the turn runs (rendered nodes are cached). */
    function markStreaming(current: AgentSessionState): void {
        for (const node of transcript.querySelectorAll('.af-message.is-streaming')) {
            node.classList.remove('is-streaming');
        }
        const last = current.items.at(-1);
        if (last?.kind === 'assistant' && current.status === 'running') {
            rendered.get(`assistant:${last.id}`)?.node.classList.add('is-streaming');
        }
    }

    function renderItems(current: AgentSessionState): void {
        empty.hidden = current.items.length > 0;
        const seen = new Set<string>();
        let previous: Node = empty;
        current.items.forEach((item, index) => {
            const key = `${item.kind}:${item.id}`;
            seen.add(key);
            const cached = rendered.get(key);
            let node: HTMLElement;
            if (cached && cached.item === item) {
                node = cached.node;
            } else {
                node = renderItem(item, index, current);
                if (cached) {
                    cached.node.replaceWith(node);
                }
                rendered.set(key, { item, node });
            }
            if (previous.nextSibling !== node) {
                transcript.insertBefore(node, previous.nextSibling);
            }
            previous = node;
        });
        for (const [key, entry] of rendered) {
            if (!seen.has(key)) {
                entry.node.remove();
                rendered.delete(key);
            }
        }
    }

    function renderItem(item: TranscriptItem, index: number, current: AgentSessionState): HTMLElement {
        switch (item.kind) {
            case 'user': {
                const actions = el('div', { className: 'af-message-actions' });
                if (item.checkpoint && deps.restoreCheckpoint) {
                    const restore = el('button', { className: 'af-link-button', attrs: { type: 'button', title: 'Put the project\'s files back as they were before this message. The conversation is kept; effects of commands (network, databases) are not undone.', 'data-testid': 'af-restore' } }, [icon(ICONS.restore), el('span', { text: 'Restore files to here' })]);
                    const checkpoint = item.checkpoint;
                    restore.addEventListener('click', () => {
                        if (state) {
                            deps.restoreCheckpoint?.(state, checkpoint).catch((error: unknown) => deps.onStatus(errorText(error)));
                        }
                    });
                    actions.append(restore);
                }
                const chips = item.attachments?.length
                    ? el('div', { className: 'chat-chips is-static' }, item.attachments.map((label) => el('span', { className: 'chat-chip', attrs: { title: label } }, [el('span', { className: 'chat-chip-label', text: label })])))
                    : null;
                return el('div', { className: 'af-message is-user', attrs: { 'data-testid': 'af-user' } }, [
                    el('p', { className: 'af-user-text', text: item.text }),
                    ...(chips ? [chips] : []),
                    actions,
                ]);
            }
            case 'assistant': {
                const body = el('div', { className: 'af-message-body' });
                body.append(renderMarkdown(item.text, { copy: deps.copy }));
                return el('div', { className: 'af-message is-assistant', attrs: { 'data-testid': 'af-assistant' } }, [body]);
            }
            case 'thought':
                return el('details', { className: 'af-thought' }, [
                    el('summary', { text: 'Thinking' }),
                    el('div', { className: 'af-thought-body', text: item.text }),
                ]);
            case 'tool':
                return renderTool(item, current);
            case 'permission':
                return renderPermission(item);
            case 'notice':
                return el('p', { className: `af-notice is-${item.level}`, text: item.text, attrs: { role: item.level === 'error' ? 'alert' : 'note' } });
            case 'turn-end':
                return renderTurnEnd(item, index, current);
        }
    }

    function renderTool(item: Extract<TranscriptItem, { kind: 'tool' }>, current: AgentSessionState): HTMLElement {
        const location = item.locations[0];
        const head = el('summary', { className: 'af-tool-head' }, [
            icon(ICONS.chevron, 'af-tool-chevron'),
            icon(TOOL_ICONS[item.toolKind], 'af-tool-icon'),
            el('span', { className: 'af-tool-title', text: item.title }),
            ...(location ? [fileLink(location.path, location.line, current.workspaceRoot)] : []),
            el('span', { className: 'af-tool-status', text: toolStatusLabel(item.status), attrs: { 'data-status': item.status } }),
        ]);
        const body = el('div', { className: 'af-tool-body' });
        for (const block of item.content) {
            body.append(renderToolContent(block, current.workspaceRoot));
        }
        if (item.rawInput && item.content.length === 0) {
            body.append(el('pre', { className: 'af-tool-raw', text: item.rawInput }));
        }
        // Edits and running commands open by default: they are what the person reviews.
        const open = item.content.some((block) => block.type === 'diff' || block.type === 'terminal') || item.status === 'failed';
        const card = el('details', { className: 'af-tool', attrs: { 'data-kind': item.toolKind, 'data-status': item.status, 'data-testid': 'af-tool' } }, [head, body]);
        card.open = open;
        return card;
    }

    function renderToolContent(block: ToolContentView, root: string | null): HTMLElement {
        switch (block.type) {
            case 'text': {
                const wrap = el('div', { className: 'af-tool-text' });
                wrap.append(renderMarkdown(block.text, { copy: deps.copy }));
                return wrap;
            }
            case 'diff': {
                const counts = changeCounts(block.oldText, block.newText);
                const lines = diffLinesForCard(block.oldText, block.newText);
                const pre = el('pre', { className: 'af-diff' }, lines.map((line) => el('span', {
                    className: `af-diff-line is-${line.kind}`,
                    text: line.kind === 'gap' ? (line.text || '...') : `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '} ${line.text}`,
                })));
                return el('div', { className: 'af-diff-block' }, [
                    el('div', { className: 'af-diff-head' }, [
                        fileLink(block.path, undefined, root),
                        el('span', { className: 'af-diff-counts' }, [el('span', { className: 'is-add', text: `+${counts.added}` }), el('span', { className: 'is-remove', text: ` -${counts.removed}` })]),
                    ]),
                    pre,
                ]);
            }
            case 'terminal':
                return el('div', { className: 'af-terminal' }, [
                    el('pre', { className: 'af-terminal-output', text: block.output || (block.exitCode === null ? 'Running...' : '(no output)') }),
                    ...(block.exitCode !== null ? [el('p', { className: `af-terminal-exit muted${block.exitCode === 0 ? '' : ' is-error'}`, text: `Exit code ${block.exitCode}${block.truncated ? ' (output truncated)' : ''}` })] : []),
                ]);
        }
    }

    function renderPermission(item: Extract<TranscriptItem, { kind: 'permission' }>): HTMLElement {
        const card = el('div', { className: 'af-permission', attrs: { role: 'group', 'aria-label': item.title, 'data-testid': 'af-permission' } }, [
            el('p', { className: 'af-permission-title', text: item.title }),
        ]);
        if (item.outcome !== undefined) {
            const chosen = item.options.find((option) => option.id === item.outcome);
            card.classList.add('is-resolved');
            card.append(el('p', { className: 'muted', text: chosen ? `You chose: ${chosen.name}` : item.outcome === 'cancelled' ? 'Cancelled' : `Answered: ${item.outcome}` }));
            return card;
        }
        const buttons = el('div', { className: 'af-permission-actions' }, item.options.map((option) => {
            const button = el('button', {
                className: option.kind.startsWith('allow') ? (option.kind === 'allow_once' ? 'primary-button' : 'secondary-button') : 'secondary-button is-danger',
                text: option.name,
                attrs: { type: 'button', 'data-kind': option.kind },
            });
            button.addEventListener('click', () => {
                for (const other of buttons.querySelectorAll('button')) {
                    other.disabled = true;
                }
                deps.api.respondPermission(sessionId, item.id, option.id).catch((error: unknown) => deps.onStatus(errorText(error)));
            });
            return button;
        }));
        card.append(buttons);
        return card;
    }

    function renderTurnEnd(item: Extract<TranscriptItem, { kind: 'turn-end' }>, index: number, current: AgentSessionState): HTMLElement {
        const footer = el('div', { className: 'af-turn-end', attrs: { 'data-reason': item.stopReason } });
        let start = 0;
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            if (current.items[cursor]?.kind === 'user') {
                start = cursor;
                break;
            }
        }
        const changed = turnChanges(current.items.slice(0, index), start);
        if (changed.length > 0) {
            footer.append(el('div', { className: 'af-turn-files' }, [
                el('span', { className: 'muted', text: `${changed.length} file${changed.length === 1 ? '' : 's'} changed:` }),
                ...changed.map((change) => {
                    const counts = changeCounts(change.oldText, change.newText);
                    return el('span', { className: 'af-turn-file' }, [fileLink(change.path, undefined, current.workspaceRoot), el('span', { className: 'is-add', text: ` +${counts.added}` }), el('span', { className: 'is-remove', text: ` -${counts.removed}` })]);
                }),
            ]));
        }
        const reason = STOP_TEXT[item.stopReason];
        if (reason) {
            footer.append(el('p', { className: `af-stop muted${item.stopReason === 'error' ? ' is-error' : ''}`, text: reason }));
        }
        deps.decorateTurn?.(current, start, footer);
        return footer;
    }

    function fileLink(path: string, line: number | undefined, root: string | null): HTMLElement {
        const label = displayPath(path, root) + (line ? `:${line}` : '');
        const link = el('button', { className: 'af-file-link', text: label, attrs: { type: 'button', title: `Open ${label}` } });
        link.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            deps.openFile(path, line);
        });
        return link;
    }

    function renderPlan(entries: readonly PlanEntryView[]): void {
        plan.hidden = entries.length === 0;
        if (entries.length === 0) {
            return;
        }
        const done = entries.filter((entry) => entry.status === 'completed').length;
        planSummary.textContent = `Plan: ${done} of ${entries.length} done`;
        planList.replaceChildren(...entries.map((entry) => el('li', { className: 'af-plan-entry', attrs: { 'data-status': entry.status } }, [
            el('span', { className: 'af-plan-mark', attrs: { 'aria-hidden': 'true', 'data-status': entry.status } }),
            el('span', { text: entry.content }),
        ])));
    }

    let renderedModes = '';
    let renderedOptions = '';
    function renderControls(current: AgentSessionState): void {
        const modesKey = JSON.stringify(current.modes);
        if (modesKey !== renderedModes) {
            renderedModes = modesKey;
            modeSelect.hidden = !current.modes || current.modes.available.length === 0;
            modeSelect.replaceChildren(...(current.modes?.available ?? []).map((mode) => {
                const option = el('option', { text: mode.name, attrs: { value: mode.id, title: mode.description ?? '' } });
                option.selected = mode.id === current.modes?.current;
                return option;
            }));
        }
        const optionsKey = JSON.stringify(current.configOptions);
        if (optionsKey !== renderedOptions) {
            renderedOptions = optionsKey;
            optionsSlot.replaceChildren(...current.configOptions.map((option) => configSelect(option)));
        }
    }

    function configSelect(option: ConfigOptionView): HTMLSelectElement {
        const select = el('select', { className: 'af-select', attrs: { 'aria-label': option.name, title: option.name, 'data-option': option.id } });
        select.append(...option.values.map((value) => {
            const node = el('option', { text: value.name, attrs: { value: value.id, title: value.description ?? '' } });
            node.selected = value.id === option.current;
            return node;
        }));
        select.addEventListener('change', () => {
            deps.api.setConfigOption(sessionId, option.id, select.value).catch((error: unknown) => deps.onStatus(errorText(error)));
        });
        return select;
    }

    modeSelect.addEventListener('change', () => {
        deps.api.setMode(sessionId, modeSelect.value).catch((error: unknown) => deps.onStatus(errorText(error)));
    });

    // ---- Composer behaviour ------------------------------------------------
    function updateSendButton(): void {
        const action = state ? composerAction(state, input.value) : 'none';
        sendButton.replaceChildren(icon(action === 'stop' ? ICONS.stop : ICONS.send));
        const label = action === 'stop' ? 'Stop' : action === 'queue' ? 'Queue message (sent when the agent finishes)' : 'Send';
        sendButton.setAttribute('aria-label', label);
        sendButton.title = action === 'stop' ? 'Stop (Esc)' : action === 'queue' ? label : 'Send (Enter)';
        sendButton.disabled = action === 'none';
        sendButton.dataset['action'] = action;
        queueNote.hidden = queue.length === 0;
        queueNote.textContent = queue.length === 1 ? '1 message queued: it is sent when the agent finishes.' : `${queue.length} messages queued.`;
    }

    function toPromptAttachments(items: readonly ChatAttachment[]): PromptAttachment[] {
        return items.map((item) => (item.kind === 'file'
            ? { kind: 'file', path: item.path }
            : { kind: 'selection', path: item.path, startLine: item.startLine, endLine: item.endLine, text: item.text }));
    }

    function submit(): void {
        if (!state) {
            return;
        }
        const action = composerAction(state, input.value);
        if (action === 'stop') {
            deps.api.cancel(sessionId).catch((error: unknown) => deps.onStatus(errorText(error)));
            return;
        }
        if (action === 'none') {
            return;
        }
        const text = input.value;
        const attachments = toPromptAttachments(bar.items());
        input.value = '';
        bar.clear();
        hideSlash();
        stickToBottom = true;
        if (action === 'queue') {
            queue.push({ text, attachments });
            updateSendButton();
            return;
        }
        send(text, attachments);
    }

    function send(text: string, attachments: PromptAttachment[]): void {
        deps.api.prompt(sessionId, text, attachments).catch((error: unknown) => deps.onStatus(errorText(error)));
    }

    function drainQueue(): void {
        if (!state || state.status === 'running' || state.status === 'awaiting') {
            return;
        }
        const next = queue.shift();
        if (next) {
            send(next.text, next.attachments);
        }
        updateSendButton();
    }

    function showSlash(): void {
        slashItems = state ? slashSuggestions(input.value, state.commands) : [];
        slashPopup.hidden = slashItems.length === 0;
        slashSelected = Math.min(slashSelected, Math.max(0, slashItems.length - 1));
        slashPopup.replaceChildren(...slashItems.map((command, index) => {
            const row = el('li', { className: 'chat-mention-row', attrs: { role: 'option', 'aria-selected': String(index === slashSelected) } }, [
                el('span', { className: 'af-slash-name', text: `/${command.name}` }),
                el('span', { className: 'muted', text: ` ${command.description}` }),
            ]);
            row.addEventListener('mousedown', (event) => {
                event.preventDefault();
                pickSlash(index);
            });
            return row;
        }));
    }

    function hideSlash(): void {
        slashItems = [];
        slashPopup.hidden = true;
    }

    function pickSlash(index: number): void {
        const command = slashItems[index];
        if (command) {
            input.value = `/${command.name} `;
            hideSlash();
            input.focus();
            updateSendButton();
        }
    }

    input.addEventListener('input', () => {
        slashSelected = 0;
        showSlash();
        updateSendButton();
    });
    input.addEventListener('keydown', (event) => {
        if (!slashPopup.hidden && slashItems.length > 0) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                slashSelected = (slashSelected + (event.key === 'ArrowDown' ? 1 : slashItems.length - 1)) % slashItems.length;
                showSlash();
                return;
            }
            if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                event.preventDefault();
                pickSlash(slashSelected);
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                hideSlash();
                return;
            }
        }
        if (bar.handleKey(event)) {
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            submit();
            return;
        }
        if (event.key === 'Escape' && state && (state.status === 'running' || state.status === 'awaiting')) {
            event.preventDefault();
            deps.api.cancel(sessionId).catch((error: unknown) => deps.onStatus(errorText(error)));
        }
    });
    sendButton.addEventListener('click', submit);

    // ---- Lifecycle ---------------------------------------------------------
    async function reload(): Promise<void> {
        const loaded = await deps.api.get(sessionId);
        if (disposed) {
            return;
        }
        state = loaded;
        rendered.forEach((entry) => entry.node.remove());
        rendered.clear();
        render();
        deps.onDidChange?.(state);
        if (state.unread) {
            deps.api.markRead(sessionId).catch(() => undefined);
        }
    }

    reload().catch((error: unknown) => {
        transcript.append(el('p', { className: 'af-notice is-error', text: `Could not open this chat: ${errorText(error)}` }));
    });

    return {
        element,
        sessionId,
        get state() {
            return state;
        },
        handle(message: AgentSessionMessage): void {
            if (message.kind !== 'event' || message.sessionId !== sessionId || !state) {
                return;
            }
            const before = state;
            state = applySessionEvent(state, message.event, message.updatedAt);
            if (message.event.type === 'turn-end') {
                // The person is looking at this chat: what just finished is read.
                if (element.isConnected) {
                    deps.api.markRead(sessionId).catch(() => undefined);
                }
                queueMicrotask(drainQueue);
            }
            if (before.title !== state.title || before.status !== state.status || before.pendingChanges !== state.pendingChanges) {
                deps.onDidChange?.(state);
            }
            schedule();
        },
        focus(): void {
            input.focus();
        },
        insert(text: string): void {
            input.value = input.value ? `${input.value}\n${text}` : text;
            input.focus();
            updateSendButton();
        },
        reload,
        dispose(): void {
            disposed = true;
            if (frame) {
                cancelAnimationFrame(frame);
            }
        },
    };
}

const STOP_TEXT: Readonly<Record<Extract<TranscriptItem, { kind: 'turn-end' }>['stopReason'], string>> = {
    end_turn: '',
    max_tokens: 'The agent stopped: it reached its output limit.',
    max_turn_requests: 'The agent stopped: it reached its limit of steps for one message.',
    refusal: 'The agent declined to continue.',
    cancelled: 'Stopped.',
    error: 'The turn failed.',
};

function statusText(state: AgentSessionState): string {
    switch (state.status) {
        case 'idle':
            return 'Ready';
        case 'running':
            return 'Working';
        case 'awaiting':
            return 'Needs your approval';
        case 'error':
            return 'Error';
    }
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export { lastUserIndex };
