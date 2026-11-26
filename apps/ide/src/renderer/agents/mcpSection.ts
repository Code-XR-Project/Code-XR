import type { AgentsApi, McpServerStatus, McpServerView, McpTransport } from '../../shared/agents.ts';
import { joinArgs, splitArgs } from '../../shared/argLine.ts';
import { el } from '../dom.ts';

/**
 * The "MCP servers" section of the Agents view (A12): the servers whose
 * tools agents can be given. A local command is confirmed by the main
 * process in a native dialog before it is saved; a token goes to the OS
 * secret store and never comes back here.
 */

const STATUS_LABEL: Readonly<Record<McpServerStatus, string>> = {
    stopped: 'Not connected',
    connecting: 'Connecting…',
    ready: 'Connected',
    error: 'Failed',
};

export interface McpSection {
    readonly element: HTMLElement;
    refresh(): Promise<void>;
}

const errorText = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function createMcpSection(api: AgentsApi, callbacks: { onStatus(message: string): void; onChanged(): void }): McpSection {
    const list = el('ul', { className: 'agents-provider-list', attrs: { 'data-testid': 'agents-mcp-servers' } });
    const empty = el('p', { className: 'muted side-note', text: 'No MCP server yet. Add one to give agents its tools; every call asks you first.' });
    const addButton = el('button', { className: 'secondary-button agents-block-button', text: 'Add MCP server', attrs: { type: 'button', 'data-action': 'add-mcp-server' } });
    const formSlot = el('div');
    const element = el('section', { className: 'agents-section', attrs: { 'aria-labelledby': 'agents-mcp-heading' } }, [
        el('h3', { className: 'side-bar-subtitle', text: 'MCP servers', attrs: { id: 'agents-mcp-heading' } }),
        list,
        empty,
        formSlot,
        addButton,
    ]);
    addButton.addEventListener('click', () => openForm(null));

    async function refresh(): Promise<void> {
        const servers = await api.listMcpServers();
        list.replaceChildren(...servers.map(renderServer));
        empty.hidden = servers.length > 0;
    }

    function renderServer(server: McpServerView): HTMLElement {
        const action = (label: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement => {
            const button = el('button', { className: 'secondary-button', text: label, attrs: { type: 'button', 'data-action': label.toLowerCase() } });
            button.addEventListener('click', () => onClick(button));
            return button;
        };
        const status = server.enabled ? STATUS_LABEL[server.status] : 'Off';
        const toolNames = server.tools.map((tool) => tool.name.split('__').slice(2).join('__'));
        const item = el('li', { className: 'agents-provider', attrs: { 'data-mcp-id': server.id, 'data-status': server.enabled ? server.status : 'off' } }, [
            el('div', { className: 'agents-provider-head' }, [
                el('span', { className: 'agents-provider-name', text: server.name }),
                el('span', { className: 'env-badge', text: server.transport === 'stdio' ? 'Local command' : 'HTTP' }),
            ]),
            el('p', { className: 'agents-provider-url muted small agents-mcp-target', text: server.transport === 'stdio' ? `$ ${server.command} ${joinArgs(server.args)}`.trimEnd() : server.url }),
            el('p', { className: 'muted small', text: `${status} · ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}${server.transport === 'http' && server.hasToken ? ' · token in the system keychain' : ''}` }),
            ...(server.error ? [el('p', { className: 'error small', text: server.error, attrs: { role: 'alert' } })] : []),
            ...(toolNames.length > 0 ? [el('p', { className: 'muted small agents-mcp-tools', text: toolNames.join(', '), attrs: { title: server.tools.map((tool) => `${tool.name}: ${tool.description}`).join('\n') } })] : []),
            el('div', { className: 'env-actions' }, [
                action('Refresh', (button) => {
                    button.disabled = true;
                    button.textContent = 'Connecting…';
                    api.refreshMcpServer(server.id).then((view) => {
                        callbacks.onStatus(view.status === 'ready' ? `${view.name}: ${view.tools.length} tools.` : `${view.name}: ${view.error ?? 'not connected'}`);
                        callbacks.onChanged();
                        return refresh();
                    }, (failure: unknown) => callbacks.onStatus(errorText(failure)));
                }),
                action('Edit', () => openForm(server)),
                action('Remove', () => {
                    if (!window.confirm(`Remove the MCP server ${server.name}? Agents lose its tools.`)) {
                        return;
                    }
                    api.removeMcpServer(server.id).then(() => {
                        callbacks.onStatus(`Removed ${server.name}.`);
                        callbacks.onChanged();
                        return refresh();
                    }, (failure: unknown) => callbacks.onStatus(errorText(failure)));
                }),
            ]),
        ]);
        return item;
    }

    function openForm(existing: McpServerView | null): void {
        addButton.hidden = true;
        const field = (id: string, label: string, input: HTMLElement, help?: string): HTMLElement => el('div', { className: 'agents-field' }, [
            el('label', { text: label, attrs: { for: id } }),
            input,
            ...(help ? [el('p', { className: 'muted small agents-help', text: help })] : []),
        ]);
        const name = el('input', { className: 'agents-input', attrs: { id: 'mcp-name', type: 'text', maxlength: '60', autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. GitHub' } });
        name.value = existing?.name ?? '';
        const transport = el('select', { className: 'agents-input', attrs: { id: 'mcp-transport', 'data-testid': 'mcp-transport' } }, [
            el('option', { text: 'Local command (stdio)', attrs: { value: 'stdio' } }),
            el('option', { text: 'Remote URL (Streamable HTTP)', attrs: { value: 'http' } }),
        ]);
        transport.value = existing?.transport ?? 'stdio';
        const command = el('input', { className: 'agents-input', attrs: { id: 'mcp-command', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'npx' } });
        command.value = existing?.command ?? '';
        const args = el('input', { className: 'agents-input', attrs: { id: 'mcp-args', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '-y @modelcontextprotocol/server-filesystem /path/to/folder' } });
        args.value = existing ? joinArgs(existing.args) : '';
        const url = el('input', { className: 'agents-input', attrs: { id: 'mcp-url', type: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://example.com/mcp' } });
        url.value = existing?.url ?? '';
        const token = el('input', { className: 'agents-input', attrs: { id: 'mcp-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: existing?.hasToken ? 'Leave empty to keep the current token' : 'Optional bearer token' } });
        const enabled = el('input', { attrs: { id: 'mcp-enabled', type: 'checkbox' } });
        enabled.checked = existing?.enabled ?? true;
        const stdioRows = el('div', {}, [
            field('mcp-command', 'Command', command),
            field('mcp-args', 'Arguments', args, 'Starts on your computer with your permissions. The IDE asks you to confirm the exact command line before saving it.'),
        ]);
        const httpRows = el('div', {}, [
            field('mcp-url', 'URL', url),
            field('mcp-token', 'Token', token, 'Sent as a bearer token; kept in the system keychain.'),
        ]);
        const sync = (): void => {
            stdioRows.hidden = transport.value !== 'stdio';
            httpRows.hidden = transport.value !== 'http';
        };
        transport.addEventListener('change', sync);
        sync();
        const error = el('p', { className: 'error small', attrs: { hidden: '', role: 'alert' } });
        const save = el('button', { className: 'primary-button', text: existing ? 'Save' : 'Add', attrs: { type: 'submit' } });
        const cancel = el('button', { className: 'secondary-button', text: 'Cancel', attrs: { type: 'button' } });
        const form = el('form', { className: 'agents-form', attrs: { 'aria-label': existing ? `Edit ${existing.name}` : 'Add an MCP server', 'data-testid': 'mcp-form' } }, [
            field('mcp-name', 'Name', name),
            field('mcp-transport', 'Connection', transport),
            stdioRows,
            httpRows,
            el('label', { className: 'agents-tool' }, [enabled, el('span', { text: 'On: agents can use its tools' })]),
            error,
            el('div', { className: 'env-actions' }, [save, cancel]),
        ]);
        const close = (): void => {
            token.value = '';
            formSlot.replaceChildren();
            addButton.hidden = false;
        };
        cancel.addEventListener('click', close);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const kind = transport.value as McpTransport;
            const typedToken = token.value.trim();
            save.disabled = true;
            save.textContent = 'Connecting…';
            error.hidden = true;
            api.saveMcpServer({
                name: name.value,
                transport: kind,
                enabled: enabled.checked,
                ...(kind === 'stdio' ? { command: command.value, args: splitArgs(args.value) } : { url: url.value, ...(typedToken || !existing ? { token: typedToken } : {}) }),
            }, existing?.id).then((saved) => {
                close();
                callbacks.onStatus(saved.status === 'error' ? `Saved ${saved.name}, but it did not connect: ${saved.error ?? ''}` : `Saved ${saved.name}: ${saved.tools.length} tools.`);
                callbacks.onChanged();
                return refresh();
            }, (failure: unknown) => {
                error.hidden = false;
                error.textContent = errorText(failure);
            }).finally(() => {
                save.disabled = false;
                save.textContent = existing ? 'Save' : 'Add';
            });
        });
        formSlot.replaceChildren(form);
        name.focus();
    }

    return { element, refresh };
}
