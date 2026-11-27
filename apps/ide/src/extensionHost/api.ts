import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MAIN_METHODS, type DialogRequest, type QuickPickItemData, type StatusBarItemData } from '../shared/extensionHostProtocol.ts';
import { HOST_VSCODE_API_VERSION, type ExtensionId } from '../shared/extensions.ts';
import { TextEditorImpl } from './documents.ts';
import { matchGlob } from './glob.ts';
import type { ExtensionHost, ExtensionRecord } from './host.ts';
import { missingNamespace, withFallback } from './inert.ts';
import { TextDocumentModel } from './textDocument.ts';
import * as types from './types.ts';
import { CancellationTokenNone, Disposable, EventEmitter, FileSystemError, FileType, Uri, type CancellationToken } from './types.ts';

/**
 * The `vscode` module as one extension sees it (#259). Built once per
 * extension, so every call knows which extension made it (for the log, the
 * status bar item keys, the secrets). What is implemented behaves like VS
 * Code; the rest is reported once and replaced by an inert stand-in
 * (inert.ts), so an extension keeps running with that feature missing.
 *
 * The editor's documents and the language features are shared by every
 * extension (documents.ts, languageFeatures.ts, #260); #261 adds the tree
 * views and webviews.
 */

type Item = string | { title: string; isCloseAffordance?: boolean };

function isMessageOptions(value: unknown): value is { modal?: boolean; detail?: string } {
    return typeof value === 'object' && value !== null && !('title' in value);
}

function toFsError(error: unknown, uri: Uri): Error {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    switch (code) {
        case 'ENOENT':
            return FileSystemError.FileNotFound(uri);
        case 'EEXIST':
            return FileSystemError.FileExists(uri);
        case 'ENOTDIR':
            return FileSystemError.FileNotADirectory(uri);
        case 'EISDIR':
            return FileSystemError.FileIsADirectory(uri);
        case 'EACCES':
        case 'EPERM':
            return FileSystemError.NoPermissions(uri);
        default:
            return error instanceof Error ? error : new Error(String(error));
    }
}

function fileUri(value: unknown): Uri {
    if (value instanceof Uri) {
        if (value.scheme !== 'file') {
            throw FileSystemError.Unavailable(value);
        }
        return value;
    }
    throw new Error('Expected a Uri');
}

/** `vscode.l10n.t`: the extension's English strings with `{0}` / `{name}` filled in. */
export function formatMessage(message: string, args: readonly unknown[] | Readonly<Record<string, unknown>>): string {
    return message.replace(/\{([^}]+)\}/g, (match, key: string) => {
        const value = Array.isArray(args) ? args[Number(key)] : (args as Record<string, unknown>)[key];
        return value === undefined ? match : String(value);
    });
}

