/**
 * The agent city's ground plan: Code-XR's own boats city (the babia-boats
 * spiral, see below) of the analysed files, folders as nested elevated
 * quarters, laid out once per session on the table box so the
 * reader's mental map holds while the agent moves (the Evo-Streets lesson,
 * see docs/agent-flow/research.md §1.1). Files the session creates, or that
 * the classic analysis does not cover, go to a reserved "outside the analysis"
 * strip on the right edge instead of reshuffling the city. Pure, no imports
 * beyond the models.
 */
import { AGENT_FLOW_TABLE } from './agentFlowModels';

export interface LayoutInput {
    path: string;
    weight: number;
}

export interface LayoutRect {
    x: number;
    z: number;
    w: number;
    d: number;
    /** Elevation: a building's base, or the bottom of a district's plate (metres). */
    y?: number;
}

export interface CityLayout {
    files: Map<string, LayoutRect>;
    districts: Array<LayoutRect & { path: string; depth: number }>;
    /** The strip reserved for files outside the base layout, when any were placed. */
    extraStrip: LayoutRect | null;
}

interface DirNode {
    path: string;
    depth: number;
    weight: number;
    dirs: Map<string, DirNode>;
    files: LayoutInput[];
}

const DISTRICT_PADDING = 0.035;
const FILE_GAP = 0.012;
const EXTRA_STRIP_RATIO = 0.16;
/** The rise of each folder level's plate (babia's zone elevation), metres. */
export const PLATE_HEIGHT = 0.014;
/** How far the city may be stretched on one axis to fill the table (babia fits x and z separately). */
const MAX_STRETCH = 1.6;

function buildTree(inputs: LayoutInput[]): DirNode {
    const root: DirNode = { path: '', depth: 0, weight: 0, dirs: new Map(), files: [] };
    for (const input of inputs) {
        const parts = input.path.split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i += 1) {
            const name = parts[i];
            let child = node.dirs.get(name);
            if (!child) {
                child = { path: node.path ? `${node.path}/${name}` : name, depth: node.depth + 1, weight: 0, dirs: new Map(), files: [] };
                node.dirs.set(name, child);
            }
            node = child;
        }
        node.files.push(input);
    }
    const weigh = (node: DirNode): number => {
        node.weight = node.files.reduce((sum, file) => sum + file.weight, 0);
        for (const child of node.dirs.values()) { node.weight += weigh(child); }
        return node.weight;
    };
    weigh(root);
    // A chain of single-folder levels (src/main/java/...) adds padding and no information.
    const collapse = (node: DirNode): DirNode => {
        for (const [name, child] of node.dirs) { node.dirs.set(name, collapse(child)); }
        if (node.files.length === 0 && node.dirs.size === 1 && node.depth > 0) {
            const only = [...node.dirs.values()][0];
            return { ...only, depth: node.depth };
        }
        return node;
    };
    // Collapsing leaves gaps in the levels; the plates rise one level each, so number them again.
    const renumber = (node: DirNode, depth: number): void => {
        node.depth = depth;
        for (const child of node.dirs.values()) { renumber(child, depth + 1); }
    };
    const tree = collapse(root);
    renumber(tree, 0);
    return tree;
}

/**
 * The babia-boats spiral, ported from BabiaXR's `babia-boats` visualizer
 * (aframe-babia-components 1.3.4, components/visualizers/babia-boats.js,
 * GPL-3.0, https://github.com/babiaxr/aframe-babia-components): the first
 * element sits at the origin and every next one is placed clockwise around
 * everything placed so far (right side top to bottom, bottom side right to
 * left, left side bottom to top, top side left to right), each side pushing
 * the city's limits out for the next lap. Folders ("quarters") are laid out
 * the same way, recursively, and travel as one block with a border around it.
 * Coordinates here are babia's: x to the right, y up the plan (z = -y).
 */
interface BoatsBox {
    w: number;
    d: number;
}

interface Placed {
    x: number;
    y: number;
}

