import { parseCommandHref, webviewOrigin, type WebviewOptionsData, type WebviewUiEvent, type WebviewWorkbenchEvent } from '../../shared/extensionWebviewProtocol.ts';
import { el } from '../dom.ts';
import type { CustomEditorContext, CustomEditorInput, CustomEditorView } from '../editor/customEditor.ts';

/**
 * #261: the workbench side of extensions' webviews. Each webview is an
 * `<iframe>` on its own origin (`codexr-webview://<id>/`), sandboxed without
 * popups or top navigation, that cannot reach `window.codexr`. Frames live in
 * one layer over the workbench and are laid over a slot (a panel's tab or a
 * view's section) while it is visible: moving a frame in the DOM would reload
 * it, so a hidden tab or a rebuilt section never costs the page its state.
 *
 * Talks to the page through `postMessage` only: messages of the page carry a
 * `__codexrWebview` tag and are accepted only from that frame's window.
 */

export interface WebviewHostDeps {
    send(event: WebviewWorkbenchEvent): Promise<unknown>;
    openCustom(input: CustomEditorInput, options: { preview: boolean; preserveFocus: boolean; beside: boolean }): void;
    openExternalLink(url: string): void;
    /** A workbench shortcut pressed while a webview has the focus. */
    forwardKey(init: KeyboardEventInit): void;
    onError(message: string): void;
}

export interface WebviewHost {
    event(event: WebviewUiEvent): void;
    /** A webview view's slot became visible (an element) or hidden (null). */
    setViewSlot(viewId: string, slot: HTMLElement | null): void;
    /** The extension host stopped: every webview is gone. */
    reset(): void;
}

interface Frame {
    readonly id: string;
    readonly iframe: HTMLIFrameElement;
    readonly wrapper: HTMLElement;
    options: WebviewOptionsData;
    version: number;
    state: unknown;
    loaded: boolean;
    readonly queue: unknown[];
    slot: HTMLElement | null;
    title: string;
    /** Panels: the tab that holds it. */
    context: CustomEditorContext | null;
    readonly viewId: string | null;
    visible: boolean;
    active: boolean;
}

const SANDBOX_BASE = ['allow-same-origin', 'allow-pointer-lock', 'allow-downloads'];

/** The theme a page gets: the workbench's colours as `--vscode-*` variables, and its kind. */
export function webviewTheme(root: HTMLElement = document.documentElement): { kind: string; vars: Record<string, string> } {
    const style = getComputedStyle(root);
    const token = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
    const fg = token('--fg', '#d5dce5');
    const editor = token('--editor', '#0e1319');
    const panel = token('--panel', editor);
    const line = token('--line', '#232c37');
    const accent = token('--accent', '#2fb0ff');
    const muted = token('--muted', fg);
    const vars: Record<string, string> = {
        '--vscode-font-family': style.fontFamily || 'system-ui, sans-serif',
        '--vscode-font-size': '13px',
        '--vscode-font-weight': 'normal',
        '--vscode-editor-font-family': 'ui-monospace, "Cascadia Code", Menlo, Consolas, monospace',
        '--vscode-editor-font-size': '13px',
        '--vscode-editor-font-weight': 'normal',
        '--vscode-foreground': fg,
        '--vscode-descriptionForeground': muted,
        '--vscode-errorForeground': token('--crit', '#f85149'),
        '--vscode-focusBorder': accent,
        '--vscode-editor-background': editor,
        '--vscode-editor-foreground': fg,
        '--vscode-sideBar-background': panel,
        '--vscode-sideBar-foreground': fg,
        '--vscode-panel-background': panel,
        '--vscode-panel-border': line,
        '--vscode-widget-border': line,
        '--vscode-button-background': accent,
        '--vscode-button-foreground': '#ffffff',
        '--vscode-button-hoverBackground': accent,
        '--vscode-button-secondaryBackground': token('--hover', line),
        '--vscode-button-secondaryForeground': fg,
        '--vscode-input-background': editor,
        '--vscode-input-foreground': fg,
        '--vscode-input-border': line,
        '--vscode-input-placeholderForeground': muted,
        '--vscode-dropdown-background': editor,
        '--vscode-dropdown-foreground': fg,
        '--vscode-dropdown-border': line,
        '--vscode-checkbox-background': editor,
        '--vscode-checkbox-border': line,
        '--vscode-textLink-foreground': accent,
        '--vscode-textLink-activeForeground': accent,
        '--vscode-textPreformat-foreground': fg,
        '--vscode-textBlockQuote-background': panel,
        '--vscode-textCodeBlock-background': panel,
        '--vscode-list-hoverBackground': token('--hover', line),
        '--vscode-list-activeSelectionBackground': token('--hover', line),
        '--vscode-badge-background': accent,
        '--vscode-badge-foreground': '#ffffff',
        '--vscode-progressBar-background': accent,
        '--vscode-scrollbarSlider-background': `${muted}55`,
        '--vscode-scrollbarSlider-hoverBackground': `${muted}88`,
        '--vscode-editorWidget-background': panel,
    };
    // An extension's colour theme sets its own colours on the root (themeModel.ts): they win.
    for (let i = 0; i < root.style.length; i += 1) {
        const name = root.style.item(i);
        if (name.startsWith('--vscode-')) {
            vars[name] = root.style.getPropertyValue(name).trim();
        }
    }
    return { kind: isDark(editor) ? 'vscode-dark' : 'vscode-light', vars };
}

