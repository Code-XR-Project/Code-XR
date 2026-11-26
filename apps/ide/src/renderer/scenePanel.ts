import type { CodeXRApi, SceneAddress, SceneInfo } from '../shared/api.ts';
import { el, icon } from './dom.ts';
import { analysedFilesLabel, analysisKindLabel, displayAddress, INITIAL_SHARE_VIEW, ipcErrorMessage, reduceShare, shareControls, type ShareAction, type ShareView } from './sceneHeaderModel.ts';

/**
 * The analysis scene beside the code (#16). The scene itself is drawn by the
 * main process in a separate, locked-down view laid over `slot`; this panel
 * only reserves the space, keeps the main process told where it is, and
 * offers the header: what ran and on what, where it is served, and (#155)
 * sharing it through a Cloudflare tunnel.
 *
 * The header never names a server or sends an address: every request acts on
 * "this window's scene" in the main process, and copying is done there too.
 */
export interface ScenePanel {
    show(scene: SceneInfo): void;
    close(): void;
}

const COPY_ICON = 'M9 9h11v11H9z M5 15H4V4h11v1';
const COPIED_MS = 1500;

function copyButton(label: string, testId: string): HTMLButtonElement {
    return el('button', { className: 'icon-button scene-copy', attrs: { type: 'button', title: label, 'aria-label': label, 'data-testid': testId } }, [icon(COPY_ICON)]);
}

export function createScenePanel(
    area: HTMLElement,
    api: CodeXRApi['analysis'],
    callbacks: { setVisible(visible: boolean): void; onError(message: string): void },
): ScenePanel {
    const kind = el('span', { className: 'scene-kind', attrs: { 'data-testid': 'scene-kind' } });
    const title = el('span', { className: 'scene-title', attrs: { 'data-testid': 'scene-title' } });
    const files = el('span', { className: 'scene-files', attrs: { 'data-testid': 'scene-files' } });
    const close = el('button', { className: 'icon-button', text: '×', attrs: { type: 'button', title: 'Close the scene', 'aria-label': 'Close the scene' } });

    const localAddress = el('span', { className: 'scene-address', attrs: { 'data-testid': 'scene-local-address' } });
    const copyLocal = copyButton('Copy the local address', 'scene-copy-local');
    const share = el('button', { className: 'secondary-button scene-share', text: 'Share through Cloudflare', attrs: { type: 'button', 'data-testid': 'scene-share' } });
    const stop = el('button', { className: 'secondary-button scene-share', text: 'Stop sharing', attrs: { type: 'button', 'data-testid': 'scene-stop-sharing' } });

    const publicAddress = el('span', { className: 'scene-address', attrs: { 'data-testid': 'scene-public-address' } });
    const copyPublic = copyButton('Copy the invitation link (guests join through it and a pairing code)', 'scene-copy-public');
    const publicRow = el('div', { className: 'scene-header-row' }, [
        el('span', { className: 'scene-address-label', text: 'Cloudflare' }), publicAddress, copyPublic,
    ]);
    const error = el('div', { className: 'scene-share-error', attrs: { role: 'status', 'data-testid': 'scene-share-error' } });

    const header = el('header', { className: 'scene-header', attrs: { 'data-testid': 'scene-header' } }, [
        el('div', { className: 'scene-header-row' }, [kind, title, files, close]),
        el('div', { className: 'scene-header-row' }, [
            el('span', { className: 'scene-address-label', text: 'Local' }), localAddress, copyLocal, share, stop,
        ]),
        publicRow,
        error,
    ]);
    const slot = el('div', { className: 'scene-slot', attrs: { 'data-testid': 'scene-slot' } });
    area.replaceChildren(header, slot);

    let open = false;
    let current: SceneInfo | null = null;
    let shareView: ShareView = INITIAL_SHARE_VIEW;
    let frame = 0;
    const report = (): void => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            const rect = slot.getBoundingClientRect();
            const visible = open && rect.width > 0 && rect.height > 0;
            api.setSceneBounds(visible ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null)
                .catch((reason: unknown) => callbacks.onError(`Could not place the scene: ${String(reason)}`));
        });
    };
    new ResizeObserver(report).observe(slot);
    window.addEventListener('resize', report);

    function dispatch(action: ShareAction): void {
        shareView = reduceShare(shareView, action);
        const controls = shareControls(shareView);
        share.hidden = !controls.shareVisible;
        share.textContent = controls.shareLabel;
        share.disabled = controls.shareDisabled;
        share.setAttribute('aria-busy', String(shareView.status === 'starting'));
        stop.hidden = !controls.stopVisible;
        stop.disabled = controls.stopDisabled;
        publicRow.hidden = controls.publicUrl === null;
        publicAddress.textContent = controls.publicUrl ?? '';
        publicAddress.title = controls.publicUrl ?? '';
        error.hidden = controls.error === null;
        error.textContent = controls.error ?? '';
        error.title = controls.error ?? '';
    }
    dispatch({ type: 'reset', share: { status: 'stopped' } });

    function copy(button: HTMLButtonElement, which: SceneAddress): void {
        const label = button.getAttribute('aria-label') ?? '';
        api.copySceneAddress(which).then(() => {
            button.classList.add('is-copied');
            button.title = 'Copied';
            setTimeout(() => {
                button.classList.remove('is-copied');
                button.title = label;
            }, COPIED_MS);
        }, (reason: unknown) => callbacks.onError(`Could not copy: ${ipcErrorMessage(reason)}`));
    }
    copyLocal.addEventListener('click', () => copy(copyLocal, 'local'));
    copyPublic.addEventListener('click', () => copy(copyPublic, 'invitation'));

    share.addEventListener('click', () => {
        const scene = current;
        dispatch({ type: 'share' });
        api.shareScene().then(
            (state) => {
                if (scene === current) { dispatch({ type: 'update', share: state }); }
            },
            (reason: unknown) => {
                if (scene === current) { dispatch({ type: 'failed', message: ipcErrorMessage(reason) }); }
            },
        );
    });
    stop.addEventListener('click', () => {
        const scene = current;
        dispatch({ type: 'stop' });
        api.stopSharingScene().then(
            (state) => {
                if (scene === current) { dispatch({ type: 'update', share: state }); }
            },
            (reason: unknown) => {
                if (scene === current) { dispatch({ type: 'failed', message: ipcErrorMessage(reason) }); }
            },
        );
    });
    api.onDidChangeSceneShare((event) => {
        if (current && event.url === current.url) {
            dispatch({ type: 'update', share: event.share });
        }
    });

    function hide(): void {
        open = false;
        current = null;
        callbacks.setVisible(false);
        report();
    }
    close.addEventListener('click', () => {
        hide();
        api.closeScene().catch((reason: unknown) => callbacks.onError(String(reason)));
    });

    return {
        show(scene: SceneInfo): void {
            open = true;
            current = scene;
            kind.textContent = analysisKindLabel(scene.kind);
            title.textContent = scene.target;
            title.title = scene.targetPath;
            files.textContent = analysedFilesLabel(scene.files);
            files.hidden = files.textContent === '';
            const address = displayAddress(scene.url);
            localAddress.textContent = address;
            localAddress.title = address;
            dispatch({ type: 'reset', share: scene.share });
            callbacks.setVisible(true);
            report();
        },
        close: hide,
    };
}
