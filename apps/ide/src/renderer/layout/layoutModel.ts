/**
 * The workbench layout (#169) as data: sizes, what is shown, the limits each
 * area keeps, and the saved form. Pure, unit-tested in Node; the DOM side is
 * layout.ts.
 */

export const LAYOUT_STORAGE_KEY = 'codexr.layout';
const LAYOUT_VERSION = 1;

/** Fixed sizes of the workbench chrome, in CSS pixels (styles.css agrees). */
export const ACTIVITY_BAR_WIDTH = 48;
export const STATUS_BAR_HEIGHT = 24;

export const LIMITS = {
    sideBarMin: 170,
    /** Share of the window the side bar may take at most. */
    sideBarMaxRatio: 0.5,
    panelMin: 120,
    /** Share of the window the panel may take at most (when not maximised). */
    panelMaxRatio: 0.8,
    sceneMin: 320,
    /** The editor column never gets narrower than this because of a sash. */
    editorMin: 240,
    /** The editor row keeps this much above the panel. */
    editorMinHeight: 80,
} as const;

export const DEFAULT_SIDE_BAR_WIDTH = 260;
export const DEFAULT_PANEL_HEIGHT = 260;
/** With no saved width, the scene takes this share of the window (as before #169). */
export const DEFAULT_SCENE_RATIO = 0.45;

/** What is saved and restored on start. */
export interface SavedLayout {
    readonly sideBarWidth: number;
    readonly sideBarVisible: boolean;
    readonly panelHeight: number;
    /** Null until the scene sash is dragged: the scene then follows DEFAULT_SCENE_RATIO. */
    readonly sceneWidth: number | null;
}

export const DEFAULT_LAYOUT: SavedLayout = {
    sideBarWidth: DEFAULT_SIDE_BAR_WIDTH,
    sideBarVisible: true,
    panelHeight: DEFAULT_PANEL_HEIGHT,
    sceneWidth: null,
};

export interface Viewport {
    readonly width: number;
    readonly height: number;
}

const clamp = (value: number, min: number, max: number): number => Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

/** The side bar's width in this window. */
export function clampSideBar(width: number, viewport: Viewport): number {
    return clamp(width, LIMITS.sideBarMin, viewport.width * LIMITS.sideBarMaxRatio);
}

/** The panel's height in this window: it leaves room for the editor row and the status bar. */
export function clampPanel(height: number, viewport: Viewport): number {
    const max = Math.min(viewport.height * LIMITS.panelMaxRatio, viewport.height - STATUS_BAR_HEIGHT - LIMITS.editorMinHeight);
    return clamp(height, LIMITS.panelMin, max);
}

/** The scene column's width in this window: it leaves the editor column its minimum. */
export function clampScene(width: number | null, viewport: Viewport, sideBarShown: number): number {
    const wanted = width ?? viewport.width * DEFAULT_SCENE_RATIO;
    return clamp(wanted, LIMITS.sceneMin, viewport.width - ACTIVITY_BAR_WIDTH - sideBarShown - LIMITS.editorMin);
}

const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100_000;

/** Reads a saved layout; anything missing, damaged or from another version falls back to the default. */
export function parseLayout(text: string | null): SavedLayout {
    if (!text) {
        return DEFAULT_LAYOUT;
    }
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return DEFAULT_LAYOUT;
    }
    if (typeof data !== 'object' || data === null || (data as { version?: unknown }).version !== LAYOUT_VERSION) {
        return DEFAULT_LAYOUT;
    }
    const raw = data as Record<string, unknown>;
    return {
        sideBarWidth: isSize(raw['sideBarWidth']) ? Math.round(raw['sideBarWidth']) : DEFAULT_LAYOUT.sideBarWidth,
        sideBarVisible: typeof raw['sideBarVisible'] === 'boolean' ? raw['sideBarVisible'] : DEFAULT_LAYOUT.sideBarVisible,
        panelHeight: isSize(raw['panelHeight']) ? Math.round(raw['panelHeight']) : DEFAULT_LAYOUT.panelHeight,
        sceneWidth: isSize(raw['sceneWidth']) ? Math.round(raw['sceneWidth']) : null,
    };
}

export function serializeLayout(layout: SavedLayout): string {
    return JSON.stringify({ version: LAYOUT_VERSION, ...layout });
}

/** One step of a sash moved with the keyboard (arrow keys), in pixels. */
export const SASH_KEY_STEP = 16;
