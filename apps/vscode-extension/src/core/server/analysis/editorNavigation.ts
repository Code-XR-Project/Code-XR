import * as fs from 'fs';
import * as path from 'path';
import { getHost } from '../../host/hostRegistry';
import type { CoreContext } from '../../host/hostPaths';
import { UnifiedSessionRegistry } from '../../analysis/session/sessionRegistry';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('EDITOR_NAVIGATION');

/**
 * "Open in editor" from an analysis scene (#16), shared by every host: the
 * scene sends `open-in-editor` over the collaboration room, the server
 * resolves the path here and hands it to `CodeXRHost.openInEditor`.
 *
 * The scene is a web page served over the network, so nothing it names is
 * trusted: only a peer on this machine may ask, and only for an existing
 * file inside both the analysed folder and an open workspace folder.
 */

export interface OpenInEditorRequest {
    /** Relative to the analysed folder, or absolute (a LivePanel row carries the absolute path). */
    readonly path: string;
    /** 1-based. */
    readonly line?: number;
}

const MAX_PATH_LENGTH = 4096;

/** The request if `payload` is a well-formed one, else null. */
export function parseOpenInEditorPayload(payload: unknown): OpenInEditorRequest | null {
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }
    const { path: requested, line } = payload as { path?: unknown; line?: unknown };
    if (!isPlainPath(requested)) {
        return null;
    }
    return isLineNumber(line) ? { path: requested, line } : { path: requested };
}

function isPlainPath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH && !value.includes('\0');
}

function isLineNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 10_000_000;
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The absolute file to open, or null. `analysisRoot` is the analysed folder
 * (the file's folder for a single-file analysis); `workspaceFolders` are the
 * host's open folders. The real path is checked too, so a symlink inside the
 * folder cannot lead out of it.
 */
export function resolveEditorTarget(analysisRoot: string, workspaceFolders: readonly string[], requested: string): string | null {
    const candidate = path.isAbsolute(requested)
        ? path.resolve(requested)
        : path.resolve(analysisRoot, ...requested.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.'));
    if (!isInside(analysisRoot, candidate)) {
        return null;
    }
    let real: string;
    try {
        real = fs.realpathSync(candidate);
        if (!fs.statSync(real).isFile()) {
            return null;
        }
    } catch {
        return null;
    }
    const realRoot = (() => {
        try { return fs.realpathSync(analysisRoot); } catch { return path.resolve(analysisRoot); }
    })();
    if (!isInside(realRoot, real)) {
        return null;
    }
    const inWorkspace = workspaceFolders.some((folder) => {
        try { return isInside(fs.realpathSync(folder), real); } catch { return false; }
    });
    return inWorkspace ? candidate : null;
}

/** True for an IPv4 or IPv6 loopback socket address (`::ffff:127.0.0.1` included). */
export function isLoopbackAddress(address: string | undefined): boolean {
    if (!address) {
        return false;
    }
    const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
    return plain === '::1' || /^127(?:\.\d{1,3}){3}$/.test(plain);
}

/** The analysed folder of a session (a single file's own folder), or null. */
export function sessionAnalysisRoot(context: CoreContext | undefined, sessionId: string | undefined): string | null {
    if (!context || !sessionId) {
        return null;
    }
    const session = UnifiedSessionRegistry.getInstance(context).getSession(sessionId);
    if (!session?.targetPath) {
        return null;
    }
    return session.targetType === 'file' ? path.dirname(path.resolve(session.targetPath)) : path.resolve(session.targetPath);
}

/** What `handleOpenInEditorMessage` needs from the room message it answers. */
export interface OpenInEditorSender {
    /** The sender is on this machine (loopback, no tunnel). */
    readonly local: boolean;
    send(payload: Record<string, unknown>): void;
}

/**
 * Answers an `open-in-editor` room message: opens the file in the host's
 * editor, or replies `open-in-editor-refused`. Only a peer on this machine
 * may ask, never a guest through a tunnel or the LAN.
 */
export async function handleOpenInEditorMessage(sender: OpenInEditorSender, payload: unknown, analysisRoot: string | null): Promise<boolean> {
    const opened = sender.local && analysisRoot !== null && await openRequested(payload, analysisRoot);
    if (!opened) {
        logger.warn(`open-in-editor refused (local: ${sender.local})`);
        sender.send({ type: 'open-in-editor-refused', payload: {} });
    }
    return true;
}

async function openRequested(payload: unknown, analysisRoot: string): Promise<boolean> {
    const host = getHost();
    const request = parseOpenInEditorPayload(payload);
    if (!request || !host.openInEditor) {
        return false;
    }
    const target = resolveEditorTarget(analysisRoot, host.workspaceFolders(), request.path);
    if (!target) {
        return false;
    }
    return host.openInEditor(target, request.line).catch((error: unknown) => {
        logger.warn('open-in-editor failed:', error);
        return false;
    });
}
