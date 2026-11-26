import type { AnalysisKind, SceneShareState, SceneShareStatus } from '../shared/api.ts';

/**
 * Pure state of the scene's header (#155): what ran, where it is served, and
 * whether it is shared through a Cloudflare tunnel. Kept free of the DOM so it
 * is unit-tested; `scenePanel.ts` draws it.
 */

const KIND_LABELS: Readonly<Record<AnalysisKind, string>> = {
    'xr-deep': 'XR · deep',
};

export function analysisKindLabel(kind: AnalysisKind): string {
    return KIND_LABELS[kind];
}

/**
 * An address as the header shows it: the origin when the path is just `/`
 * (`http://127.0.0.1:3000`), the whole URL otherwise. Anything that does not
 * parse is shown as given.
 */
export function displayAddress(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.pathname === '/' && parsed.search === '' && parsed.hash === '' ? parsed.origin : parsed.href;
    } catch {
        return url;
    }
}

export interface ShareView {
    readonly status: SceneShareStatus;
    readonly publicUrl?: string | undefined;
    readonly error?: string | undefined;
    /** A request of this window is running: the buttons wait for it. */
    readonly busy: boolean;
}

export type ShareAction =
    /** A scene opened, with the state the main process reported. */
    | { readonly type: 'reset'; readonly share: SceneShareState }
    /** The person clicked Share. */
    | { readonly type: 'share' }
    /** The person clicked Stop sharing. */
    | { readonly type: 'stop' }
    /** The main process reported a state (an event, or the answer to a request). */
    | { readonly type: 'update'; readonly share: SceneShareState }
    /** A request was rejected. */
    | { readonly type: 'failed'; readonly message: string };

export const INITIAL_SHARE_VIEW: ShareView = { status: 'stopped', busy: false };

export function reduceShare(view: ShareView, action: ShareAction): ShareView {
    switch (action.type) {
        case 'reset':
        case 'update':
            return {
                status: action.share.status,
                publicUrl: action.share.status === 'shared' ? action.share.publicUrl : undefined,
                error: action.share.status === 'error' ? action.share.error : undefined,
                busy: action.share.status === 'starting',
            };
        case 'share':
            return view.busy ? view : { status: 'starting', busy: true };
        case 'stop':
            return view.busy ? view : { ...view, busy: true };
        case 'failed':
            return { status: 'error', error: action.message, busy: false };
    }
}

/** What the header's sharing controls show for a state. */
export interface ShareControls {
    readonly shareVisible: boolean;
    readonly shareLabel: string;
    readonly shareDisabled: boolean;
    readonly stopVisible: boolean;
    readonly stopDisabled: boolean;
    /** The public address row, while shared. */
    readonly publicUrl: string | null;
    readonly error: string | null;
}

export function shareControls(view: ShareView): ShareControls {
    const shared = view.status === 'shared' && typeof view.publicUrl === 'string';
    return {
        shareVisible: !shared,
        shareLabel: view.status === 'starting' ? 'Starting tunnel…' : 'Share through Cloudflare',
        shareDisabled: view.busy || view.status === 'starting',
        stopVisible: shared,
        stopDisabled: view.busy,
        publicUrl: shared ? view.publicUrl ?? null : null,
        error: view.status === 'error' ? view.error ?? 'The remote connection failed.' : null,
    };
}

/** Turns a rejected IPC call into a message: Electron prefixes the main process's error. */
export function ipcErrorMessage(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

/** #203: the header's file count, `1 file`, `870 files`; empty while unknown. */
export function analysedFilesLabel(count: number | undefined): string {
    if (count === undefined || !Number.isFinite(count) || count < 0) {
        return '';
    }
    return `${Math.round(count).toLocaleString('en')} ${count === 1 ? 'file' : 'files'}`;
}
