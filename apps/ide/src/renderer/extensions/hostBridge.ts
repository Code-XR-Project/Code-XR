import type { HostUiEvent, StatusBarItemData, UiNotification, UiRequest } from '../../shared/extensionHostProtocol.ts';
import type { ContributedCommand, ExtensionsApi, InstalledExtension } from '../../shared/extensions.ts';
import type { CommandRegistry } from '../commands/commandRegistry.ts';
import { pickListView, type PickItem } from '../commands/paletteModel.ts';
import type { QuickInputProvider } from '../commands/quickInput.ts';
import { el } from '../dom.ts';
import type { NotificationCenter } from '../notifications.ts';
import type { ViewNotification } from '../../shared/extensionViewsProtocol.ts';
import type { WebviewUiEvent } from '../../shared/extensionWebviewProtocol.ts';
import { whenHolds } from '../../shared/whenClause.ts';
import type { ContextKeys } from './contextKeys.ts';
import { builtinCommandFor, statusText } from './hostBridgeModel.ts';

/**
 * The workbench's side of the extension host (#259): what an extension asks
 * the person (messages with buttons, quick picks, input boxes), its status
 * bar items and progress, the commands it contributes to the palette, and the
 * workbench commands it runs. Every answer goes back with `hostReply`.
 *
 * Text from an extension is set with `textContent` only, never as HTML.
 */

export interface HostBridgeDeps {
    readonly extensions: ExtensionsApi;
    readonly registry: CommandRegistry;
    readonly notifications: NotificationCenter;
    readonly statusLeft: HTMLElement;
    readonly statusRight: HTMLElement;
    openQuickInput(value: string, provider: QuickInputProvider): void;
    openFile(path: string, line?: number, column?: number): Promise<void>;
    setStatus(message: string): void;
    /** Shows the Extensions view with a search (`workbench.extensions.search`). */
    searchExtensions(query: string): void;
    /** #260: the language features' notifications (providers, diagnostics), for the language bridge. */
    languageNotification(notification: Extract<UiNotification, { kind: 'diagnostics' | 'providerRegistered' | 'providerUnregistered' | 'providersReset' }>): void;
    /** #260: the host's edits and saves of the editor's documents. */
    languageRequest(request: Extract<UiRequest, { kind: 'applyEdit' | 'saveFile' | 'insertSnippet' }>): Promise<unknown>;
    /** #261: the `setContext` keys go here (for `when` clauses). */
    readonly contextKeys: ContextKeys;
    /** #261: the extensions' tree views. */
    viewNotification(notification: ViewNotification): void;
    /** #261: a webview was created, changed or disposed. */
    webviewEvent(event: WebviewUiEvent): void;
    /** #261: a workbench command the views answer (`<view>.focus`, `workbench.view.extension.<id>`); false when it is not one. */
    viewCommand(id: string): boolean;
}

export interface HostBridge {
    /** The palette's commands of the extensions that may run in this window. */
    setCommands(commands: readonly ContributedCommand[], installed: readonly InstalledExtension[]): void;
    /** The context keys (`setContext` and the workbench's), for `when` clauses. */
    contextKey(key: string): unknown;
    dispose(): void;
}

/** Resolves a promise once; later calls are ignored. */
function once(resolve: (value: unknown) => void): (value: unknown) => void {
    let done = false;
    return (value) => {
        if (!done) {
            done = true;
            resolve(value);
        }
    };
}

