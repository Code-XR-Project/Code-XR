import type { CodeXRApi, PythonEnvStatus } from '../shared/api.ts';
import { el } from './dom.ts';

/**
 * The Python environment section of the Analysis view (#15). It only shows
 * what the main process reports and asks it to act: checking runs Python,
 * setting up asks for consent in a native dialog first, so nothing here can
 * start a download on its own.
 */

const LABELS: Record<PythonEnvStatus['state'], string> = {
    'missing-python': 'Python not found',
    'not-installed': 'Not set up',
    installing: 'Setting up…',
    ready: 'Ready',
    broken: 'Needs repair',
};

export interface PythonView {
    show(status: PythonEnvStatus): void;
}

export function createPythonView(
    container: HTMLElement,
    api: CodeXRApi['python'],
    callbacks: { onStatus(status: PythonEnvStatus): void; onError(message: string): void },
): PythonView {
    const badge = el('span', { className: 'env-badge', attrs: { 'data-testid': 'python-state' } });
    const message = el('p', { className: 'env-message', attrs: { 'data-testid': 'python-message' } });
    const detail = el('p', { className: 'env-detail muted small' });
    const progress = el('progress', { className: 'env-progress', attrs: { max: '100', 'aria-label': 'Set-up progress' } });
    const packages = el('div', { className: 'env-packages' });
    const location = el('p', { className: 'env-location muted small' });
    const actions = el('div', { className: 'env-actions' });
    const section = el('section', { className: 'env-section', attrs: { 'aria-labelledby': 'python-env-heading', 'aria-busy': 'false' } }, [
        el('h3', { className: 'side-bar-subtitle', text: 'Python environment', attrs: { id: 'python-env-heading' } }),
        el('div', { className: 'env-body' }, [badge, message, progress, detail, packages, location, actions]),
    ]);
    container.replaceChildren(
        el('h2', { className: 'side-bar-title', text: 'Analysis' }),
        section,
        el('p', { className: 'muted small side-note', text: 'Analyses run in this environment. Running them from the IDE is the next step (#16).' }),
    );
    message.textContent = 'Checking…';
    progress.hidden = true;

    let running = false;
    const run = (action: () => Promise<PythonEnvStatus>): void => {
        if (running) {
            return;
        }
        running = true;
        for (const button of actions.querySelectorAll('button')) { button.disabled = true; }
        action().then(show, (error: unknown) => callbacks.onError(String(error))).finally(() => {
            running = false;
            for (const button of actions.querySelectorAll('button')) { button.disabled = false; }
        });
    };

    const button = (label: string, onClick: () => void, primary = false): HTMLButtonElement => {
        const node = el('button', { className: primary ? 'primary-button' : 'secondary-button', text: label, attrs: { type: 'button', 'data-action': label } });
        node.addEventListener('click', onClick);
        return node;
    };

    function show(status: PythonEnvStatus): void {
        section.dataset['state'] = status.state;
        section.setAttribute('aria-busy', String(status.state === 'installing'));
        badge.textContent = LABELS[status.state];
        badge.dataset['state'] = status.state;
        message.textContent = status.message;
        detail.textContent = status.detail ?? '';
        detail.hidden = !status.detail;
        progress.hidden = status.state !== 'installing';
        if (status.progress !== undefined) {
            progress.value = status.progress;
        } else {
            progress.removeAttribute('value'); // indeterminate
        }

        const explain = status.state === 'not-installed' || status.state === 'broken';
        packages.hidden = !explain;
        packages.replaceChildren(...(explain ? [
            el('p', { className: 'small', text: 'Setting up downloads from pypi.org, into a private environment only:' }),
            el('ul', { className: 'env-package-list' }, status.packages.map((pkg) => el('li', { className: 'small' }, [
                el('span', { className: 'env-package-name', text: `${pkg.name} ${pkg.version}` }),
                el('span', { className: 'muted', text: ` · ${pkg.purpose}` }),
            ]))),
        ] : []));
        location.textContent = status.venvPath ? `Location: ${status.venvPath}` : '';
        location.hidden = !status.venvPath || status.state === 'missing-python';

        const check = (): void => run(() => api.status());
        const setUp = (): void => run(() => api.setUp());
        const remove = (): void => run(() => api.remove());
        switch (status.state) {
            case 'missing-python': actions.replaceChildren(button('Check again', check, true)); break;
            case 'not-installed': actions.replaceChildren(button('Set up…', setUp, true), button('Check again', check)); break;
            case 'installing': actions.replaceChildren(); break;
            case 'ready': actions.replaceChildren(button('Check again', check), button('Remove…', remove)); break;
            case 'broken': actions.replaceChildren(button('Repair…', setUp, true), button('Remove…', remove)); break;
        }
        callbacks.onStatus(status);
    }

    return { show };
}

/** The short status-bar text for a state. */
export function pythonStatusText(status: PythonEnvStatus): string {
    if (status.state === 'installing') {
        return status.progress !== undefined ? `Python: setting up ${Math.round(status.progress)}%` : 'Python: setting up…';
    }
    return `Python: ${LABELS[status.state].toLowerCase()}`;
}
