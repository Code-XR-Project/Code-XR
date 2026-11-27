import { el } from './dom.ts';
import { clampPercent } from './progressPercent.ts';

/**
 * VS Code-style notifications (#153): toasts stacked in the window's
 * bottom-right corner, each with a level, a message, optional actions and a
 * close button, and progress notifications whose bar and message update in
 * place until the task ends.
 *
 * Info toasts fade on their own; warnings and errors stay until dismissed.
 * A polite live region announces each new notification once, so a progress
 * bar moving does not flood a screen reader.
 */
export type NotificationSeverity = 'info' | 'warning' | 'error';

export interface NotificationAction {
    readonly label: string;
    run(): void;
}

export interface NotificationOptions {
    readonly detail?: string | undefined;
    readonly actions?: readonly NotificationAction[];
    /** Milliseconds before it closes on its own; 0 keeps it. Defaults: info 6 s, others 0. */
    readonly timeoutMs?: number;
    /** #259: it closed without an action (its X, or the timeout): an extension waiting on it gets `undefined`. */
    readonly onDismiss?: () => void;
}

export interface ProgressUpdate {
    readonly title: string;
    readonly message?: string | undefined;
    /** 0-100; absent for a task of unknown length (the bar then runs indeterminate). */
    readonly percent?: number | undefined;
    /** #284: adds a Cancel button that runs this (read when the notification first shows). */
    readonly onCancel?: (() => void) | undefined;
}

export interface NotificationHandle {
    close(): void;
}

export interface NotificationCenter {
    notify(severity: NotificationSeverity, message: string, options?: NotificationOptions): NotificationHandle;
    /** Shows or updates the progress notification `key`. */
    progress(key: string, update: ProgressUpdate): void;
    /** Ends the progress notification `key`, if any. */
    endProgress(key: string): void;
    /**
     * Keeps the stack clear of `px` pixels at the window's right edge: the
     * scene is a native view drawn over the page, so a toast under it would
     * be hidden.
     */
    setRightInset(px: number): void;
    /** How many notifications are on screen (tests, smoke). */
    readonly count: number;
}

const INFO_TIMEOUT_MS = 6000;
const MAX_VISIBLE = 5;
const SEVERITY_LABEL: Record<NotificationSeverity, string> = { info: 'Info', warning: 'Warning', error: 'Error' };

export function createNotificationCenter(host: HTMLElement): NotificationCenter {
    const stack = el('div', { className: 'notifications', attrs: { 'data-testid': 'notifications' } });
    const announcer = el('div', { className: 'sr-only', attrs: { role: 'status' } });
    host.append(stack, announcer);
    const progressToasts = new Map<string, { root: HTMLElement; title: HTMLElement; message: HTMLElement; bar: HTMLElement; track: HTMLElement }>();

    function announce(text: string): void {
        announcer.textContent = '';
        requestAnimationFrame(() => {
            announcer.textContent = text;
        });
    }

    function trim(): void {
        // The oldest plain toasts make room; progress toasts stay while their task runs.
        const plain = [...stack.children].filter((child) => !(child as HTMLElement).dataset['progress']);
        while (stack.children.length > MAX_VISIBLE && plain.length > 0) {
            plain.shift()?.remove();
        }
    }

    function shell(kind: NotificationSeverity | 'progress', body: Node[], onClose: () => void): HTMLElement {
        const close = el('button', { className: 'notification-close', text: '×', attrs: { type: 'button', title: 'Close', 'aria-label': 'Close notification' } });
        close.addEventListener('click', onClose);
        const root = el('div', { className: `notification is-${kind}`, attrs: { role: kind === 'error' ? 'alert' : 'group', 'data-testid': 'notification' } }, [
            el('span', { className: 'notification-icon', attrs: { 'aria-hidden': 'true' } }),
            el('div', { className: 'notification-body' }, body),
            close,
        ]);
        stack.append(root);
        trim();
        return root;
    }

    return {
        notify(severity, message, options = {}): NotificationHandle {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const body: Node[] = [el('p', { className: 'notification-message', text: message })];
            if (options.detail) {
                body.push(el('p', { className: 'notification-detail', text: options.detail }));
            }
            const handle: NotificationHandle = {
                close(): void {
                    clearTimeout(timer);
                    root.remove();
                },
            };
            if (options.actions && options.actions.length > 0) {
                body.push(el('div', { className: 'notification-actions' }, options.actions.map((action) => {
                    const button = el('button', { className: 'secondary-button', text: action.label, attrs: { type: 'button' } });
                    button.addEventListener('click', () => {
                        handle.close();
                        action.run();
                    });
                    return button;
                })));
            }
            const dismiss = (): void => {
                handle.close();
                options.onDismiss?.();
            };
            const root = shell(severity, body, dismiss);
            root.dataset['severity'] = severity;
            const timeout = options.timeoutMs ?? (severity === 'info' && !options.actions?.length ? INFO_TIMEOUT_MS : 0);
            if (timeout > 0) {
                timer = setTimeout(dismiss, timeout);
                // Reading a toast keeps it.
                root.addEventListener('mouseenter', () => clearTimeout(timer));
            }
            announce(`${SEVERITY_LABEL[severity]}: ${message}`);
            return handle;
        },

        progress(key, update): void {
            let toast = progressToasts.get(key);
            const percent = clampPercent(update.percent);
            if (!toast) {
                const title = el('p', { className: 'notification-message' });
                const message = el('p', { className: 'notification-detail' });
                const bar = el('div', { className: 'progress-bar' });
                const track = el('div', { className: 'progress-track', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' } }, [bar]);
                const body: Node[] = [title, message, track];
                const onCancel = update.onCancel;
                if (onCancel) {
                    const cancel = el('button', { className: 'secondary-button', text: 'Cancel', attrs: { type: 'button', 'data-testid': 'notification-cancel' } });
                    cancel.addEventListener('click', () => {
                        cancel.disabled = true;
                        onCancel();
                    });
                    body.push(el('div', { className: 'notification-actions' }, [cancel]));
                }
                const root = shell('progress', body, () => {
                    // Hiding a running task's toast does not stop the task.
                    root.remove();
                    progressToasts.delete(key);
                });
                root.dataset['progress'] = key;
                toast = { root, title, message, bar, track };
                progressToasts.set(key, toast);
                announce(update.title);
            }
            toast.title.textContent = update.title;
            toast.message.textContent = update.message ?? '';
            toast.message.hidden = !update.message;
            toast.track.setAttribute('aria-label', update.title);
            if (percent === undefined) {
                toast.track.classList.add('is-indeterminate');
                toast.track.removeAttribute('aria-valuenow');
                toast.bar.style.width = '';
            } else {
                toast.track.classList.remove('is-indeterminate');
                toast.track.setAttribute('aria-valuenow', String(Math.round(percent)));
                toast.bar.style.width = `${percent}%`;
            }
        },

        endProgress(key): void {
            progressToasts.get(key)?.root.remove();
            progressToasts.delete(key);
        },

        setRightInset(px: number): void {
            stack.style.right = `${Math.max(0, Math.round(px)) + 12}px`;
        },

        get count(): number {
            return stack.children.length;
        },
    };
}
