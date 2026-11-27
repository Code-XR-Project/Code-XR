import crypto from 'node:crypto';
import path from 'node:path';
import { MAIN_METHODS } from '../shared/extensionHostProtocol.ts';
import { webviewOrigin, webviewResourceUrl, type WebviewHostEvent, type WebviewOptionsData, type WebviewWorkbenchEvent } from '../shared/extensionWebviewProtocol.ts';
import type { ExtensionId } from '../shared/extensions.ts';
import type { ExtensionHost } from './host.ts';
import { CancellationTokenNone, Disposable, EventEmitter, Uri, ViewColumn } from './types.ts';
import { fromWire, toWire } from './wire.ts';

/**
 * #261: extensions' webviews. `window.createWebviewPanel` opens an editor tab,
 * `registerWebviewViewProvider` fills a contributed view of `type: "webview"`.
 * The extension's objects live here; the HTML goes to the main process, which
 * serves it on the webview's own origin (`codexr-webview://<id>/`), and the
 * workbench shows it in a sandboxed frame. Messages travel both ways as
 * structured clones (`Uri`s as tagged objects, like command arguments).
 */

interface WebviewOptionsInput {
    readonly enableScripts?: boolean;
    readonly enableForms?: boolean;
    readonly enableCommandUris?: boolean | readonly string[];
    readonly localResourceRoots?: readonly unknown[];
}

/** One webview's `Webview` object (`panel.webview`, `view.webview`). */
class WebviewImpl {
    private htmlValue = '';
    private optionsValue: WebviewOptionsInput;
    readonly onDidReceiveMessageEmitter = new EventEmitter<unknown>();
    readonly onDidReceiveMessage = this.onDidReceiveMessageEmitter.event;
    readonly cspSource: string;
    disposed = false;

    private readonly owner: Webviews;
    readonly id: string;
    private readonly extensionLocation: string;

    constructor(owner: Webviews, id: string, extensionLocation: string, options: WebviewOptionsInput) {
        this.owner = owner;
        this.id = id;
        this.extensionLocation = extensionLocation;
        this.optionsValue = options;
        this.cspSource = webviewOrigin(id);
    }

    get html(): string {
        return this.htmlValue;
    }

    set html(value: string) {
        if (this.disposed) {
            return;
        }
        this.htmlValue = String(value);
        this.owner.send({ kind: 'html', id: this.id, html: this.htmlValue });
    }

    get options(): WebviewOptionsInput {
        return this.optionsValue;
    }

    set options(value: WebviewOptionsInput) {
        if (this.disposed) {
            return;
        }
        this.optionsValue = value ?? {};
        this.owner.send({ kind: 'options', id: this.id, options: this.data() });
    }

    data(): WebviewOptionsData {
        const options = this.optionsValue;
        const commandUris = options.enableCommandUris;
        return {
            enableScripts: options.enableScripts === true,
            enableForms: options.enableForms ?? options.enableScripts === true,
            enableCommandUris: Array.isArray(commandUris) ? commandUris.filter((command): command is string => typeof command === 'string') : commandUris === true,
            localResourceRoots: this.roots(),
        };
    }

    /** `localResourceRoots`, or by default the extension's folder and the workspace folder (as VS Code). */
    private roots(): string[] {
        const given = this.optionsValue.localResourceRoots;
        if (Array.isArray(given)) {
            return given.flatMap((root) => {
                if (root instanceof Uri && root.scheme === 'file') {
                    return [root.fsPath];
                }
                return typeof root === 'string' && path.isAbsolute(root) ? [root] : [];
            });
        }
        const folder = this.owner.workspaceFolder();
        return [this.extensionLocation, ...(folder ? [folder] : [])];
    }

    postMessage(message: unknown): Promise<boolean> {
        if (this.disposed) {
            return Promise.resolve(false);
        }
        this.owner.send({ kind: 'post', id: this.id, message: toWire(message) });
        return Promise.resolve(true);
    }

    asWebviewUri(resource: Uri): Uri {
        if (!(resource instanceof Uri) || resource.scheme !== 'file') {
            return resource;
        }
        return Uri.parse(webviewResourceUrl(this.id, resource.path));
    }
}

class WebviewPanelImpl {
    readonly webview: WebviewImpl;
    private titleValue: string;
    iconPath: unknown = undefined;
    visible = true;
    active = true;
    viewColumn: number = ViewColumn.One;
    readonly onDidDisposeEmitter = new EventEmitter<void>();
    readonly onDidDispose = this.onDidDisposeEmitter.event;
    readonly onDidChangeViewStateEmitter = new EventEmitter<{ webviewPanel: WebviewPanelImpl }>();
    readonly onDidChangeViewState = this.onDidChangeViewStateEmitter.event;

