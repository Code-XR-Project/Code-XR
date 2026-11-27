/**
 * #177: workspace trust in the window. A folder nobody has answered for gets
 * one question, as a notification that stays until it is answered; the
 * status bar shows a shield while the folder is not trusted; "Manage
 * Workspace Trust" (palette, or a click on the shield) changes the answer.
 * The main process holds the decisions and does the gating; this only asks
 * and shows.
 */
import type { CodeXRApi, WorkspaceTrustInfo } from '../shared/api.ts';
import { lastSegment, RESTRICTED_SUMMARY, trustChoices, trustTooltip, type TrustChoice, type TrustPickItem } from './trustChoices.ts';
import { icon } from './dom.ts';
import type { NotificationCenter, NotificationHandle } from './notifications.ts';

const SHIELD = 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z';

export interface WorkspaceTrustView {
    /** The folder changed (or the window started): reads its trust and asks once if nobody answered. */
    refresh(): Promise<void>;
    manage(): void;
    current(): WorkspaceTrustInfo | null;
}

export function createWorkspaceTrustView(options: {
    readonly api: CodeXRApi['workspace'];
    readonly notifications: NotificationCenter;
    readonly statusItem: HTMLButtonElement;
    readonly pick: (label: string, items: readonly TrustPickItem[], apply: (choice: TrustChoice) => void) => void;
    readonly onError: (message: string) => void;
    /** The trust moved: Git, language servers and tasks follow it. */
    readonly onChange: (info: WorkspaceTrustInfo) => void;
}): WorkspaceTrustView {
    const { api, notifications, statusItem } = options;
    let info: WorkspaceTrustInfo | null = null;
    let question: NotificationHandle | null = null;
    let askedFor: string | null = null;

    statusItem.replaceChildren(icon(SHIELD, 'status-trust-icon'), document.createTextNode('Restricted Mode'));
    statusItem.addEventListener('click', () => manage());

    function show(next: WorkspaceTrustInfo): void {
        const changed = info?.state !== next.state || info?.folder !== next.folder;
        info = next;
        statusItem.hidden = !next.folder || next.state === 'trusted';
        statusItem.title = trustTooltip(next);
        statusItem.setAttribute('aria-label', statusItem.title);
        statusItem.dataset['state'] = next.state;
        if (next.state !== 'unknown') {
            question?.close();
            question = null;
        } else if (next.folder && askedFor !== next.folder) {
            ask(next);
        }
        if (changed) {
            options.onChange(next);
        }
    }

    function ask(target: WorkspaceTrustInfo): void {
        askedFor = target.folder;
        question?.close();
        question = notifications.notify('warning', `Do you trust the authors of the files in ${lastSegment(target.folder ?? '')}?`, {
            detail: RESTRICTED_SUMMARY,
            timeoutMs: 0,
            actions: [
                { label: 'Trust Folder', run: () => choose('folder') },
                ...(target.parent ? [{ label: `Trust All in ${lastSegment(target.parent)}`, run: () => choose('parent') }] : []),
                { label: 'Restricted Mode', run: () => choose('restrict') },
            ],
        });
    }

    function choose(choice: TrustChoice): void {
        api.setTrust(choice).then(show, (error: unknown) => options.onError(`Could not change the workspace trust: ${String(error)}`));
    }

    function manage(): void {
        if (!info?.folder) {
            options.onError('Open a folder to manage its trust.');
            return;
        }
        options.pick(`Workspace trust: ${trustTooltip(info).split('.')[0] ?? ''}`, trustChoices(info), choose);
    }

    api.onDidChangeTrust(show);

    return {
        async refresh() {
            try {
                show(await api.trust());
            } catch (error) {
                options.onError(`Could not read the workspace trust: ${String(error)}`);
            }
        },
        manage,
        current: () => info,
    };
}