export function createVscodeApi(record: ExtensionRecord, host: ExtensionHost): unknown {
    const extensionId: ExtensionId = record.description.id;
    const report = (api: string): void => host.reportMissing(extensionId, api);
    const data = host.data;
    // In `Uri.fsPath`'s spelling (a lower-case drive letter on Windows), so it compares with the paths of URIs.
    const workspaceRoot = data.workspaceFolder ? Uri.file(data.workspaceFolder).fsPath : null;
    const workspaceFolder = workspaceRoot ? { uri: Uri.file(workspaceRoot), name: path.basename(workspaceRoot), index: 0 } : undefined;

    /* ------------------------------ commands ------------------------------ */

    const commands = withFallback('commands', {
        registerCommand: (id: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown) => host.registerCommand(extensionId, id, callback, thisArg),
        registerTextEditorCommand: (id: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown) => host.registerCommand(extensionId, id, (...args: unknown[]) => {
            const editor = host.documentsAndEditors.activeTextEditor;
            if (!editor) {
                host.log({ level: 'warn', extensionId, message: `Command ${id} needs an active text editor.` });
                return undefined;
            }
            // As in VS Code: the builder's edits are applied once the callback returns.
            return editor.edit((builder) => {
                callback.call(thisArg, editor, builder, ...args);
            });
        }),
        executeCommand: <T>(id: string, ...args: unknown[]): Promise<T> => host.executeCommand(id, args) as Promise<T>,
        getCommands: async (filterInternal = false): Promise<string[]> => {
            const ids = [...host.commands.keys()];
            return filterInternal ? ids.filter((id) => !id.startsWith('_')) : ids;
        },
    }, report);

    /* ------------------------------ output channels ------------------------------ */

    function createOutputChannel(name: string) {
        let buffer = '';
        const logLevelChanged = new EventEmitter<number>();
        const emit = (level: 'trace' | 'debug' | 'info' | 'warn' | 'error', message: string): void => host.log({ level, extensionId, channel: name, message });
        const flush = (): void => {
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                emit('info', line);
            }
        };
        const channel = {
            name,
            append(value: string) {
                buffer += String(value);
                flush();
            },
            appendLine(value: string) {
                buffer += `${String(value)}\n`;
                flush();
            },
            replace(value: string) {
                buffer = '';
                channel.append(value);
            },
            clear() {
                buffer = '';
            },
            show() {
                // The IDE's *Extensions* output channel holds every extension's lines.
            },
            hide() {
                // Nothing to hide: see show().
            },
            dispose() {
                if (buffer !== '') {
                    emit('info', buffer);
                    buffer = '';
                }
            },
            // LogOutputChannel
            logLevel: 3,
            onDidChangeLogLevel: logLevelChanged.event,
            trace: (message: string, ...args: unknown[]) => emit('trace', [message, ...args.map(String)].join(' ')),
            debug: (message: string, ...args: unknown[]) => emit('debug', [message, ...args.map(String)].join(' ')),
            info: (message: string, ...args: unknown[]) => emit('info', [message, ...args.map(String)].join(' ')),
            warn: (message: string, ...args: unknown[]) => emit('warn', [message, ...args.map(String)].join(' ')),
            error: (error: string | Error, ...args: unknown[]) => emit('error', [error instanceof Error ? error.stack ?? error.message : error, ...args.map(String)].join(' ')),
        };
        return channel;
    }

    /* ------------------------------ messages, pickers ------------------------------ */

    async function showMessage(severity: 'info' | 'warning' | 'error', message: string, rest: unknown[]): Promise<unknown> {
        const options = isMessageOptions(rest[0]) ? rest.shift() as { modal?: boolean; detail?: string } : {};
        const items = rest.filter((item): item is Item => typeof item === 'string' || (typeof item === 'object' && item !== null && typeof (item as { title?: unknown }).title === 'string'));
        const labels = items.map((item) => (typeof item === 'string' ? item : item.title));
        const answer = await host.ui({
            kind: 'message', extensionId, severity, message: String(message), items: labels,
            ...(options.detail ? { detail: options.detail } : {}),
            ...(options.modal ? { modal: true } : {}),
        });
        return typeof answer === 'number' ? items[answer] : undefined;
    }

    async function showQuickPick(itemsOrPromise: unknown, options: { placeHolder?: string; title?: string; canPickMany?: boolean; onDidSelectItem?: (item: unknown) => unknown } = {}, token: CancellationToken = CancellationTokenNone): Promise<unknown> {
        const items = (await itemsOrPromise) as (string | { label: string; description?: string; detail?: string; picked?: boolean; kind?: number })[];
        if (token.isCancellationRequested || !Array.isArray(items)) {
            return undefined;
        }
        const data: QuickPickItemData[] = items.map((item) => (typeof item === 'string' ? { label: item } : {
            label: String(item.label),
            ...(item.description ? { description: String(item.description) } : {}),
            ...(item.detail ? { detail: String(item.detail) } : {}),
            ...(item.picked ? { picked: true } : {}),
            ...(item.kind === types.QuickPickItemKind.Separator ? { separator: true } : {}),
        }));
        const answer = await host.ui({ kind: 'quickPick', extensionId, items: data, canPickMany: options.canPickMany === true, ...(options.placeHolder ? { placeHolder: options.placeHolder } : {}), ...(options.title ? { title: options.title } : {}) });
        if (token.isCancellationRequested || !Array.isArray(answer)) {
            return undefined;
        }
        const picked = (answer as number[]).map((index) => items[index]).filter((item) => item !== undefined);
        if (options.canPickMany) {
            return picked;
        }
        if (picked[0] !== undefined) {
            await options.onDidSelectItem?.(picked[0]);
        }
        return picked[0];
    }

    async function showInputBox(options: { value?: string; prompt?: string; placeHolder?: string; title?: string; password?: boolean; validateInput?: (value: string) => unknown } = {}, token: CancellationToken = CancellationTokenNone): Promise<string | undefined> {
        let value = options.value;
        let prompt = options.prompt;
        // validateInput runs here, in the host: an invalid answer asks again with the problem as the prompt.
        for (let attempt = 0; attempt < 10; attempt++) {
            const answer = await host.ui({
                kind: 'inputBox', extensionId, password: options.password === true,
                ...(value !== undefined ? { value } : {}), ...(prompt ? { prompt } : {}), ...(options.placeHolder ? { placeHolder: options.placeHolder } : {}), ...(options.title ? { title: options.title } : {}),
            });
            if (token.isCancellationRequested || typeof answer !== 'string') {
                return undefined;
            }
            const problem = await options.validateInput?.(answer);
            const text = typeof problem === 'string' ? problem : typeof problem === 'object' && problem !== null ? String((problem as { message?: unknown }).message ?? '') : '';
            if (!text) {
                return answer;
            }
            value = answer;
            prompt = text;
        }
        return undefined;
    }

    /**
     * `window.createQuickPick` / `createInputBox`: the workbench shows one
     * request per `show()`; accepting fires `onDidChangeSelection` (or
     * `onDidChangeValue`) and `onDidAccept`, closing fires `onDidHide`. Items
     * changed while the box is open are not redrawn (they are on the next show).
     */
    function createQuickPick() {
        const accept = new EventEmitter<void>();
        const hideEmitter = new EventEmitter<void>();
        const selectionChanged = new EventEmitter<readonly unknown[]>();
        const activeChanged = new EventEmitter<readonly unknown[]>();
        const valueChanged = new EventEmitter<string>();
        let visible = false;
        let generation = 0;
        const pick = {
            title: undefined as string | undefined,
            placeholder: undefined as string | undefined,
            value: '',
            items: [] as { label: string; description?: string; detail?: string; picked?: boolean; kind?: number }[],
            activeItems: [] as unknown[],
            selectedItems: [] as unknown[],
            canSelectMany: false,
            matchOnDescription: false,
            matchOnDetail: false,
            keepScrollPosition: false,
            busy: false,
            enabled: true,
            ignoreFocusOut: false,
            step: undefined as number | undefined,
            totalSteps: undefined as number | undefined,
            buttons: [] as unknown[],
            onDidAccept: accept.event,
            onDidHide: hideEmitter.event,
            onDidChangeSelection: selectionChanged.event,
            onDidChangeActive: activeChanged.event,
            onDidChangeValue: valueChanged.event,
            onDidTriggerButton: new EventEmitter<unknown>().event,
            onDidTriggerItemButton: new EventEmitter<unknown>().event,
            show() {
                if (visible) {
                    return;
                }
                visible = true;
                const mine = ++generation;
                const title = [pick.title, pick.step !== undefined && pick.totalSteps !== undefined ? `(${pick.step}/${pick.totalSteps})` : ''].filter(Boolean).join(' ');
                void showQuickPick(pick.items, { ...(pick.placeholder ? { placeHolder: pick.placeholder } : {}), ...(title ? { title } : {}) }).then((chosen) => {
                    if (mine !== generation || !visible) {
                        return;
                    }
                    if (chosen !== undefined) {
                        pick.activeItems = [chosen];
                        pick.selectedItems = [chosen];
                        activeChanged.fire(pick.activeItems);
                        selectionChanged.fire(pick.selectedItems);
                        accept.fire();
                    }
                    if (visible && mine === generation) {
                        visible = false;
                        hideEmitter.fire();
                    }
                });
            },
            hide() {
                if (visible) {
                    visible = false;
                    generation++;
                    hideEmitter.fire();
                }
            },
            dispose() {
                pick.hide();
                accept.dispose();
                hideEmitter.dispose();
            },
        };
        return pick;
    }

    function createInputBox() {
        const accept = new EventEmitter<void>();
        const hideEmitter = new EventEmitter<void>();
        const valueChanged = new EventEmitter<string>();
        let visible = false;
        let generation = 0;
        const box = {
            title: undefined as string | undefined,
            placeholder: undefined as string | undefined,
            prompt: undefined as string | undefined,
            value: '',
            valueSelection: undefined as unknown,
            password: false,
            busy: false,
            enabled: true,
            ignoreFocusOut: false,
            step: undefined as number | undefined,
            totalSteps: undefined as number | undefined,
            buttons: [] as unknown[],
            validationMessage: undefined as unknown,
            onDidAccept: accept.event,
            onDidHide: hideEmitter.event,
            onDidChangeValue: valueChanged.event,
            onDidTriggerButton: new EventEmitter<unknown>().event,
            show() {
                if (visible) {
                    return;
                }
                visible = true;
                const mine = ++generation;
                const message = typeof box.validationMessage === 'string' ? box.validationMessage : typeof box.validationMessage === 'object' && box.validationMessage !== null ? String((box.validationMessage as { message?: unknown }).message ?? '') : '';
                const title = [box.title, box.step !== undefined && box.totalSteps !== undefined ? `(${box.step}/${box.totalSteps})` : ''].filter(Boolean).join(' ');
                void host.ui({
                    kind: 'inputBox', extensionId, password: box.password, value: box.value,
                    ...(message || box.prompt ? { prompt: message || box.prompt || '' } : {}),
                    ...(box.placeholder ? { placeHolder: box.placeholder } : {}),
                    ...(title ? { title } : {}),
                }).then(async (answer) => {
                    if (mine !== generation || !visible) {
                        return;
                    }
                    if (typeof answer === 'string') {
                        box.value = answer;
                        valueChanged.fire(answer);
                        // Validation runs on the value change, as in VS Code; let async validators settle.
                        await new Promise((resolve) => setTimeout(resolve, 0));
                        accept.fire();
                        await new Promise((resolve) => setTimeout(resolve, 0));
                        if (visible && mine === generation && box.validationMessage) {
                            // Still open with a problem: ask again, the problem as the prompt.
                            visible = false;
                            box.show();
                            return;
                        }
                    }
                    if (visible && mine === generation) {
                        visible = false;
                        hideEmitter.fire();
                    }
                });
            },
            hide() {
                if (visible) {
                    visible = false;
                    generation++;
                    hideEmitter.fire();
                }
            },
            dispose() {
                box.hide();
                accept.dispose();
                hideEmitter.dispose();
            },
        };
        return box;
    }

    async function showDialog(request: DialogRequest): Promise<string[] | null> {
        const answer = await host.rpc.request<string[] | null>(MAIN_METHODS.showDialog, request);
        return Array.isArray(answer) ? answer : null;
    }

    /* ------------------------------ status bar, progress ------------------------------ */

    function createStatusBarItem(idOrAlignment?: string | number, alignmentOrPriority?: number, maybePriority?: number) {
        const hasId = typeof idOrAlignment === 'string';
        const alignment = (hasId ? alignmentOrPriority : idOrAlignment) ?? types.StatusBarAlignment.Left;
        const priority = (hasId ? maybePriority : alignmentOrPriority) ?? 0;
        const key = host.nextKey(extensionId);
        const state = { text: '', tooltip: undefined as unknown, command: undefined as unknown, name: undefined as string | undefined, visible: false, disposed: false, color: undefined as unknown, backgroundColor: undefined as unknown, accessibilityInformation: undefined as unknown };
        let timer: ReturnType<typeof setTimeout> | null = null;
        const push = (): void => {
            if (state.disposed || timer) {
                return;
            }
            // Coalesce the several property writes extensions make in a row.
            timer = setTimeout(() => {
                timer = null;
                if (state.disposed) {
                    return;
                }
                const command = state.command as string | { command: string; arguments?: unknown[] } | undefined;
                const tooltip = state.tooltip as string | { value: string } | undefined;
                const item: StatusBarItemData = {
                    key, extensionId, text: state.text, alignment: alignment === types.StatusBarAlignment.Right ? 'right' : 'left', priority, visible: state.visible,
                    ...(tooltip ? { tooltip: typeof tooltip === 'string' ? tooltip : String(tooltip.value ?? '') } : {}),
                    ...(typeof command === 'string' ? { command } : command && typeof command.command === 'string' ? { command: command.command, commandArgs: command.arguments ?? [] } : {}),
                    ...(state.name ? { name: state.name } : {}),
                };
                host.uiNotify({ kind: 'statusBarItem', item });
            }, 0);
        };
        const item = {
            id: hasId ? idOrAlignment : `${extensionId}.${key}`,
            alignment,
            priority,
            show() {
                state.visible = true;
                push();
            },
            hide() {
                state.visible = false;
                push();
            },
            dispose() {
                state.disposed = true;
                host.uiNotify({ kind: 'statusBarItemDispose', key });
            },
        };
        for (const property of ['text', 'tooltip', 'command', 'name', 'color', 'backgroundColor', 'accessibilityInformation'] as const) {
            Object.defineProperty(item, property, {
                get: () => state[property],
                set: (value: unknown) => {
                    (state as Record<string, unknown>)[property] = value;
                    push();
                },
                enumerable: true,
            });
        }
        return item;
    }

    function setStatusBarMessage(text: string, hideAfterOrThenable?: number | PromiseLike<unknown>): Disposable {
        const timeoutMs = typeof hideAfterOrThenable === 'number' ? hideAfterOrThenable : 0;
        host.uiNotify({ kind: 'statusMessage', text: String(text), timeoutMs });
        const clear = new Disposable(() => host.uiNotify({ kind: 'statusMessage', text: '', timeoutMs: 0 }));
        if (hideAfterOrThenable && typeof hideAfterOrThenable === 'object') {
            void Promise.resolve(hideAfterOrThenable).finally(() => clear.dispose());
        }
        return clear;
    }

    async function withProgress<R>(options: { location: unknown; title?: string; cancellable?: boolean }, task: (progress: { report(value: { message?: string; increment?: number }): void }, token: CancellationToken) => PromiseLike<R>): Promise<R> {
        const key = host.nextKey(extensionId);
        const displayName = record.description.packageJSON['displayName'];
        const title = options.title ?? (typeof displayName === 'string' ? displayName : extensionId);
        let percent: number | undefined;
        let message: string | undefined;
        const showsNotification = options.location === types.ProgressLocation.Notification;
        const update = (): void => {
            if (showsNotification) {
                host.uiNotify({ kind: 'progress', key, title, ...(message ? { message } : {}), ...(percent !== undefined ? { percent } : {}) });
            } else {
                host.uiNotify({ kind: 'statusMessage', text: message ? `${title}: ${message}` : title, timeoutMs: 0 });
            }
        };
        update();
        const source = new types.CancellationTokenSource();
        try {
            return await task({
                report(value) {
                    if (typeof value.increment === 'number') {
                        percent = Math.min(100, (percent ?? 0) + value.increment);
                    }
                    if (typeof value.message === 'string') {
                        message = value.message;
                    }
                    update();
                },
            }, source.token);
        } finally {
            source.dispose();
            host.uiNotify(showsNotification ? { kind: 'progressEnd', key } : { kind: 'statusMessage', text: '', timeoutMs: 0 });
        }
    }

    /* ------------------------------ documents ------------------------------ */

    async function openTextDocument(arg?: unknown): Promise<TextDocumentModel> {
        if (arg === undefined || (typeof arg === 'object' && arg !== null && !(arg instanceof Uri))) {
            const options = (arg ?? {}) as { content?: string; language?: string };
            const uri = Uri.from({ scheme: 'untitled', path: `Untitled-${host.nextKey(extensionId).split('/')[1]}` });
            const document = new TextDocumentModel(uri, options.language ?? 'plaintext', 1, options.content ?? '');
            host.documents.set(uri.toString(), document);
            return document;
        }
        const uri = typeof arg === 'string' ? Uri.file(arg) : arg as Uri;
        const known = host.documents.get(uri.toString());
        if (known && !known.isClosed) {
            return known;
        }
        if (uri.scheme !== 'file') {
            const provider = host.contentProviders.get(uri.scheme);
            if (!provider) {
                throw new Error(`cannot open ${uri.toString()}. Detail: There is no provider for the '${uri.scheme}' scheme`);
            }
            const content = await provider.provideTextDocumentContent(uri, CancellationTokenNone);
            const document = new TextDocumentModel(uri, 'plaintext', 1, typeof content === 'string' ? content : '');
            host.documents.set(uri.toString(), document);
            return document;
        }
        let text: string;
        try {
            text = await fsp.readFile(uri.fsPath, 'utf8');
        } catch (error) {
            throw toFsError(error, uri);
        }
        const document = new TextDocumentModel(uri, host.languageOf(uri.fsPath), 1, text, async (doc) => {
            await fsp.writeFile(doc.uri.fsPath, doc.getText());
            doc.isDirty = false;
            return true;
        });
        host.documents.set(uri.toString(), document);
        return document;
    }

    /* ------------------------------ file system ------------------------------ */

    const fileSystem = {
        stat: async (target: Uri) => {
            const uri = fileUri(target);
            try {
                const lstat = await fsp.lstat(uri.fsPath);
                const stat = lstat.isSymbolicLink() ? await fsp.stat(uri.fsPath).catch(() => lstat) : lstat;
                const type = (stat.isDirectory() ? FileType.Directory : stat.isFile() ? FileType.File : FileType.Unknown) | (lstat.isSymbolicLink() ? FileType.SymbolicLink : 0);
                return { type, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
            } catch (error) {
                throw toFsError(error, uri);
            }
        },
        readDirectory: async (target: Uri) => {
            const uri = fileUri(target);
            try {
                const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
                return entries.map((entry) => [entry.name, (entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.Unknown) | (entry.isSymbolicLink() ? FileType.SymbolicLink : 0)] as [string, number]);
            } catch (error) {
                throw toFsError(error, uri);
            }
        },
        createDirectory: async (target: Uri) => {
            const uri = fileUri(target);
            await fsp.mkdir(uri.fsPath, { recursive: true }).catch((error: unknown) => {
                throw toFsError(error, uri);
            });
        },
        readFile: async (target: Uri) => {
            const uri = fileUri(target);
            try {
                return new Uint8Array(await fsp.readFile(uri.fsPath));
            } catch (error) {
                throw toFsError(error, uri);
            }
        },
        writeFile: async (target: Uri, content: Uint8Array) => {
            const uri = fileUri(target);
            try {
                await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
                await fsp.writeFile(uri.fsPath, content);
            } catch (error) {
                throw toFsError(error, uri);
            }
        },
        delete: async (target: Uri, options: { recursive?: boolean } = {}) => {
            const uri = fileUri(target);
            try {
                await fsp.rm(uri.fsPath, { recursive: options.recursive === true });
            } catch (error) {
                throw toFsError(error, uri);
            }
        },
        rename: async (source: Uri, target: Uri, options: { overwrite?: boolean } = {}) => {
            const from = fileUri(source);
            const to = fileUri(target);
            if (!options.overwrite && fs.existsSync(to.fsPath)) {
                throw FileSystemError.FileExists(to);
            }
            await fsp.rename(from.fsPath, to.fsPath).catch((error: unknown) => {
                throw toFsError(error, from);
            });
        },
        copy: async (source: Uri, target: Uri, options: { overwrite?: boolean } = {}) => {
            const from = fileUri(source);
            const to = fileUri(target);
            await fsp.cp(from.fsPath, to.fsPath, { recursive: true, force: options.overwrite === true, errorOnExist: options.overwrite !== true }).catch((error: unknown) => {
                throw toFsError(error, from);
            });
        },
        isWritableFileSystem: (scheme: string) => (scheme === 'file' ? true : undefined),
    };

    async function findFiles(include: unknown, exclude?: unknown, maxResults?: number, token: CancellationToken = CancellationTokenNone): Promise<Uri[]> {
        const patternOf = (value: unknown): { base: string; pattern: string } | null => {
            if (typeof value === 'string') {
                return workspaceRoot ? { base: workspaceRoot, pattern: value } : null;
            }
            if (value instanceof types.RelativePattern) {
                return { base: value.baseUri.fsPath, pattern: value.pattern };
            }
            return null;
        };
        const included = patternOf(include);
        if (!included) {
            return [];
        }
        const excluded = exclude === null ? null : patternOf(exclude);
        const skipDefault = exclude === undefined;
        const results: Uri[] = [];
        const limit = typeof maxResults === 'number' && maxResults > 0 ? maxResults : 10_000;
        const walk = async (folder: string): Promise<void> => {
            if (results.length >= limit || token.isCancellationRequested) {
                return;
            }
            let entries: fs.Dirent[];
            try {
                entries = await fsp.readdir(folder, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (results.length >= limit) {
                    return;
                }
                const full = path.join(folder, entry.name);
                const relative = path.relative(included.base, full).split(path.sep).join('/');
                if (skipDefault && (entry.name === '.git' || entry.name === 'node_modules')) {
                    continue;
                }
                if (excluded && matchGlob(excluded.pattern, path.relative(excluded.base, full).split(path.sep).join('/'))) {
                    continue;
                }
                if (entry.isDirectory()) {
                    await walk(full);
                } else if (entry.isFile() && matchGlob(included.pattern, relative)) {
                    results.push(Uri.file(full));
                }
            }
        };
        await walk(included.base);
        return results;
    }

    function createFileSystemWatcher(pattern: unknown, ignoreCreate = false, ignoreChange = false, ignoreDelete = false) {
        const created = new EventEmitter<Uri>();
        const changed = new EventEmitter<Uri>();
        const deleted = new EventEmitter<Uri>();
        const resolved = typeof pattern === 'string' ? (workspaceRoot ? { base: workspaceRoot, pattern } : null) : pattern instanceof types.RelativePattern ? { base: pattern.baseUri.fsPath, pattern: pattern.pattern } : null;
        let watcher: fs.FSWatcher | null = null;
        if (resolved && fs.existsSync(resolved.base)) {
            const known = new Set<string>();
            try {
                watcher = fs.watch(resolved.base, { recursive: true, persistent: false }, (_event, name) => {
                    if (!name) {
                        return;
                    }
                    const relative = name.toString().split(path.sep).join('/');
                    if (!matchGlob(resolved.pattern, relative) || relative.startsWith('.git/') || relative.includes('/node_modules/') || relative.startsWith('node_modules/')) {
                        return;
                    }
                    const full = path.join(resolved.base, name.toString());
                    const uri = Uri.file(full);
                    const exists = fs.existsSync(full);
                    if (!exists) {
                        known.delete(full);
                        if (!ignoreDelete) {
                            deleted.fire(uri);
                        }
                    } else if (known.has(full)) {
                        if (!ignoreChange) {
                            changed.fire(uri);
                        }
                    } else {
                        known.add(full);
                        if (!ignoreCreate) {
                            created.fire(uri);
                        }
                    }
                });
                watcher.on('error', () => undefined);
            } catch {
                watcher = null;
            }
        }
        return {
            ignoreCreateEvents: ignoreCreate,
            ignoreChangeEvents: ignoreChange,
            ignoreDeleteEvents: ignoreDelete,
            onDidCreate: created.event,
            onDidChange: changed.event,
            onDidDelete: deleted.event,
            dispose() {
                watcher?.close();
                created.dispose();
                changed.dispose();
                deleted.dispose();
            },
        };
    }

    const asRelativePath = (pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string => {
        const file = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
        if (!workspaceRoot || !(file === workspaceRoot || file.startsWith(workspaceRoot + path.sep))) {
            return typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
        }
        const relative = path.relative(workspaceRoot, file).split(path.sep).join('/');
        return includeWorkspaceFolder ? `${path.basename(workspaceRoot)}/${relative}` : relative;
    };

    const workspaceEvents = {
        onWillSaveTextDocument: new EventEmitter<unknown>(),
        onDidChangeWorkspaceFolders: new EventEmitter<unknown>(),
        onDidCreateFiles: new EventEmitter<unknown>(),
        onDidDeleteFiles: new EventEmitter<unknown>(),
        onDidRenameFiles: new EventEmitter<unknown>(),
        onWillCreateFiles: new EventEmitter<unknown>(),
        onWillDeleteFiles: new EventEmitter<unknown>(),
        onWillRenameFiles: new EventEmitter<unknown>(),
    };

    const workspace = withFallback('workspace', {
        get workspaceFolders() {
            return workspaceFolder ? [workspaceFolder] : undefined;
        },
        get name() {
            return workspaceFolder?.name;
        },
        get rootPath() {
            return workspaceRoot ?? undefined;
        },
        workspaceFile: undefined,
        get isTrusted() {
            return host.trusted;
        },
        onDidGrantWorkspaceTrust: host.onDidGrantWorkspaceTrust.event,
        getWorkspaceFolder: (uri: Uri) => (workspaceFolder && uri.scheme === 'file' && (uri.fsPath === workspaceRoot || uri.fsPath.startsWith((workspaceRoot ?? '') + path.sep)) ? workspaceFolder : undefined),
        asRelativePath,
        updateWorkspaceFolders: () => {
            report('workspace.updateWorkspaceFolders');
            return false;
        },
        getConfiguration: (section?: string) => host.configuration.get(section),
        onDidChangeConfiguration: host.onDidChangeConfiguration.event,
        get textDocuments() {
            return [...host.documents.values()].filter((document) => !document.isClosed);
        },
        openTextDocument,
        fs: fileSystem,
        findFiles,
        createFileSystemWatcher,
        registerTextDocumentContentProvider: (scheme: string, provider: { provideTextDocumentContent(uri: Uri, token: unknown): unknown }) => {
            host.contentProviders.set(scheme, provider);
            return new Disposable(() => {
                if (host.contentProviders.get(scheme) === provider) {
                    host.contentProviders.delete(scheme);
                }
            });
        },
        applyEdit: (edit: types.WorkspaceEdit) => host.documentsAndEditors.applyEdit(edit),
        saveAll: () => Promise.resolve(false),
        onDidOpenTextDocument: host.documentsAndEditors.onDidOpenTextDocument.event,
        onDidCloseTextDocument: host.documentsAndEditors.onDidCloseTextDocument.event,
        onDidChangeTextDocument: host.documentsAndEditors.onDidChangeTextDocument.event,
        onDidSaveTextDocument: host.documentsAndEditors.onDidSaveTextDocument.event,
        onWillSaveTextDocument: workspaceEvents.onWillSaveTextDocument.event,
        onDidChangeWorkspaceFolders: workspaceEvents.onDidChangeWorkspaceFolders.event,
        onDidCreateFiles: workspaceEvents.onDidCreateFiles.event,
        onDidDeleteFiles: workspaceEvents.onDidDeleteFiles.event,
        onDidRenameFiles: workspaceEvents.onDidRenameFiles.event,
        onWillCreateFiles: workspaceEvents.onWillCreateFiles.event,
        onWillDeleteFiles: workspaceEvents.onWillDeleteFiles.event,
        onWillRenameFiles: workspaceEvents.onWillRenameFiles.event,
        notebookDocuments: [],
        textDocumentsChanged: undefined,
    }, report);

    /* ------------------------------ window ------------------------------ */

    const windowEvents = {
        onDidChangeTextEditorOptions: new EventEmitter<unknown>(),
        onDidChangeTextEditorViewColumn: new EventEmitter<unknown>(),
        onDidChangeWindowState: new EventEmitter<unknown>(),
        onDidChangeActiveColorTheme: new EventEmitter<unknown>(),
        onDidOpenTerminal: new EventEmitter<unknown>(),
        onDidCloseTerminal: new EventEmitter<unknown>(),
        onDidChangeActiveTerminal: new EventEmitter<unknown>(),
        onDidChangeTerminalState: new EventEmitter<unknown>(),
    };

    /** The active editor when it shows `document`, else an editor object for it (edits still go through the workbench). */
    function editorFor(document: TextDocumentModel): TextEditorImpl {
        const active = host.documentsAndEditors.activeTextEditor;
        return active?.document === document ? active : new TextEditorImpl(host, document, null);
    }

    const window = withFallback('window', {
        get activeTextEditor() {
            return host.documentsAndEditors.activeTextEditor;
        },
        get visibleTextEditors() {
            return host.documentsAndEditors.visibleTextEditors;
        },
        activeTerminal: undefined,
        terminals: [],
        state: { focused: true, active: true },
        activeColorTheme: { kind: types.ColorThemeKind.Dark },
        showInformationMessage: (message: string, ...rest: unknown[]) => showMessage('info', message, rest),
        showWarningMessage: (message: string, ...rest: unknown[]) => showMessage('warning', message, rest),
        showErrorMessage: (message: string, ...rest: unknown[]) => showMessage('error', message, rest),
        showQuickPick,
        showInputBox,
        createQuickPick,
        createInputBox,
        showOpenDialog: async (options: { defaultUri?: Uri; openLabel?: string; canSelectFiles?: boolean; canSelectFolders?: boolean; canSelectMany?: boolean; filters?: Record<string, string[]>; title?: string } = {}) => {
            const paths = await showDialog({
                kind: 'open',
                ...(options.title ? { title: options.title } : {}),
                ...(options.defaultUri ? { defaultPath: options.defaultUri.fsPath } : {}),
                ...(options.openLabel ? { openLabel: options.openLabel } : {}),
                canSelectFiles: options.canSelectFiles !== false,
                canSelectFolders: options.canSelectFolders === true,
                canSelectMany: options.canSelectMany === true,
                ...(options.filters ? { filters: options.filters } : {}),
            });
            return paths ? paths.map((file) => Uri.file(file)) : undefined;
        },
        showSaveDialog: async (options: { defaultUri?: Uri; saveLabel?: string; filters?: Record<string, string[]>; title?: string } = {}) => {
            const paths = await showDialog({
                kind: 'save',
                ...(options.title ? { title: options.title } : {}),
                ...(options.defaultUri ? { defaultPath: options.defaultUri.fsPath } : {}),
                ...(options.saveLabel ? { openLabel: options.saveLabel } : {}),
                ...(options.filters ? { filters: options.filters } : {}),
            });
            return paths?.[0] ? Uri.file(paths[0]) : undefined;
        },
        showWorkspaceFolderPick: () => Promise.resolve(workspaceFolder),
        showTextDocument: async (target: unknown, columnOrOptions?: unknown) => {
            const document = target instanceof TextDocumentModel ? target : await openTextDocument(target);
            const options = typeof columnOrOptions === 'object' && columnOrOptions !== null ? columnOrOptions as { selection?: types.Range; preview?: boolean } : {};
            if (document.uri.scheme === 'file') {
                await host.ui({
                    kind: 'openFile', path: document.uri.fsPath, preview: options.preview !== false,
                    ...(options.selection ? { line: options.selection.start.line + 1, column: options.selection.start.character + 1 } : {}),
                });
            } else {
                report('window.showTextDocument (non-file document)');
            }
            return editorFor(document);
        },
        createOutputChannel,
        createStatusBarItem,
        setStatusBarMessage,
        withProgress,
        withScmProgress: <R>(task: (progress: { report(value: unknown): void }) => PromiseLike<R>) => task({ report: () => undefined }),
        createTextEditorDecorationType: () => ({ key: host.nextKey(extensionId), dispose: () => undefined }),
        registerUriHandler: () => new Disposable(() => undefined),
        onDidChangeActiveTextEditor: host.documentsAndEditors.onDidChangeActiveTextEditor.event,
        onDidChangeVisibleTextEditors: host.documentsAndEditors.onDidChangeVisibleTextEditors.event,
        onDidChangeTextEditorSelection: host.documentsAndEditors.onDidChangeTextEditorSelection.event,
        onDidChangeTextEditorVisibleRanges: host.documentsAndEditors.onDidChangeTextEditorVisibleRanges.event,
        onDidChangeTextEditorOptions: windowEvents.onDidChangeTextEditorOptions.event,
        onDidChangeTextEditorViewColumn: windowEvents.onDidChangeTextEditorViewColumn.event,
        onDidChangeWindowState: windowEvents.onDidChangeWindowState.event,
        onDidChangeActiveColorTheme: windowEvents.onDidChangeActiveColorTheme.event,
        onDidOpenTerminal: windowEvents.onDidOpenTerminal.event,
        onDidCloseTerminal: windowEvents.onDidCloseTerminal.event,
        onDidChangeActiveTerminal: windowEvents.onDidChangeActiveTerminal.event,
        onDidChangeTerminalState: windowEvents.onDidChangeTerminalState.event,
        tabGroups: host.documentsAndEditors.tabGroups,
    }, report);

    /* ------------------------------ env ------------------------------ */

    const env = withFallback('env', {
        appName: data.env.appName,
        appRoot: data.env.appRoot,
        appHost: data.env.appHost,
        language: data.env.language,
        machineId: data.env.machineId,
        sessionId: data.env.sessionId,
        uriScheme: data.env.uriScheme,
        shell: data.env.shell,
        uiKind: types.UIKind.Desktop,
        remoteName: undefined,
        isNewAppInstall: false,
        // No telemetry, ever (project principle): extensions that honour this send none.
        isTelemetryEnabled: false,
        onDidChangeTelemetryEnabled: new EventEmitter<boolean>().event,
        onDidChangeShell: new EventEmitter<string>().event,
        logLevel: types.LogLevel.Info,
        onDidChangeLogLevel: new EventEmitter<number>().event,
        createTelemetryLogger: () => ({
            logUsage: () => undefined, logError: () => undefined, dispose: () => undefined, isUsageEnabled: false, isErrorsEnabled: false, onDidChangeEnableStates: new EventEmitter<unknown>().event,
        }),
        clipboard: {
            readText: () => host.rpc.request<string>(MAIN_METHODS.clipboardRead).then((text) => text ?? ''),
            writeText: (text: string) => host.rpc.request(MAIN_METHODS.clipboardWrite, String(text)).then(() => undefined),
        },
        openExternal: (target: Uri) => host.rpc.request<boolean>(MAIN_METHODS.openExternal, target.toString(true)).then((opened) => opened === true),
        asExternalUri: (target: Uri) => Promise.resolve(target),
    }, report);

    /* ------------------------------ extensions ------------------------------ */

    const extensions = withFallback('extensions', {
        getExtension: (id: string) => host.extensionObject(id),
        get all() {
            return [...host.records.keys(), ...host.passive.map((extension) => extension.id)].map((id) => host.extensionObject(id)).filter(Boolean);
        },
        get allAcrossExtensionHosts() {
            return extensions.all;
        },
        onDidChange: host.onDidChangeExtensions.event,
    }, report);

    /* ------------------------------ languages (#260) ------------------------------ */

    const createDiagnosticCollection = (name?: string): unknown => host.languageFeatures.createDiagnosticCollection(extensionId, name ?? `${extensionId}.diagnostics`);
    const features = host.languageFeatures;
    const register = (kind: Parameters<typeof features.register>[1], extra: Parameters<typeof features.register>[4] = {}) => (selector: unknown, provider: unknown) => features.register(extensionId, kind, selector, provider, extra);
    const triggers = (values: readonly unknown[]): string[] => values.filter((value): value is string => typeof value === 'string' && value.length > 0);
    const providers = {
        registerHoverProvider: register('hover'),
        registerCompletionItemProvider: (selector: unknown, provider: { resolveCompletionItem?: unknown }, ...triggerCharacters: unknown[]) => features.register(extensionId, 'completion', selector, provider, {
            triggerCharacters: triggers(triggerCharacters), resolves: typeof provider?.resolveCompletionItem === 'function',
        }),
        registerDefinitionProvider: register('definition'),
        registerDeclarationProvider: register('declaration'),
        registerTypeDefinitionProvider: register('typeDefinition'),
        registerImplementationProvider: register('implementation'),
        registerReferenceProvider: register('references'),
        registerDocumentSymbolProvider: (selector: unknown, provider: unknown, metadata?: { label?: string }) => features.register(extensionId, 'documentSymbol', selector, provider, metadata?.label ? { label: metadata.label } : {}),
        registerDocumentHighlightProvider: register('documentHighlight'),
        registerSignatureHelpProvider: (selector: unknown, provider: unknown, first?: unknown, ...rest: unknown[]) => {
            const metadata = typeof first === 'object' && first !== null ? first as { triggerCharacters?: unknown[]; retriggerCharacters?: unknown[] } : { triggerCharacters: [first, ...rest] };
            return features.register(extensionId, 'signatureHelp', selector, provider, { triggerCharacters: triggers(metadata.triggerCharacters ?? []), retriggerCharacters: triggers(metadata.retriggerCharacters ?? []) });
        },
        registerDocumentFormattingEditProvider: register('formatting'),
        registerDocumentRangeFormattingEditProvider: register('rangeFormatting'),
        registerOnTypeFormattingEditProvider: (selector: unknown, provider: unknown, first: unknown, ...more: unknown[]) => features.register(extensionId, 'onTypeFormatting', selector, provider, { triggerCharacters: triggers([first, ...more]) }),
        registerCodeActionsProvider: (selector: unknown, provider: unknown, metadata?: { providedCodeActionKinds?: readonly { value?: unknown }[] }) => features.register(extensionId, 'codeAction', selector, provider, {
            providedCodeActionKinds: (metadata?.providedCodeActionKinds ?? []).map((kind) => String(kind?.value ?? '')),
        }),
        registerCodeLensProvider: (selector: unknown, provider: { resolveCodeLens?: unknown; onDidChangeCodeLenses?: unknown }) => features.register(extensionId, 'codeLens', selector, provider, { resolves: typeof provider?.resolveCodeLens === 'function' }),
        registerRenameProvider: register('rename'),
        registerFoldingRangeProvider: register('foldingRange'),
        registerInlayHintsProvider: register('inlayHints'),
        registerDocumentLinkProvider: register('documentLink'),
    };

    const matchSelector = (selector: unknown, document: { languageId: string; uri: Uri }): number => {
        const selectors = Array.isArray(selector) ? selector : [selector];
        let best = 0;
        for (const one of selectors) {
            if (typeof one === 'string') {
                best = Math.max(best, one === document.languageId ? 10 : one === '*' ? 5 : 0);
            } else if (typeof one === 'object' && one !== null) {
                const filter = one as { language?: string; scheme?: string; pattern?: string | types.RelativePattern };
                let score = 0;
                if (filter.language) {
                    score = filter.language === document.languageId ? 10 : filter.language === '*' ? 5 : -1;
                }
                if (score >= 0 && filter.scheme) {
                    score = filter.scheme === document.uri.scheme ? Math.max(score, 10) : filter.scheme === '*' ? Math.max(score, 5) : -1;
                }
                if (score >= 0 && filter.pattern) {
                    const pattern = typeof filter.pattern === 'string' ? filter.pattern : filter.pattern.pattern;
                    const base = typeof filter.pattern === 'string' ? '' : filter.pattern.baseUri.fsPath;
                    const subject = base ? path.relative(base, document.uri.fsPath).split(path.sep).join('/') : document.uri.fsPath.split(path.sep).join('/');
                    score = matchGlob(pattern, subject) || matchGlob(pattern.startsWith('**/') ? pattern : `**/${pattern}`, subject) ? Math.max(score, 10) : -1;
                }
                best = Math.max(best, score);
            }
        }
        return best;
    };

    const languages = withFallback('languages', {
        getLanguages: () => Promise.resolve(host.allLanguages()),
        createDiagnosticCollection,
        getDiagnostics: (uri?: Uri) => features.getDiagnostics(uri),
        onDidChangeDiagnostics: features.onDidChangeDiagnostics.event,
        ...providers,
        match: matchSelector,
        setTextDocumentLanguage: (document: TextDocumentModel, languageId: string) => {
            document.languageId = languageId;
            return Promise.resolve(document);
        },
        setLanguageConfiguration: () => new Disposable(() => undefined),
        createLanguageStatusItem: (id: string) => ({ id, name: undefined, selector: undefined, severity: 0, text: '', detail: undefined, busy: false, command: undefined, accessibilityInformation: undefined, dispose: () => undefined }),
    }, report);

    /* ------------------------------ l10n ------------------------------ */

    const l10n = {
        bundle: undefined,
        uri: undefined,
        t(messageOrOptions: string | { message: string; args?: unknown[] | Record<string, unknown> }, ...args: unknown[]): string {
            if (typeof messageOrOptions === 'object' && messageOrOptions !== null) {
                return formatMessage(messageOrOptions.message, messageOrOptions.args ?? []);
            }
            const first = args[0];
            return formatMessage(String(messageOrOptions), args.length === 1 && typeof first === 'object' && first !== null && !Array.isArray(first) ? first as Record<string, unknown> : args);
        },
    };

    /* ------------------------------ the rest: shapes only ------------------------------ */

    const debug = missingNamespace('debug', report, {
        activeDebugSession: undefined,
        activeDebugConsole: { append: () => undefined, appendLine: () => undefined },
        breakpoints: [],
        registerDebugConfigurationProvider: () => new Disposable(() => undefined),
        registerDebugAdapterDescriptorFactory: () => new Disposable(() => undefined),
        registerDebugAdapterTrackerFactory: () => new Disposable(() => undefined),
        onDidStartDebugSession: new EventEmitter<unknown>().event,
        onDidTerminateDebugSession: new EventEmitter<unknown>().event,
        onDidChangeActiveDebugSession: new EventEmitter<unknown>().event,
        onDidReceiveDebugSessionCustomEvent: new EventEmitter<unknown>().event,
        onDidChangeBreakpoints: new EventEmitter<unknown>().event,
        startDebugging: () => {
            report('debug.startDebugging');
            return Promise.resolve(false);
        },
    });
    const tasks = missingNamespace('tasks', report, {
        taskExecutions: [],
        registerTaskProvider: () => new Disposable(() => undefined),
        fetchTasks: () => Promise.resolve([]),
        onDidStartTask: new EventEmitter<unknown>().event,
        onDidEndTask: new EventEmitter<unknown>().event,
        onDidStartTaskProcess: new EventEmitter<unknown>().event,
        onDidEndTaskProcess: new EventEmitter<unknown>().event,
    });
    const authentication = missingNamespace('authentication', report, {
        getSession: () => Promise.resolve(undefined),
        getAccounts: () => Promise.resolve([]),
        onDidChangeSessions: new EventEmitter<unknown>().event,
        registerAuthenticationProvider: () => new Disposable(() => undefined),
    });

    const vscode: Record<string, unknown> = {
        version: HOST_VSCODE_API_VERSION,
        ...types,
        // Not part of the API surface.
        CancellationTokenNone: undefined,
        CancellationToken: { None: CancellationTokenNone, Cancelled: Object.freeze({ isCancellationRequested: true, onCancellationRequested: new EventEmitter<unknown>().event }) },
        commands,
        window,
        workspace,
        env,
        extensions,
        languages,
        l10n,
        debug,
        tasks,
        authentication,
        scm: missingNamespace('scm', report, { inputBox: undefined }),
        tests: missingNamespace('tests', report),
        notebooks: missingNamespace('notebooks', report),
        comments: missingNamespace('comments', report),
        chat: missingNamespace('chat', report),
        lm: missingNamespace('lm', report, { tools: [], onDidChangeChatModels: new EventEmitter<unknown>().event, selectChatModels: () => Promise.resolve([]) }),
    };
    delete vscode['CancellationTokenNone'];
    return new Proxy(Object.freeze(vscode), {
        get(target, property, receiver) {
            if (typeof property === 'symbol' || property in target) {
                return Reflect.get(target, property, receiver) as unknown;
            }
            if (property === 'then' || property === 'default' || property === '__esModule') {
                return property === 'default' ? receiver : undefined;
            }
            report(property);
            return undefined;
        },
    });
}
