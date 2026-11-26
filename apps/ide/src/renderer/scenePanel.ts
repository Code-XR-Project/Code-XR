import type { CodeXRApi, SceneInfo } from '../shared/api.ts';
import { el } from './dom.ts';

/**
 * The analysis scene beside the code (#16). The scene itself is drawn by the
 * main process in a separate, locked-down view laid over `slot`; this panel
 * only reserves the space, keeps the main process told where it is, and
 * offers the header (title, open state, close).
 */
export interface ScenePanel {
    show(scene: SceneInfo): void;
    close(): void;
}

export function createScenePanel(
    area: HTMLElement,
    api: CodeXRApi['analysis'],
    callbacks: { setVisible(visible: boolean): void; onError(message: string): void },
): ScenePanel {
    const title = el('span', { className: 'scene-title', attrs: { 'data-testid': 'scene-title' } });
    const close = el('button', { className: 'icon-button', text: '×', attrs: { type: 'button', title: 'Close the scene', 'aria-label': 'Close the scene' } });
    const slot = el('div', { className: 'scene-slot', attrs: { 'data-testid': 'scene-slot' } });
    area.replaceChildren(el('header', { className: 'scene-header' }, [title, close]), slot);

    let open = false;
    let frame = 0;
    const report = (): void => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            const rect = slot.getBoundingClientRect();
            const visible = open && rect.width > 0 && rect.height > 0;
            api.setSceneBounds(visible ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null)
                .catch((error: unknown) => callbacks.onError(`Could not place the scene: ${String(error)}`));
        });
    };
    new ResizeObserver(report).observe(slot);
    window.addEventListener('resize', report);

    function hide(): void {
        open = false;
        callbacks.setVisible(false);
        report();
    }
    close.addEventListener('click', () => {
        hide();
        api.closeScene().catch((error: unknown) => callbacks.onError(String(error)));
    });

    return {
        show(scene: SceneInfo): void {
            open = true;
            title.textContent = scene.title;
            title.title = scene.url;
            callbacks.setVisible(true);
            report();
        },
        close: hide,
    };
}
