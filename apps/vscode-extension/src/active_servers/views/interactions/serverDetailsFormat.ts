import * as path from 'path';
import type { ActiveServer } from '../../model/activeServerModel';
import { NetworkUtils } from '../../../servers/utils/networkUtils';
import { formatDetailSections, formatDuration } from '../../../utils/detailDialog';

/*
 * The text of the server dialogs: the "Server Information" detail, the
 * remote-status lines and the dialog titles. Pure formatting over an
 * ActiveServer; ServerActionHandlers shows it.
 */

/** Friendly server name used as dialog titles. */
export function getServerLabel(server: ActiveServer): string {
    return server.customName?.trim() || `localhost:${server.port}`;
}

/**
 * Format server details for display
 */
export function formatServerDetails(server: ActiveServer): string {
    const metadata = (server.metadata || {}) as Record<string, unknown>;
    const remote = server.remoteAccess;
    const protocol = server.certMode === 'http' ? 'http' : 'https';
    const lanUrl = `${protocol}://${NetworkUtils.getLocalIPAddress()}:${server.port}`;

    return formatDetailSections([
        [
            ['Status', `${formatServerStatus(server)} · up ${formatDuration(Date.now() - server.timestamp)}`],
            ['Address', server.url],
            ['Network', lanUrl],
            ['Port', String(server.port)],
            ['Security', formatCertMode(server.certMode)],
            ['Mode', server.launchMode === 'browser' ? 'Browser' : 'Panel'],
        ],
        [
            ['Serving', server.htmlFile ? path.basename(server.htmlFile) : undefined],
            ['Folder', shortenPath(String(metadata.staticRoot || ''))],
            ['Type', metadata.serverType ? String(metadata.serverType) : undefined],
            ['Details', metadata.description ? String(metadata.description) : undefined],
        ],
        [
            ['Cross-network', remote && remote.status !== 'stopped'
                ? formatRemoteStatus(remote)
                : undefined],
            ['Invitation', remote?.invitationUrl],
        ],
    ]);
}

function formatServerStatus(server: ActiveServer): string {
    return server.status.charAt(0).toUpperCase() + server.status.slice(1);
}

function formatCertMode(certMode: ActiveServer['certMode']): string {
    switch (certMode) {
        case 'https-default':
            return 'HTTPS (self-signed)';
        case 'https-custom':
            return 'HTTPS (custom certificate)';
        default:
            return 'HTTP';
    }
}

export function formatRemoteStatus(
    state: NonNullable<ActiveServer['remoteAccess']>,
    withPending = true,
): string {
    if (state.status === 'error') {
        return `Error · ${state.error || 'tunnel failed'}`;
    }
    if (state.status === 'starting') {
        return 'Starting...';
    }
    if (state.status === 'shared') {
        return withPending && state.pendingRequests > 0
            ? `Shared · ${formatPendingRequests(state.pendingRequests)}`
            : 'Shared';
    }
    return 'Not shared';
}

export function formatPendingRequests(count: number): string {
    if (count === 0) {
        return 'None';
    }
    return count === 1 ? '1 request waiting' : `${count} requests waiting`;
}

/**
 * Keep long paths readable: leading segments collapse into an ellipsis.
 */
function shortenPath(value: string, keepSegments = 2): string | undefined {
    if (!value) {
        return undefined;
    }
    const segments = value.split(/[\\/]/).filter(Boolean);
    if (segments.length <= keepSegments) {
        return value;
    }
    return `…${path.sep}${segments.slice(-keepSegments).join(path.sep)}`;
}
