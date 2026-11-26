import type { CodeXRApi, SceneInfo } from '../shared/api.ts';
import { el } from './dom.ts';
import { ipcErrorMessage } from './sceneHeaderModel.ts';
import { qrDrawing } from '@codexr/core/xr/headsetQr';

/**
 * #19: the scene header's XR row. *Enter XR* starts an immersive session on
 * a headset tethered to this computer (or says why it cannot), *Open in
 * browser* hands the local address to the system browser, and *On a
 * headset* shows the address a standalone headset opens, with its QR code.
 *
 * A standalone headset needs an HTTPS address it can reach, so it goes
 * through the scene's Cloudflare share (#155): the headset joins the same
 * collaboration room as the IDE, which keeps the two in sync, and is let in
 * with the pairing code the IDE shows.
 */
export interface SceneXrControls {
    readonly row: HTMLElement;
    readonly headset: HTMLElement;
    show(scene: SceneInfo): void;
    /** The scene's sharing state changed: an open headset panel re-reads its address. */
    shareChanged(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function qrSvg(text: string): SVGSVGElement {
    const drawing = qrDrawing(text);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${drawing.size} ${drawing.size}`);
    svg.setAttribute('class', 'scene-qr');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `QR code of ${text}`);
    svg.setAttribute('data-testid', 'scene-headset-qr');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const background = document.createElementNS(SVG_NS, 'rect');
    background.setAttribute('width', String(drawing.size));
    background.setAttribute('height', String(drawing.size));
    background.setAttribute('fill', '#fff');
    const modules = document.createElementNS(SVG_NS, 'path');
    modules.setAttribute('d', drawing.path);
    modules.setAttribute('fill', '#000');
    svg.append(background, modules);
    return svg;
}

export function createSceneXrControls(api: CodeXRApi['analysis'], callbacks: { onError(message: string): void; relayout(): void }): SceneXrControls {
    const enter = el('button', { className: 'secondary-button scene-xr-button', text: 'Enter XR', attrs: { type: 'button', 'data-testid': 'scene-enter-xr', title: 'Enter the scene on a headset connected to this computer' } });
    const browser = el('button', { className: 'secondary-button scene-xr-button', text: 'Open in browser', attrs: { type: 'button', 'data-testid': 'scene-open-browser', title: 'Open the scene in your browser (its local address)' } });
    const onHeadset = el('button', { className: 'secondary-button scene-xr-button', text: 'On a headset', attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'scene-headset', 'data-testid': 'scene-on-headset' } });
    const note = el('div', { className: 'scene-xr-note', attrs: { role: 'status', 'data-testid': 'scene-xr-note' } });
    const row = el('div', { className: 'scene-header-col' }, [
        el('div', { className: 'scene-header-row' }, [el('span', { className: 'scene-address-label', text: 'XR' }), enter, browser, onHeadset]),
        note,
    ]);
    const headset = el('div', { className: 'scene-headset', attrs: { id: 'scene-headset', 'data-testid': 'scene-headset' } });

    let scene: SceneInfo | null = null;
    let headsetOpen = false;
    let generation = 0;

    function say(message: string): void {
        note.textContent = message;
        note.hidden = message === '';
        callbacks.relayout();
    }

    function drawHeadset(): void {
        headset.hidden = !headsetOpen;
        onHeadset.setAttribute('aria-expanded', String(headsetOpen));
        if (!headsetOpen) {
            headset.replaceChildren();
            callbacks.relayout();
            return;
        }
        const asked = ++generation;
        api.headsetLink().then((link) => {
            if (asked !== generation) {
                return;
            }
            headset.replaceChildren(...(link
                ? [
                    qrSvg(link),
                    el('div', { className: 'scene-headset-text' }, [
                        el('p', { text: 'On the headset, open the browser and scan this code, or type the link. Enter the pairing code this window shows, then press the scene\'s VR button.' }),
                        el('p', { className: 'scene-address', text: link, attrs: { 'data-testid': 'scene-headset-link', title: link } }),
                    ]),
                ]
                : [el('p', { className: 'scene-headset-text', text: 'A standalone headset needs an HTTPS address it can reach: press Share through Cloudflare above, and the code to scan appears here.' })]));
            callbacks.relayout();
        }, (reason: unknown) => callbacks.onError(`Could not read the headset address: ${ipcErrorMessage(reason)}`));
    }

    enter.addEventListener('click', () => {
        say('');
        enter.disabled = true;
        api.enterXr().then((result) => {
            say(result.ok ? '' : result.message);
        }, (reason: unknown) => say(ipcErrorMessage(reason))).finally(() => {
            enter.disabled = false;
        });
    });
    browser.addEventListener('click', () => {
        api.openSceneInBrowser().catch((reason: unknown) => callbacks.onError(`Could not open the browser: ${ipcErrorMessage(reason)}`));
    });
    onHeadset.addEventListener('click', () => {
        headsetOpen = !headsetOpen;
        drawHeadset();
    });

    note.hidden = true;
    headset.hidden = true;
    return {
        row,
        headset,
        show(next: SceneInfo): void {
            const sceneChanged = scene?.url !== next.url;
            scene = next;
            // A LivePanel is a 2D page: nothing to enter, but it opens in a browser or on a headset all the same.
            enter.hidden = next.kind.startsWith('livepanel');
            if (sceneChanged) {
                say('');
                drawHeadset();
            }
        },
        shareChanged(): void {
            if (headsetOpen) {
                drawHeadset();
            }
        },
    };
}