function spiral(boxes: BoatsBox[]): { placed: Placed[]; left: number; right: number; down: number; up: number } {
    let limitUp = 0; let limitDown = 0; let limitRight = 0; let limitLeft = 0;
    let maxRight = 0; let maxLeft = 0; let maxDown = 0; let maxUp = 0;
    let currentVertical = 0; let currentHorizontal = 0;
    let side: 'up' | 'right' | 'down' | 'left' = 'right';
    const placed: Placed[] = [];
    boxes.forEach((box, index) => {
        let x = 0;
        let y = 0;
        if (index === 0) {
            limitUp += box.d / 2; limitDown -= box.d / 2;
            limitRight += box.w / 2; limitLeft -= box.w / 2;
            currentHorizontal = limitUp;
        } else if (side === 'right') {
            x = limitRight + box.w / 2; y = currentHorizontal - box.d / 2;
            currentHorizontal -= box.d;
            maxRight = Math.max(maxRight, limitRight + box.w);
            if (currentHorizontal < limitDown) {
                maxDown = currentHorizontal; side = 'down';
                limitUp = Math.max(limitUp, maxUp);
                currentVertical = limitRight;
            }
        } else if (side === 'down') {
            x = currentVertical - box.w / 2; y = limitDown - box.d / 2;
            currentVertical -= box.w;
            maxDown = Math.min(maxDown, limitDown - box.d);
            if (currentVertical < limitLeft) {
                maxLeft = currentVertical; side = 'left';
                limitRight = Math.max(limitRight, maxRight);
                currentHorizontal = limitDown;
            }
        } else if (side === 'left') {
            x = limitLeft - box.w / 2; y = currentHorizontal + box.d / 2;
            currentHorizontal += box.d;
            maxLeft = Math.min(maxLeft, limitLeft - box.w);
            if (currentHorizontal > limitUp) {
                maxUp = currentHorizontal; side = 'up';
                limitDown = Math.min(limitDown, maxDown);
                currentVertical = limitLeft;
            }
        } else {
            x = currentVertical + box.w / 2; y = limitUp + box.d / 2;
            currentVertical += box.w;
            maxUp = Math.max(maxUp, limitUp + box.d);
            if (currentVertical > limitRight) {
                maxRight = currentVertical; side = 'right';
                limitLeft = Math.min(limitLeft, maxLeft);
                currentHorizontal = limitUp;
            }
        }
        placed.push({ x, y });
    });
    return {
        placed,
        left: Math.min(limitLeft, maxLeft),
        right: Math.max(limitRight, maxRight),
        down: Math.min(limitDown, maxDown),
        up: Math.max(limitUp, maxUp),
    };
}

/** A laid-out node in babia units, relative to its own centre. */
interface BoatsNode {
    w: number;
    d: number;
    /** Children centres relative to this node's centre. */
    children: Array<{ x: number; y: number; node: BoatsNode | null; file: LayoutInput | null; side: number; dir: DirNode | null }>;
}

interface BoatsUnits {
    border: number;
}

