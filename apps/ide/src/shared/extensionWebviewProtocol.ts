/**
 * #261: extensions' webviews (`window.createWebviewPanel`,
 * `registerWebviewViewProvider`): the messages between the extension host,
 * the main process and the renderer, and the URLs a webview is served from.
 *
 * A webview's HTML runs in a sandboxed `<iframe>` served from
 * `codexr-webview://<id>/`, an origin of its own per webview, never the
 * workbench's: it cannot reach `window.codexr`, the workbench's DOM or any
 * other webview. The main process serves its HTML (with the small script
 * that defines `acquireVsCodeApi`) and, under `/file/`, the files of its
 * `localResourceRoots` only. Messages go through `postMessage` between the
 * frame and the workbench, then over IPC to the host.
 *
 * Shared by main, the host and the renderer: no Node, Electron or DOM import.
 */

import type { ExtensionId } from './extensions.ts';

export const WEBVIEW_SCHEME = 'codexr-webview';

/** A webview's id: 32 lower-case hex characters, random, so one webview cannot guess another's origin. */
export function isWebviewId(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

export function webviewOrigin(id: string): string {
    return `${WEBVIEW_SCHEME}://${id}`;
}

/** `Webview.asWebviewUri`: the URL a webview loads a local file from (its URI path, as `vscode.Uri.path` spells it). */
export function webviewResourceUrl(id: string, uriPath: string): string {
    const encoded = uriPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return `${webviewOrigin(id)}/file${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

/**
 * The absolute file a resource URL names (`/file/home/me/a.js` -> `/home/me/a.js`,
 * `/file/c:/w/a.js` -> `c:/w/a.js`); null for anything else.
 */
export function webviewResourcePath(pathname: string, windows: boolean): string | null {
    if (!pathname.startsWith('/file/')) {
        return null;
    }
    let decoded: string;
    try {
        decoded = pathname.slice('/file'.length).split('/').map((segment) => decodeURIComponent(segment)).join('/');
    } catch {
        return null;
    }
    if (decoded.includes('\0')) {
        return null;
    }
    if (windows) {
        // `/c:/Users/me` -> `c:/Users/me`; a UNC or drive-less path is refused.
        return /^\/[a-zA-Z]:\//.test(decoded) ? decoded.slice(1) : null;
    }
    return decoded;
}

export interface WebviewOptionsData {
    readonly enableScripts: boolean;
    readonly enableForms: boolean;
    readonly enableCommandUris: boolean | readonly string[];
    /** Absolute folders whose files the webview may load (`localResourceRoots`). */
    readonly localResourceRoots: readonly string[];
}

/** Host -> main -> renderer. The HTML itself stays in the main process, which serves it. */
export type WebviewHostEvent =
    /** A panel (an editor tab) or the webview of a view (`viewId`). */
    | { readonly kind: 'create'; readonly id: string; readonly extensionId: ExtensionId; readonly viewType: string; readonly title: string; readonly options: WebviewOptionsData; readonly panel: { readonly preserveFocus: boolean; readonly beside: boolean } | null; readonly viewId?: string }
    /** The HTML changed (`html` goes to the main process only; the renderer reloads the frame). */
    | { readonly kind: 'html'; readonly id: string; readonly html: string }
    | { readonly kind: 'options'; readonly id: string; readonly options: WebviewOptionsData }
    | { readonly kind: 'post'; readonly id: string; readonly message: unknown }
    | { readonly kind: 'title'; readonly id: string; readonly title: string }
    | { readonly kind: 'reveal'; readonly id: string; readonly preserveFocus: boolean }
    | { readonly kind: 'dispose'; readonly id: string };

/** What the renderer gets: the HTML is replaced by its version number. */
export type WebviewUiEvent = Exclude<WebviewHostEvent, { kind: 'html' }> | { readonly kind: 'html'; readonly id: string; readonly version: number };

/** Renderer -> main -> host. */
export type WebviewWorkbenchEvent =
    | { readonly kind: 'message'; readonly id: string; readonly message: unknown }
    /** The person closed the panel's tab. */
    | { readonly kind: 'closed'; readonly id: string }
    | { readonly kind: 'viewState'; readonly id: string; readonly visible: boolean; readonly active: boolean }
    /** A webview view became visible for the first time: the host asks its provider to fill it. Answers its id or null. */
    | { readonly kind: 'resolveView'; readonly viewId: string }
    /** A `command:` link in a webview whose options allow it. */
    | { readonly kind: 'command'; readonly id: string; readonly command: string; readonly args: readonly unknown[] };

/** Checks a renderer event field by field; null when anything is off. */
export function parseWebviewWorkbenchEvent(raw: unknown): WebviewWorkbenchEvent | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const r = raw as Record<string, unknown>;
    switch (r['kind']) {
        case 'message':
            return isWebviewId(r['id']) ? { kind: 'message', id: r['id'], message: r['message'] } : null;
        case 'closed':
            return isWebviewId(r['id']) ? { kind: 'closed', id: r['id'] } : null;
        case 'viewState':
            return isWebviewId(r['id']) && typeof r['visible'] === 'boolean' && typeof r['active'] === 'boolean' ? { kind: 'viewState', id: r['id'], visible: r['visible'], active: r['active'] } : null;
        case 'resolveView':
            return typeof r['viewId'] === 'string' && r['viewId'] !== '' && r['viewId'].length <= 256 ? { kind: 'resolveView', viewId: r['viewId'] } : null;
        case 'command':
            return isWebviewId(r['id']) && typeof r['command'] === 'string' && r['command'] !== '' && r['command'].length <= 300 && Array.isArray(r['args'])
                ? { kind: 'command', id: r['id'], command: r['command'], args: r['args'] }
                : null;
        default:
            return null;
    }
}

const MAX_HTML = 32 * 1024 * 1024;

function parseOptions(raw: unknown): WebviewOptionsData | null {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const r = raw as Record<string, unknown>;
    const commandUris = r['enableCommandUris'];
    const roots = r['localResourceRoots'];
    if (typeof r['enableScripts'] !== 'boolean' || typeof r['enableForms'] !== 'boolean' || !Array.isArray(roots) || roots.length > 100 || !roots.every((root) => typeof root === 'string' && root.length <= 4096)) {
        return null;
    }
    if (!(typeof commandUris === 'boolean' || (Array.isArray(commandUris) && commandUris.length <= 1000 && commandUris.every((command) => typeof command === 'string')))) {
        return null;
    }
    return { enableScripts: r['enableScripts'], enableForms: r['enableForms'], enableCommandUris: commandUris as boolean | string[], localResourceRoots: roots as string[] };
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

/** Checks an event of the extension host (the main process forwards only what passes). */
export function parseWebviewHostEvent(raw: unknown): WebviewHostEvent | null {
    if (typeof raw !== 'object' || raw === null || !isWebviewId((raw as { id?: unknown }).id)) {
        return null;
    }
    const r = raw as Record<string, unknown>;
    const id = r['id'] as string;
    switch (r['kind']) {
        case 'create': {
            const options = parseOptions(r['options']);
            const panel = r['panel'];
            const panelOk = panel === null || (typeof panel === 'object' && typeof (panel as Record<string, unknown>)['preserveFocus'] === 'boolean' && typeof (panel as Record<string, unknown>)['beside'] === 'boolean');
            if (!options || !panelOk || !text(r['extensionId'], 300) || !text(r['viewType'], 300) || !text(r['title'], 1000) || (r['viewId'] !== undefined && !text(r['viewId'], 256))) {
                return null;
            }
            const base = {
                kind: 'create' as const, id, extensionId: r['extensionId'] as ExtensionId, viewType: r['viewType'] as string, title: r['title'] as string, options,
                panel: panel === null ? null : { preserveFocus: (panel as { preserveFocus: boolean }).preserveFocus, beside: (panel as { beside: boolean }).beside },
            };
            return typeof r['viewId'] === 'string' ? { ...base, viewId: r['viewId'] } : base;
        }
        case 'html':
            return text(r['html'], MAX_HTML) ? { kind: 'html', id, html: r['html'] } : null;
        case 'options': {
            const options = parseOptions(r['options']);
            return options ? { kind: 'options', id, options } : null;
        }
        case 'post':
            return { kind: 'post', id, message: r['message'] };
        case 'title':
            return text(r['title'], 1000) ? { kind: 'title', id, title: r['title'] } : null;
        case 'reveal':
            return typeof r['preserveFocus'] === 'boolean' ? { kind: 'reveal', id, preserveFocus: r['preserveFocus'] } : null;
        case 'dispose':
            return { kind: 'dispose', id };
        default:
            return null;
    }
}

/** `command:id` or `command:id?<encoded JSON args>` of a link. */
export function parseCommandHref(href: string): { command: string; args: unknown[] } | null {
    const match = /^command:([^?#]+)(?:\?(.*))?$/.exec(href);
    if (!match?.[1]) {
        return null;
    }
    let args: unknown[] = [];
    if (match[2]) {
        try {
            const parsed: unknown = JSON.parse(decodeURIComponent(match[2]));
            args = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
            return null;
        }
    }
    return { command: decodeURIComponent(match[1]), args };
}

/** Whether a webview's options let it run `command` from a `command:` link. */
export function commandUriAllowed(options: Pick<WebviewOptionsData, 'enableCommandUris'>, command: string): boolean {
    return options.enableCommandUris === true || (Array.isArray(options.enableCommandUris) && options.enableCommandUris.includes(command));
}

/**
 * The script every webview page starts with, before any of the extension's
 * own markup (so before its `<meta>` CSP, which applies only to what follows
 * it): `acquireVsCodeApi()` (once), the theme's `--vscode-*` variables and
 * body classes, and links: `http(s)`/`mailto` open outside, `command:` ask the
 * workbench, anything else that would navigate the frame is stopped.
 */
export const WEBVIEW_BOOTSTRAP = `(() => {
  const host = window.parent;
  let state;
  try { state = window.name ? JSON.parse(window.name) : undefined; } catch { state = undefined; }
  const send = (kind, payload) => host.postMessage({ __codexrWebview: kind, payload }, '*');
  let acquired = false;
  const api = Object.freeze({
    postMessage: (message) => { send('post', message); return true; },
    getState: () => state,
    setState: (value) => { state = value; send('state', value); return value; },
  });
  Object.defineProperty(window, 'acquireVsCodeApi', {
    value: () => {
      if (acquired) { throw new Error('An instance of the VS Code API has already been acquired'); }
      acquired = true;
      return api;
    },
  });
  let theme = null;
  const applyTheme = () => {
    if (!theme) { return; }
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.vars || {})) { root.style.setProperty(name, value); }
    if (document.body) {
      document.body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast');
      document.body.classList.add(theme.kind);
      document.body.dataset.vscodeThemeKind = theme.kind;
    }
  };
  try { theme = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch { theme = null; }
  applyTheme();
  // The body's classes before the page's own scripts run: as soon as the parser creates it.
  if (!document.body) {
    const waitBody = new MutationObserver(() => { if (document.body) { waitBody.disconnect(); applyTheme(); } });
    waitBody.observe(document.documentElement, { childList: true });
  }
  document.addEventListener('DOMContentLoaded', applyTheme);
  window.addEventListener('message', (event) => {
    if (event.source === host && event.data && event.data.__codexrWebviewTheme) {
      event.stopImmediatePropagation();
      theme = event.data.__codexrWebviewTheme;
      applyTheme();
    }
  }, true);
  document.addEventListener('click', (event) => {
    const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link || event.defaultPrevented) { return; }
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) { return; }
    event.preventDefault();
    if (/^(https?|mailto):/i.test(link.href)) { send('link', link.href); }
    else if (href.startsWith('command:')) { send('command', href); }
  }, true);
  window.addEventListener('focus', () => send('focus', null));
  // The workbench's shortcuts (Ctrl/Cmd+P, F1...) keep working while the webview has the focus.
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey || /^F([1-9]|1[0-2])$/.test(event.key))) { return; }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && /^[acvxzy]$/i.test(event.key)) { return; }
    send('key', { key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey });
  });
})();`;

/**
 * VS Code's default styles of a webview page (the theme's font and colours,
 * links, code, the scrollbars), which extensions write their pages against.
 * The page's own styles come after and win.
 */
export const WEBVIEW_DEFAULT_STYLES = `html { scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }
body { padding: 0 20px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-weight: var(--vscode-font-weight); font-size: var(--vscode-font-size); margin: 0; }
img, video { max-width: 100%; max-height: 100%; }
a, a code { color: var(--vscode-textLink-foreground); }
a:hover { color: var(--vscode-textLink-activeForeground); }
a:focus, input:focus, select:focus, textarea:focus { outline: 1px solid -webkit-focus-ring-color; outline-offset: -1px; }
code { font-family: var(--vscode-editor-font-family); color: var(--vscode-textPreformat-foreground); }
blockquote { background: var(--vscode-textBlockQuote-background); border-color: var(--vscode-textBlockQuote-border, var(--vscode-widget-border)); }
kbd { font-family: var(--vscode-editor-font-family); }`;

/** The page the main process serves: the extension's HTML with the default styles and the bootstrap first in its `<head>`. */
export function webviewDocument(html: string, nonce: string): string {
    const script = `<style id="_defaultStyles">${WEBVIEW_DEFAULT_STYLES}</style><script nonce="${nonce}">${WEBVIEW_BOOTSTRAP}</script>`;
    const head = /<head(\s[^>]*)?>/i.exec(html);
    if (head) {
        const at = head.index + head[0].length;
        return html.slice(0, at) + script + html.slice(at);
    }
    const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
    if (doctype) {
        return html.slice(0, doctype[0].length) + script + html.slice(doctype[0].length);
    }
    return script + html;
}