    private readonly owner: Webviews;
    readonly viewType: string;
    readonly options: { retainContextWhenHidden?: boolean; enableFindWidget?: boolean };

    constructor(owner: Webviews, viewType: string, title: string, webview: WebviewImpl, options: { retainContextWhenHidden?: boolean; enableFindWidget?: boolean }) {
        this.owner = owner;
        this.viewType = viewType;
        this.options = options;
        this.webview = webview;
        this.titleValue = title;
    }

    get title(): string {
        return this.titleValue;
    }

    set title(value: string) {
        this.titleValue = String(value);
        if (!this.webview.disposed) {
            this.owner.send({ kind: 'title', id: this.webview.id, title: this.titleValue });
        }
    }

    reveal(viewColumn?: number, preserveFocus?: boolean): void {
        if (!this.webview.disposed) {
            void viewColumn;
            this.owner.send({ kind: 'reveal', id: this.webview.id, preserveFocus: preserveFocus === true });
        }
    }

    dispose(): void {
        this.owner.disposeWebview(this.webview.id, true);
    }
}

class WebviewViewImpl {
    private titleValue: string | undefined;
    private descriptionValue: string | undefined;
    badge: unknown = undefined;
    visible = true;
    readonly onDidDisposeEmitter = new EventEmitter<void>();
    readonly onDidDispose = this.onDidDisposeEmitter.event;
    readonly onDidChangeVisibilityEmitter = new EventEmitter<void>();
    readonly onDidChangeVisibility = this.onDidChangeVisibilityEmitter.event;

    private readonly owner: Webviews;
    readonly viewType: string;
    readonly webview: WebviewImpl;

    constructor(owner: Webviews, viewType: string, webview: WebviewImpl) {
        this.owner = owner;
        this.viewType = viewType;
        this.webview = webview;
    }

    get title(): string | undefined {
        return this.titleValue;
    }

    set title(value: string | undefined) {
        this.titleValue = value;
        if (typeof value === 'string' && !this.webview.disposed) {
            this.owner.send({ kind: 'title', id: this.webview.id, title: value });
        }
    }

    get description(): string | undefined {
        return this.descriptionValue;
    }

    set description(value: string | undefined) {
        this.descriptionValue = value;
    }

    show(preserveFocus?: boolean): void {
        if (!this.webview.disposed) {
            this.owner.send({ kind: 'reveal', id: this.webview.id, preserveFocus: preserveFocus === true });
        }
    }
}

interface WebviewEntry {
    readonly webview: WebviewImpl;
    readonly extensionId: ExtensionId;
    readonly panel: WebviewPanelImpl | null;
    readonly view: WebviewViewImpl | null;
}

interface ViewProvider {
    readonly extensionId: ExtensionId;
    readonly provider: { resolveWebviewView(view: unknown, context: unknown, token: unknown): unknown };
}

export class Webviews {
    private readonly entries = new Map<string, WebviewEntry>();
    private readonly viewProviders = new Map<string, ViewProvider>();
    /** viewId -> the webview id it was filled with. */
    private readonly resolvedViews = new Map<string, string>();

    private readonly host: ExtensionHost;

    constructor(host: ExtensionHost) {
        this.host = host;
    }

    send(event: WebviewHostEvent): void {
        this.host.rpc.notify(MAIN_METHODS.webview, event);
    }

    workspaceFolder(): string | null {
        return this.host.data?.workspaceFolder ?? null;
    }

    private location(extensionId: ExtensionId): string {
        return this.host.records.get(extensionId)?.description.location ?? '';
    }

    createPanel(extensionId: ExtensionId, viewType: string, title: string, showOptions: unknown, options: (WebviewOptionsInput & { retainContextWhenHidden?: boolean }) | undefined): WebviewPanelImpl {
        if (typeof viewType !== 'string' || viewType === '') {
            throw new Error('createWebviewPanel: viewType must be a non-empty string.');
        }
        const id = crypto.randomBytes(16).toString('hex');
        const webview = new WebviewImpl(this, id, this.location(extensionId), options ?? {});
        const panel = new WebviewPanelImpl(this, viewType, String(title), webview, options ?? {});
        const show = typeof showOptions === 'object' && showOptions !== null ? showOptions as { viewColumn?: unknown; preserveFocus?: unknown } : { viewColumn: showOptions };
        const beside = show.viewColumn === ViewColumn.Beside || (typeof show.viewColumn === 'number' && show.viewColumn >= 2);
        panel.viewColumn = beside ? ViewColumn.Two : ViewColumn.One;
        this.entries.set(id, { webview, extensionId, panel, view: null });
        this.send({ kind: 'create', id, extensionId, viewType, title: String(title), options: webview.data(), panel: { preserveFocus: show.preserveFocus === true, beside } });
        return panel;
    }

