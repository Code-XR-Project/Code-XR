/** #177: what the trust view shows and offers, apart from the DOM (unit-tested in Node). */
import type { WorkspaceTrustInfo } from '../shared/api.ts';

export const RESTRICTED_SUMMARY = 'Restricted Mode keeps Git, the Python language server and tasks off, because they run what the folder defines. Reading, editing, the terminal and the Code-XR analysis work either way.';

export type TrustChoice = 'folder' | 'parent' | 'restrict';

export interface TrustPickItem {
    readonly id: TrustChoice;
    readonly label: string;
    readonly description?: string;
}

export function lastSegment(folder: string): string {
    return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}

/** The choices "Manage Workspace Trust" offers for the folder as it stands. */
export function trustChoices(info: WorkspaceTrustInfo): TrustPickItem[] {
    if (!info.folder) {
        return [];
    }
    const items: TrustPickItem[] = [];
    if (info.state !== 'trusted' || info.trustedThrough !== info.folder) {
        items.push({ id: 'folder', label: 'Trust this folder', description: info.folder });
    }
    if (info.parent && info.trustedThrough !== info.parent) {
        items.push({ id: 'parent', label: `Trust every folder in ${lastSegment(info.parent)}`, description: info.parent });
    }
    if (info.state !== 'restricted') {
        items.push({ id: 'restrict', label: 'Open this folder in Restricted Mode', description: 'Git, the Python language server and tasks stay off' });
    }
    return items;
}

export function trustTooltip(info: WorkspaceTrustInfo): string {
    if (info.state === 'trusted') {
        return info.trustedThrough && info.trustedThrough !== info.folder ? `Trusted through ${info.trustedThrough}` : 'Trusted folder';
    }
    return `${info.state === 'unknown' ? 'Not trusted yet' : 'Restricted Mode'}. ${RESTRICTED_SUMMARY} Click to manage workspace trust.`;
}