/** Largest first, so the spiral starts from the heaviest block; ties by name, so the plan is deterministic. */
function byWeight(a: { weight: number; key: string }, b: { weight: number; key: string }): number {
    return b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function layoutBoats(node: DirNode, units: BoatsUnits): BoatsNode {
    const entries: Array<{ weight: number; key: string; dir: DirNode | null; file: LayoutInput | null }> = [
        ...[...node.dirs.values()].map((dir) => ({ weight: dir.weight, key: dir.path, dir, file: null })),
        ...node.files.map((file) => ({ weight: file.weight, key: file.path, dir: null, file })),
    ].sort(byWeight);
    const laid = entries.map((entry) => {
        if (entry.dir) {
            const child = layoutBoats(entry.dir, units);
            return { entry, box: { w: child.w, d: child.d }, child, side: 0 };
        }
        const side = Math.sqrt(Math.max(1, entry.weight));
        return { entry, box: { w: side, d: side }, child: null, side };
    });
    const result = spiral(laid.map((item) => item.box));
    const border = node.depth > 0 ? units.border : 0;
    const cx = (result.left + result.right) / 2;
    const cy = (result.down + result.up) / 2;
    return {
        w: result.right - result.left + border * 2,
        d: result.up - result.down + border * 2,
        children: laid.map((item, index) => ({
            x: result.placed[index].x - cx,
            y: result.placed[index].y - cy,
            node: item.child,
            file: item.entry.file,
            side: item.side,
            dir: item.entry.dir,
        })),
    };
}

function inset(rect: LayoutRect, by: number): LayoutRect {
    const insetX = Math.min(by, rect.w / 4);
    const insetZ = Math.min(by, rect.d / 4);
    return { x: rect.x + insetX, z: rect.z + insetZ, w: rect.w - insetX * 2, d: rect.d - insetZ * 2 };
}

/** Rect corner coordinates -> centre coordinates around the table centre. */
function centred(rect: LayoutRect, box: { width: number; depth: number }): LayoutRect {
    return { x: rect.x + rect.w / 2 - box.width / 2, z: rect.z + rect.d / 2 - box.depth / 2, w: rect.w, d: rect.d };
}

/** babia's autoscale: x and z are fitted on their own, within a bounded stretch. */
function fitScale(cityRect: LayoutRect, plan: BoatsNode): { sx: number; sz: number } {
    let sx = cityRect.w / Math.max(plan.w, 1e-9);
    let sz = cityRect.d / Math.max(plan.d, 1e-9);
    if (sx > sz * MAX_STRETCH) { sx = sz * MAX_STRETCH; }
    if (sz > sx * MAX_STRETCH) { sz = sx * MAX_STRETCH; }
    return { sx, sz };
}

/** The analysed files as the boats city inside `cityRect`, written into `files` and `districts`. */
function layoutBaseCity(
    base: LayoutInput[],
    cityRect: LayoutRect,
    box: { width: number; depth: number },
    files: CityLayout['files'],
    districts: CityLayout['districts'],
): void {
    const tree = buildTree(base);
    const maxSide = Math.sqrt(Math.max(1, ...base.map((file) => file.weight)));
    const units: BoatsUnits = { border: Math.max(1.5, maxSide * 0.06) };
    const plan = layoutBoats(tree, units);
    const { sx, sz } = fitScale(cityRect, plan);
    // babia units -> table metres, centred in the city rect (corner coordinates).
    const originX = cityRect.x + cityRect.w / 2;
    const originZ = cityRect.z + cityRect.d / 2;
    const gap = units.border * 0.35;
    const place = (laid: BoatsNode, dir: DirNode, cx: number, cy: number): void => {
        if (dir.depth > 0) {
            districts.push({
                path: dir.path, depth: dir.depth,
                ...centred({ x: originX + (cx - laid.w / 2) * sx, z: originZ - (cy + laid.d / 2) * sz, w: laid.w * sx, d: laid.d * sz }, box),
                y: (dir.depth - 1) * PLATE_HEIGHT,
            });
        }
        for (const child of laid.children) {
            const x = cx + child.x;
            const y = cy + child.y;
            if (child.node && child.dir) {
                place(child.node, child.dir, x, y);
            } else if (child.file) {
                const side = Math.max(child.side - gap, child.side * 0.55);
                files.set(child.file.path, {
                    ...centred({ x: originX + (x - side / 2) * sx, z: originZ - (y + side / 2) * sz, w: side * sx, d: side * sz }, box),
                    y: dir.depth * PLATE_HEIGHT,
                });
            }
        }
    };
    place(plan, tree, 0, 0);
}

/** The city's share of the table: all of it, or what the reserved strip leaves (none when only the strip is drawn). */
function cityArea(hasExtra: boolean, hasBase: boolean, box: { width: number; depth: number }): { cityW: number; cityRect: LayoutRect } {
    const cityW = hasExtra && hasBase ? box.width * (1 - EXTRA_STRIP_RATIO) : box.width;
    return { cityW, cityRect: { x: 0, z: 0, w: hasExtra && !hasBase ? 0 : cityW, d: box.depth } };
}

/** The strip on the right of the city, or the whole table when there is no city. */
function stripArea(hasBase: boolean, cityW: number, box: { width: number; depth: number }): LayoutRect {
    return hasBase
        ? { x: cityW, z: 0, w: box.width - cityW, d: box.depth }
        : { x: 0, z: 0, w: box.width, d: box.depth };
}

/** The files outside the analysis in `stripRect`; returns the strip, centred. */
function layoutExtraStrip(
    extra: LayoutInput[],
    stripRect: LayoutRect,
    box: { width: number; depth: number },
    files: CityLayout['files'],
): LayoutRect {
    // A plain grid, in arrival order: a new file must never move an old one.
    const inner = inset(stripRect, DISTRICT_PADDING);
    const cell = Math.min(0.22, Math.sqrt((inner.w * inner.d) / Math.max(1, extra.length)) * 0.88);
    const perColumn = Math.max(1, Math.floor(inner.d / cell));
    extra.forEach((file, index) => {
        const column = Math.floor(index / perColumn);
        const row = index % perColumn;
        files.set(file.path, centred(inset({ x: inner.x + column * cell, z: inner.z + row * cell, w: cell, d: cell }, FILE_GAP * 2), box));
    });
    return centred(stripRect, box);
}

/**
 * Lays out `base` (the analysed files) in the city and `extra` (files outside
 * the analysis) in the strip on the right. Rects are returned centred on the
 * table origin, in metres.
 */
export function layoutCity(base: LayoutInput[], extra: LayoutInput[] = [], box = AGENT_FLOW_TABLE, reserveStrip = false): CityLayout {
    const files = new Map<string, LayoutRect>();
    const districts: CityLayout['districts'] = [];
    // Reserving the strip up front is what lets the first outside file arrive without moving the city.
    const hasExtra = extra.length > 0 || reserveStrip;
    const { cityW, cityRect } = cityArea(hasExtra, base.length > 0, box);

    if (base.length > 0 && cityRect.w > 0) {
        layoutBaseCity(base, cityRect, box, files, districts);
    }
    let extraStrip: LayoutRect | null = null;
    if (hasExtra && (extra.length > 0 || base.length > 0)) {
        extraStrip = layoutExtraStrip(extra, stripArea(base.length > 0, cityW, box), box, files);
    }
    return { files, districts, extraStrip };
}