export function createHostBridge(deps: HostBridgeDeps): HostBridge {
    const { extensions } = deps;
    const items = new Map<string, { data: StatusBarItemData; element: HTMLButtonElement }>();
    const context = deps.contextKeys;
    let commandDisposers: (() => void)[] = [];
    let statusTimer: ReturnType<typeof setTimeout> | undefined;

    const reply = (id: number, result: unknown): void => {
        extensions.hostReply(id, result ?? null).catch(() => undefined);
    };

    const runExtensionCommand = (command: string, args: readonly unknown[] = []): void => {
        extensions.executeCommand(command, args).catch((error: unknown) => {
            deps.notifications.notify('error', `Command '${command}' failed: ${error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)}`);
        });
    };

    /* ------------------------------ requests ------------------------------ */

    async function answer(request: UiRequest): Promise<unknown> {
        switch (request.kind) {
            case 'message':
                return new Promise((resolve) => {
                    let settled = false;
                    const settle = (value: unknown): void => {
                        if (!settled) {
                            settled = true;
                            resolve(value);
                        }
                    };
                    deps.notifications.notify(request.severity, request.message, {
                        detail: request.detail,
                        actions: request.items.map((label, index) => ({ label, run: () => settle(index) })),
                        onDismiss: () => settle(null),
                    });
                    if (request.items.length === 0) {
                        // Nothing to choose: VS Code resolves once it is shown.
                        settle(null);
                    }
                });
            case 'quickPick':
                return new Promise((resolve) => {
                    const pickItems: PickItem[] = [];
                    request.items.forEach((item, index) => {
                        if (!item.separator) {
                            pickItems.push({ id: String(index), label: item.label, ...(item.description || item.detail ? { description: [item.description, item.detail].filter(Boolean).join(' · ') } : {}) });
                        }
                    });
                    const settle = once(resolve);
                    deps.openQuickInput('', {
                        label: request.title ?? request.placeHolder ?? 'Select an item',
                        ...(request.placeHolder ? { placeholder: request.placeHolder } : {}),
                        view: (value) => pickListView(pickItems, value),
                        accept: (action) => settle(action.kind === 'pick' ? [Number(action.id)] : null),
                        // The box closes before `accept` runs: wait a turn so an accepted pick wins.
                        onClose: () => queueMicrotask(() => settle(null)),
                    });
                });
            case 'inputBox':
                return new Promise((resolve) => {
                    const settle = once(resolve);
                    deps.openQuickInput(request.value ?? '', {
                        label: request.title ?? request.prompt ?? 'Input',
                        ...(request.placeHolder ? { placeholder: request.placeHolder } : {}),
                        password: request.password,
                        view: (value) => ({
                            entries: [{
                                id: value,
                                label: request.password ? '' : value === '' ? '' : value,
                                highlights: [],
                                description: request.prompt ? `${request.prompt} (Press Enter to confirm or Escape to cancel)` : 'Press Enter to confirm or Escape to cancel',
                                runnable: true,
                            }],
                            action: (entry) => ({ kind: 'pick', id: entry.id }),
                            empty: '',
                        }),
                        accept: (action) => settle(action.kind === 'pick' ? action.id : null),
                        onClose: () => queueMicrotask(() => settle(null)),
                    });
                });
            case 'openFile':
                await deps.openFile(request.path, request.line, request.column);
                return true;
            case 'command':
                return runWorkbenchCommand(request.id, request.args);
            case 'applyEdit':
            case 'saveFile':
            case 'insertSnippet':
                return deps.languageRequest(request);
        }
    }

    async function runWorkbenchCommand(id: string, args: readonly unknown[]): Promise<unknown> {
        const builtin = builtinCommandFor(id, args);
        switch (builtin.kind) {
            case 'search-extensions':
                deps.searchExtensions(builtin.query);
                return null;
            case 'reload':
                window.location.reload();
                return null;
            case 'workbench':
                if (!deps.registry.execute(builtin.id)) {
                    throw new Error(`command '${id}' not found`);
                }
                return null;
            case 'unknown':
                if (deps.viewCommand(id)) {
                    return null;
                }
                throw new Error(`command '${id}' not found`);
        }
    }

    /* ------------------------------ notifications ------------------------------ */

    function renderItem(data: StatusBarItemData): void {
        let entry = items.get(data.key);
        if (!entry) {
            const element = el('button', { className: 'status-item status-extension-item', attrs: { type: 'button', 'data-extension': data.extensionId } });
            element.addEventListener('click', () => {
                const current = items.get(data.key)?.data;
                if (current?.command) {
                    runExtensionCommand(current.command, current.commandArgs ?? []);
                }
            });
            entry = { data, element };
            items.set(data.key, entry);
        }
        entry.data = data;
        const { element } = entry;
        element.textContent = statusText(data.text);
        element.title = data.tooltip ?? data.name ?? data.extensionId;
        element.hidden = !data.visible || element.textContent === '';
        element.classList.toggle('is-clickable', !!data.command);
        const slot = data.alignment === 'right' ? deps.statusRight : deps.statusLeft;
        // Higher priority sits further left, as in VS Code.
        const ordered = [...items.values()].filter((other) => other.data.alignment === data.alignment).sort((a, b) => b.data.priority - a.data.priority);
        slot.replaceChildren(...ordered.map((other) => other.element));
    }

    function handleNotification(notification: UiNotification): void {
        switch (notification.kind) {
            case 'statusBarItem':
                renderItem(notification.item);
                return;
            case 'statusBarItemDispose':
                items.get(notification.key)?.element.remove();
                items.delete(notification.key);
                return;
            case 'statusMessage':
                clearTimeout(statusTimer);
                deps.setStatus(statusText(notification.text));
                if (notification.timeoutMs > 0) {
                    statusTimer = setTimeout(() => deps.setStatus(''), notification.timeoutMs);
                }
                return;
            case 'progress':
                deps.notifications.progress(`ext:${notification.key}`, { title: notification.title, message: notification.message, percent: notification.percent });
                return;
            case 'progressEnd':
                deps.notifications.endProgress(`ext:${notification.key}`);
                return;
            case 'contextKey':
                context.set(notification.key, notification.value);
                return;
            case 'diagnostics':
            case 'providerRegistered':
            case 'providerUnregistered':
            case 'providersReset':
                deps.languageNotification(notification);
                if (notification.kind === 'providersReset') {
                    // A host started or stopped: what the previous one set is gone.
                    context.clear();
                }
                return;
            case 'webview':
                deps.webviewEvent(notification.event);
                return;
            case 'view':
                deps.viewNotification(notification.notification);
                return;
            case 'hostStopped':
                deps.notifications.notify('error', notification.reason, {
                    actions: [{ label: 'Restart Extension Host', run: () => void extensions.restartHost() }],
                });
                return;
        }
    }

    const unsubscribe = extensions.onHostUi((event: HostUiEvent) => {
        if (event.type === 'notify') {
            handleNotification(event.notification);
            return;
        }
        answer(event.request).then(
            (result) => reply(event.id, result),
            (error: unknown) => {
                deps.notifications.notify('error', String(error instanceof Error ? error.message : error));
                reply(event.id, null);
            },
        );
    });
    extensions.hostReady().catch((error: unknown) => deps.notifications.notify('error', `The extension host could not start: ${String(error)}`));

    return {
        setCommands(commands, installed) {
            for (const dispose of commandDisposers) {
                dispose();
            }
            commandDisposers = [];
            const runnable = new Set(installed.filter((extension) => extension.state === 'enabled' && extension.hasCode).map((extension) => extension.id));
            for (const command of commands) {
                if (command.hiddenFromPalette || !runnable.has(command.extensionId) || deps.registry.get(command.command)) {
                    continue;
                }
                const paletteWhen = command.paletteWhen;
                commandDisposers.push(deps.registry.register({
                    id: command.command,
                    title: command.title,
                    ...(command.category ? { category: command.category } : {}),
                    source: 'extension',
                    // #261: `menus.commandPalette`'s `when`.
                    ...(paletteWhen ? { enabled: () => whenHolds(paletteWhen, context.lookup()) } : {}),
                    run: () => runExtensionCommand(command.command),
                }));
            }
            // Items of extensions that are gone stay until their host says otherwise; drop them now.
            for (const [key, entry] of items) {
                if (!runnable.has(entry.data.extensionId)) {
                    entry.element.remove();
                    items.delete(key);
                }
            }
        },
        contextKey: (key) => context.get(key),
        dispose() {
            unsubscribe();
            for (const dispose of commandDisposers) {
                dispose();
            }
        },
    };
}
