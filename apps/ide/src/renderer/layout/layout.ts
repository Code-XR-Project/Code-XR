import { el } from '../dom.ts';
import {
    clampPanel, clampScene, clampSideBar, DEFAULT_LAYOUT, LAYOUT_STORAGE_KEY, LIMITS, parseLayout, SASH_KEY_STEP, serializeLayout,
    type SavedLayout, type Viewport,
} from './layoutModel.ts';

/**
 * The workbench layout (#169): sashes between the side bar and the editors,
 * the editors and the panel, the editors and the scene column; the side bar
 * shown or hidden, the panel maximised, zen mode. Sizes live in CSS custom
 * properties on the workbench (`--side-size`, `--panel-size`,
 * `--scene-size`) and the grid in styles.css reads them, so nothing else has
 * to know a size. The scene is a native view drawn over its slot: the scene
 * panel already reports the slot's bounds on every resize, so it follows the
 * sash frame by frame.
 *
 * Sizes and the side bar's visibility are saved (renderer storage, kept in
 * the IDE's user-data folder on every OS) and restored on start. The panel's
 * visibility is not: the panel holds terminals, which do not survive a
 * restart.
 */

export interface WorkbenchLayout {
    readonly sideBarVisible: boolean;
    setSideBarVisible(visible: boolean): void;
    toggleSideBar(): void;
    readonly panelMaximized: boolean;
    /** Maximises the panel over the editors, or restores it. Does nothing while the panel is hidden. */
    togglePanelMaximized(): void;
    readonly zen: boolean;
    /** Zen mode: only the editors (and an open scene) stay; the activity bar, side bar, panel and status bar hide. */
    toggleZen(): void;
    /** Back to the default sizes, side bar shown, nothing maximised. */
    reset(): void;
    /** Called after any change of size, visibility, maximised panel or zen mode. */
    onDidChange(listener: () => void): () => void;
}

export interface LayoutParts {
    readonly shell: HTMLElement;
    readonly sideBar: HTMLElement;
    readonly panel: HTMLElement;
    readonly sceneArea: HTMLElement;
}

export type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>;

type SashKind = 'side' | 'panel' | 'scene';

const SASH_LABELS: Record<SashKind, string> = {
    side: 'Resize the side bar',
    panel: 'Resize the panel',
    scene: 'Resize the scene',
};

function readStorage(storage: LayoutStorage | null): SavedLayout {
    try {
        return parseLayout(storage?.getItem(LAYOUT_STORAGE_KEY) ?? null);
    } catch {
        return DEFAULT_LAYOUT;
    }
}