    registerViewProvider(extensionId: ExtensionId, viewId: string, provider: unknown): Disposable {
        if (typeof provider !== 'object' || provider === null || typeof (provider as { resolveWebviewView?: unknown }).resolveWebviewView !== 'function') {
            throw new Error(`registerWebviewViewProvider('${viewId}'): the provider has no resolveWebviewView.`);
        }
        if (this.viewProviders.has(viewId)) {
            throw new Error(`A webview view provider for '${viewId}' is already registered.`);
        }
        this.viewProviders.set(viewId, { extensionId, provider: provider as ViewProvider['provider'] });
        return new Disposable(() => {
            this.viewProviders.delete(viewId);
            const id = this.resolvedViews.get(viewId);
            if (id) {
                this.disposeWebview(id, true);
            }
        });
    }

    /** The workbench shows a webview view for the first time: fill it. */
    private async resolveView(viewId: string): Promise<string | null> {
        const existing = this.resolvedViews.get(viewId);
        if (existing && this.entries.has(existing)) {
            return existing;
        }
        if (!this.viewProviders.has(viewId)) {
            await this.host.activateByEvent(`onView:${viewId}`);
        }
        const registered = this.viewProviders.get(viewId);
        if (!registered) {
            return null;
        }
        const id = crypto.randomBytes(16).toString('hex');
        const webview = new WebviewImpl(this, id, this.location(registered.extensionId), {});
        const view = new WebviewViewImpl(this, viewId, webview);
        this.entries.set(id, { webview, extensionId: registered.extensionId, panel: null, view });
        this.resolvedViews.set(viewId, id);
        this.send({ kind: 'create', id, extensionId: registered.extensionId, viewType: viewId, title: '', options: webview.data(), panel: null, viewId });
        try {
            await registered.provider.resolveWebviewView(view, { state: undefined }, CancellationTokenNone);
        } catch (error) {
            this.host.log({ level: 'error', extensionId: registered.extensionId, message: `resolveWebviewView('${viewId}') failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}` });
        }
        return id;
    }

    disposeWebview(id: string, tellWorkbench: boolean): void {
        const entry = this.entries.get(id);
        if (!entry) {
            return;
        }
        this.entries.delete(id);
        entry.webview.disposed = true;
        if (entry.view) {
            this.resolvedViews.delete(entry.view.viewType);
        }
        if (tellWorkbench) {
            this.send({ kind: 'dispose', id });
        }
        if (entry.panel) {
            entry.panel.visible = false;
            entry.panel.active = false;
            entry.panel.onDidDisposeEmitter.fire();
        }
        entry.view?.onDidDisposeEmitter.fire();
        entry.webview.onDidReceiveMessageEmitter.dispose();
    }

    async request(event: WebviewWorkbenchEvent): Promise<unknown> {
        switch (event.kind) {
            case 'resolveView':
                return this.resolveView(event.viewId);
            case 'message': {
                const entry = this.entries.get(event.id);
                entry?.webview.onDidReceiveMessageEmitter.fire(fromWire(event.message));
                return null;
            }
            case 'closed':
                this.disposeWebview(event.id, false);
                return null;
            case 'viewState': {
                const entry = this.entries.get(event.id);
                if (entry?.panel && (entry.panel.visible !== event.visible || entry.panel.active !== event.active)) {
                    entry.panel.visible = event.visible;
                    entry.panel.active = event.active;
                    entry.panel.onDidChangeViewStateEmitter.fire({ webviewPanel: entry.panel });
                }
                if (entry?.view && entry.view.visible !== event.visible) {
                    entry.view.visible = event.visible;
                    entry.view.onDidChangeVisibilityEmitter.fire();
                }
                return null;
            }
            case 'command':
                // Checked by the main process against the webview's options; run like any command.
                return this.host.executeCommand(event.command, event.args.map((arg) => fromWire(arg)));
            default:
                return null;
        }
    }
}