function isDark(color: string): boolean {
    const hex = /^#([0-9a-f]{6})/i.exec(color)?.[1];
    if (hex) {
        const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
    }
    const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color);
    if (rgb) {
        return (0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])) / 255 < 0.5;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function createWebviewHost(deps: WebviewHostDeps): WebviewHost {
    const frames = new Map<string, Frame>();
    const viewFrames = new Map<string, string>();
    const viewSlots = new Map<string, HTMLElement>();
    const resolving = new Set<string>();
    const layer = el('div', { className: 'webview-layer', attrs: { 'data-testid': 'webview-layer' } });
    document.body.append(layer);
    let raf = 0;

    const frameOfWindow = (source: MessageEventSource | null): Frame | undefined => {
        for (const frame of frames.values()) {
            if (frame.iframe.contentWindow === source) {
                return frame;
            }
        }
        return undefined;
    };

    const send = (event: WebviewWorkbenchEvent): void => {
        void deps.send(event).catch((error: unknown) => deps.onError(`A webview message failed: ${String(error)}`));
    };

    const sandbox = (options: WebviewOptionsData): string =>
        [...SANDBOX_BASE, ...(options.enableScripts ? ['allow-scripts'] : []), ...(options.enableForms ? ['allow-forms'] : [])].join(' ');

    function load(frame: Frame): void {
        frame.loaded = false;
        frame.iframe.setAttribute('sandbox', sandbox(frame.options));
        // The page's saved state (`getState`) survives a reload in the frame's name.
        frame.iframe.name = frame.state === undefined ? '' : JSON.stringify(frame.state);
        frame.iframe.src = `${webviewOrigin(frame.id)}/index.html?v=${frame.version}#${encodeURIComponent(JSON.stringify(webviewTheme()))}`;
    }

    /** Whether the slot is what the person sees near its top-left corner (not under an overlay such as an extension's details page). */
    function onTop(slot: HTMLElement, box: DOMRect): boolean {
        const hits = document.elementsFromPoint(box.left + Math.min(box.width / 2, 24), box.top + Math.min(box.height / 2, 12));
        const first = hits.find((element) => !layer.contains(element));
        return first !== undefined && (first === slot || slot.contains(first));
    }

    function place(): void {
        raf = 0;
        let any = false;
        for (const frame of frames.values()) {
            const slot = frame.slot;
            if (!slot || !slot.isConnected) {
                frame.wrapper.hidden = true;
                continue;
            }
            const box = slot.getBoundingClientRect();
            const shown = box.width > 0 && box.height > 0 && onTop(slot, box);
            frame.wrapper.hidden = !shown;
            if (shown) {
                Object.assign(frame.wrapper.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
            }
            any = true;
        }
        // While a frame is shown its slot can move with any layout change (a sash, the side bar): follow it every frame.
        if (any) {
            raf = requestAnimationFrame(place);
        }
    }

    const schedule = (): void => {
        if (raf === 0) {
            raf = requestAnimationFrame(place);
        }
    };

    function setVisible(frame: Frame, visible: boolean, active: boolean): void {
        if (frame.visible === visible && frame.active === active) {
            return;
        }
        frame.visible = visible;
        frame.active = active;
        send({ kind: 'viewState', id: frame.id, visible, active });
    }

    function create(event: Extract<WebviewUiEvent, { kind: 'create' }>): void {
        const iframe = el('iframe', {
            className: 'webview-frame',
            attrs: { title: event.title || event.viewType, allow: 'clipboard-read; clipboard-write', 'data-testid': `webview-frame-${event.viewId ?? event.viewType}` },
        });
        const wrapper = el('div', { className: 'webview-wrapper', attrs: { hidden: '' } }, [iframe]);
        layer.append(wrapper);
        const frame: Frame = {
            id: event.id, iframe, wrapper, options: event.options, version: 0, state: undefined, loaded: false, queue: [], slot: null,
            title: event.title, context: null, viewId: event.viewId ?? null, visible: event.viewId !== undefined, active: event.viewId === undefined,
        };
        iframe.setAttribute('sandbox', sandbox(event.options));
        iframe.addEventListener('load', () => {
            // The first (about:blank) load of a frame that has no page yet does not count.
            if (frame.version === 0) {
                return;
            }
            frame.loaded = true;
            for (const message of frame.queue.splice(0)) {
                iframe.contentWindow?.postMessage(message, webviewOrigin(frame.id));
            }
        });
        frames.set(event.id, frame);
        if (event.viewId !== undefined) {
            viewFrames.set(event.viewId, event.id);
            frame.slot = viewSlots.get(event.viewId) ?? null;
            schedule();
            return;
        }
        const input: CustomEditorInput = {
            id: `webview:${event.id}`,
            title: event.title,
            create(context): CustomEditorView {
                const slot = el('div', { className: 'webview-slot' });
                if (frame.context) {
                    // The same panel in the other group: one frame, shown where it was opened first.
                    slot.append(el('p', { className: 'muted webview-elsewhere', text: 'This webview is open in the other editor group.' }));
                    return { element: slot };
                }
                frame.context = context;
                return {
                    element: slot,
                    onShow() {
                        frame.slot = slot;
                        setVisible(frame, true, true);
                        schedule();
                    },
                    onHide() {
                        frame.slot = null;
                        frame.wrapper.hidden = true;
                        setVisible(frame, false, false);
                    },
                    focus() {
                        frame.iframe.focus();
                    },
                    dispose() {
                        if (frames.get(frame.id) === frame) {
                            remove(frame);
                            send({ kind: 'closed', id: frame.id });
                        }
                    },
                };
            },
        };
        deps.openCustom(input, { preview: false, preserveFocus: event.panel?.preserveFocus === true, beside: event.panel?.beside === true });
    }

    function remove(frame: Frame): void {
        frames.delete(frame.id);
        if (frame.viewId !== null && viewFrames.get(frame.viewId) === frame.id) {
            viewFrames.delete(frame.viewId);
        }
        frame.wrapper.remove();
    }

    window.addEventListener('message', (event: MessageEvent) => {
        const frame = frameOfWindow(event.source);
        const data: unknown = event.data;
        if (!frame || event.origin !== webviewOrigin(frame.id) || typeof data !== 'object' || data === null || !('__codexrWebview' in data)) {
            return;
        }
        const { __codexrWebview: kind, payload } = data as { __codexrWebview: unknown; payload: unknown };
        switch (kind) {
            case 'post':
                send({ kind: 'message', id: frame.id, message: payload });
                break;
            case 'state':
                frame.state = payload;
                break;
            case 'link':
                if (typeof payload === 'string' && /^(https?|mailto):/i.test(payload)) {
                    deps.openExternalLink(payload);
                }
                break;
            case 'command': {
                const parsed = typeof payload === 'string' ? parseCommandHref(payload) : null;
                if (parsed) {
                    send({ kind: 'command', id: frame.id, command: parsed.command, args: parsed.args });
                }
                break;
            }
            case 'focus':
                if (frame.viewId === null) {
                    setVisible(frame, true, true);
                }
                break;
            case 'key':
                if (typeof payload === 'object' && payload !== null) {
                    const key = payload as Record<string, unknown>;
                    deps.forwardKey({
                        key: String(key['key']), code: String(key['code']), ctrlKey: key['ctrlKey'] === true, metaKey: key['metaKey'] === true,
                        altKey: key['altKey'] === true, shiftKey: key['shiftKey'] === true, bubbles: true, cancelable: true,
                    });
                }
                break;
            default:
                break;
        }
    });

    // The theme follows the workbench's: an extension theme, the OS scheme, the IDE's own setting.
    let themeTimer = 0;
    const themeChanged = (): void => {
        window.clearTimeout(themeTimer);
        themeTimer = window.setTimeout(() => {
            const theme = webviewTheme();
            for (const frame of frames.values()) {
                frame.iframe.contentWindow?.postMessage({ __codexrWebviewTheme: theme }, webviewOrigin(frame.id));
            }
        }, 50);
    };
    new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-extension-theme'] });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged);

    return {
        event(event) {
            if (event.kind === 'create') {
                create(event);
                return;
            }
            const frame = frames.get(event.id);
            if (!frame) {
                return;
            }
            switch (event.kind) {
                case 'html':
                    frame.version = event.version;
                    load(frame);
                    break;
                case 'options': {
                    const reload = frame.options.enableScripts !== event.options.enableScripts || frame.options.enableForms !== event.options.enableForms;
                    frame.options = event.options;
                    if (reload && frame.version > 0) {
                        load(frame);
                    }
                    break;
                }
                case 'post':
                    if (frame.loaded) {
                        frame.iframe.contentWindow?.postMessage(event.message, webviewOrigin(frame.id));
                    } else {
                        frame.queue.push(event.message);
                    }
                    break;
                case 'title':
                    frame.title = event.title;
                    frame.iframe.title = event.title;
                    frame.context?.setTitle(event.title);
                    break;
                case 'reveal':
                    if (frame.context) {
                        deps.openCustom({ id: `webview:${frame.id}`, title: frame.title, create: () => ({ element: el('div') }) }, { preview: false, preserveFocus: event.preserveFocus, beside: false });
                    }
                    break;
                case 'dispose':
                    remove(frame);
                    frame.context?.close();
                    break;
                default:
                    break;
            }
        },
        setViewSlot(viewId, slot) {
            if (slot) {
                viewSlots.set(viewId, slot);
            } else {
                viewSlots.delete(viewId);
            }
            const id = viewFrames.get(viewId);
            const frame = id ? frames.get(id) : undefined;
            if (frame) {
                frame.slot = slot;
                if (!slot) {
                    frame.wrapper.hidden = true;
                }
                setVisible(frame, slot !== null, false);
                schedule();
                return;
            }
            if (slot && !resolving.has(viewId)) {
                resolving.add(viewId);
                deps.send({ kind: 'resolveView', viewId })
                    .then((answer) => {
                        if (answer === null) {
                            slot.replaceChildren(el('p', { className: 'muted ext-view-message', text: 'No extension provides this view.' }));
                        }
                    })
                    .catch((error: unknown) => deps.onError(`The view ${viewId} could not be shown: ${String(error)}`))
                    .finally(() => resolving.delete(viewId));
            }
        },
        reset() {
            for (const frame of [...frames.values()]) {
                remove(frame);
                frame.context?.close();
            }
        },
    };
}