export function createLayout(parts: LayoutParts, storage: LayoutStorage | null): WorkbenchLayout {
    const listeners = new Set<() => void>();
    const onChange = (): void => {
        for (const listener of listeners) {
            listener();
        }
    };
    const { shell, sideBar, panel, sceneArea } = parts;
    let saved: SavedLayout = readStorage(storage);
    let panelMaximized = false;
    let zen = false;

    const viewport = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });
    const sideShown = (): number => (saved.sideBarVisible && !zen && !sideBar.hidden && sideBar.getBoundingClientRect().width > 0
        ? clampSideBar(saved.sideBarWidth, viewport())
        : 0);

    const save = (): void => {
        try {
            storage?.setItem(LAYOUT_STORAGE_KEY, serializeLayout(saved));
        } catch {
            // Storage full or unavailable: the layout still works, it is just not remembered.
        }
    };

    const sashes = new Map<SashKind, HTMLElement>();
    for (const kind of ['side', 'panel', 'scene'] as const) {
        const sash = el('div', {
            className: `sash sash-${kind}`,
            attrs: {
                role: 'separator',
                tabindex: '0',
                'aria-label': SASH_LABELS[kind],
                'aria-orientation': kind === 'panel' ? 'horizontal' : 'vertical',
                'data-testid': `sash-${kind}`,
                title: 'Drag to resize, double-click to reset',
            },
        });
        sashes.set(kind, sash);
        shell.append(sash);
    }

    function apply(): void {
        const view = viewport();
        const side = clampSideBar(saved.sideBarWidth, view);
        const panelHeight = clampPanel(saved.panelHeight, view);
        shell.style.setProperty('--side-size', `${side}px`);
        shell.style.setProperty('--panel-size', `${panelHeight}px`);
        shell.classList.toggle('side-hidden', !saved.sideBarVisible);
        shell.classList.toggle('panel-maximized', panelMaximized);
        shell.classList.toggle('zen', zen);
        // The scene's width depends on what the side bar takes, so it is measured after.
        const scene = clampScene(saved.sceneWidth, view, sideShown());
        shell.style.setProperty('--scene-size', `${scene}px`);

        const sideSash = sashes.get('side');
        const panelSash = sashes.get('panel');
        const sceneSash = sashes.get('scene');
        if (sideSash) {
            sideSash.hidden = sideShown() === 0;
            setValue(sideSash, side, LIMITS.sideBarMin, Math.round(view.width * LIMITS.sideBarMaxRatio));
        }
        if (panelSash) {
            panelSash.hidden = panel.hidden || panelMaximized || zen;
            setValue(panelSash, panelHeight, LIMITS.panelMin, Math.round(view.height * LIMITS.panelMaxRatio));
        }
        if (sceneSash) {
            sceneSash.hidden = sceneArea.hidden;
            setValue(sceneSash, scene, LIMITS.sceneMin, Math.max(LIMITS.sceneMin, Math.round(view.width - LIMITS.editorMin)));
        }
    }

    function setValue(sash: HTMLElement, now: number, min: number, max: number): void {
        sash.setAttribute('aria-valuenow', String(now));
        sash.setAttribute('aria-valuemin', String(min));
        sash.setAttribute('aria-valuemax', String(max));
    }

    function update(change: Partial<SavedLayout>, persist = true): void {
        saved = { ...saved, ...change };
        apply();
        if (persist) {
            save();
        }
        onChange();
    }

    /** The size a sash moves, as it is on screen now. */
    function current(kind: SashKind): number {
        const view = viewport();
        switch (kind) {
            case 'side': return clampSideBar(saved.sideBarWidth, view);
            case 'panel': return clampPanel(saved.panelHeight, view);
            case 'scene': return clampScene(saved.sceneWidth, view, sideShown());
        }
    }

    function resize(kind: SashKind, size: number, persist: boolean): void {
        const view = viewport();
        switch (kind) {
            case 'side': update({ sideBarWidth: clampSideBar(size, view) }, persist); break;
            case 'panel': update({ panelHeight: clampPanel(size, view) }, persist); break;
            case 'scene': update({ sceneWidth: clampScene(size, view, sideShown()) }, persist); break;
        }
    }

    for (const [kind, sash] of sashes) {
        sash.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            try {
                sash.setPointerCapture(event.pointerId);
            } catch {
                // A synthetic pointer (tests) cannot be captured; dragging still works while over the sash.
            }
            shell.classList.add('is-resizing', kind === 'panel' ? 'is-resizing-rows' : 'is-resizing-columns');
            const start = current(kind);
            const startX = event.clientX;
            const startY = event.clientY;
            const move = (e: PointerEvent): void => {
                const size = kind === 'side' ? start + (e.clientX - startX)
                    : kind === 'scene' ? start - (e.clientX - startX)
                        : start - (e.clientY - startY);
                resize(kind, size, false);
            };
            const up = (): void => {
                sash.removeEventListener('pointermove', move);
                sash.removeEventListener('pointerup', up);
                sash.removeEventListener('pointercancel', up);
                shell.classList.remove('is-resizing', 'is-resizing-rows', 'is-resizing-columns');
                save();
            };
            sash.addEventListener('pointermove', move);
            sash.addEventListener('pointerup', up);
            sash.addEventListener('pointercancel', up);
        });
        sash.addEventListener('dblclick', () => {
            switch (kind) {
                case 'side': update({ sideBarWidth: DEFAULT_LAYOUT.sideBarWidth }); break;
                case 'panel': update({ panelHeight: DEFAULT_LAYOUT.panelHeight }); break;
                case 'scene': update({ sceneWidth: null }); break;
            }
        });
        sash.addEventListener('keydown', (event) => {
            const grow = kind === 'side' ? 'ArrowRight' : kind === 'scene' ? 'ArrowLeft' : 'ArrowUp';
            const shrink = kind === 'side' ? 'ArrowLeft' : kind === 'scene' ? 'ArrowRight' : 'ArrowDown';
            if (event.key !== grow && event.key !== shrink) {
                return;
            }
            event.preventDefault();
            resize(kind, current(kind) + (event.key === grow ? SASH_KEY_STEP : -SASH_KEY_STEP), true);
        });
    }

    // The panel (terminals) and the scene show and hide themselves; the sashes follow.
    new MutationObserver(() => {
        if (panel.hidden && panelMaximized) {
            panelMaximized = false;
        }
        apply();
        onChange();
    }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    new MutationObserver(() => apply()).observe(sceneArea, { attributes: true, attributeFilter: ['hidden'] });
    window.addEventListener('resize', () => apply());
    apply();

    return {
        get sideBarVisible() { return saved.sideBarVisible; },
        setSideBarVisible(visible: boolean): void {
            if (zen && visible) {
                zen = false;
            }
            update({ sideBarVisible: visible });
        },
        toggleSideBar(): void {
            this.setSideBarVisible(!saved.sideBarVisible || zen);
        },
        get panelMaximized() { return panelMaximized; },
        togglePanelMaximized(): void {
            if (panel.hidden) {
                return;
            }
            panelMaximized = !panelMaximized;
            apply();
            onChange();
        },
        get zen() { return zen; },
        toggleZen(): void {
            zen = !zen;
            panelMaximized = false;
            apply();
            onChange();
        },
        reset(): void {
            panelMaximized = false;
            zen = false;
            update({ ...DEFAULT_LAYOUT });
        },
        onDidChange(listener: () => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
