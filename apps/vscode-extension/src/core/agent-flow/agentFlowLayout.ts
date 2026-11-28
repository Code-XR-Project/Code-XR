/**
 * The agent city's ground plan: a squarified treemap of the analysed files,
 * folders as districts, laid out once per session on the table box so the
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
    return collapse(root);
}

interface Item {
    weight: number;
    place(rect: LayoutRect): void;
}

function worst(row: number[], side: number, scale: number): number {
    const total = row.reduce((a, b) => a + b, 0) * scale;
    let max = 0;
    let min = Infinity;
    for (const value of row) { max = Math.max(max, value * scale); min = Math.min(min, value * scale); }
    const side2 = side * side;
    const total2 = total * total;
    return Math.max((side2 * max) / total2, total2 / (side2 * min));
}

/** Squarified treemap (Bruls, Huizing, van Wijk 2000) of items into rect. */
function squarify(items: Item[], rect: LayoutRect): void {
    const sorted = items.filter((item) => item.weight > 0).sort((a, b) => b.weight - a.weight);
    const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
    if (sorted.length === 0 || totalWeight <= 0 || rect.w <= 0 || rect.d <= 0) {
        return;
    }
    const scale = (rect.w * rect.d) / totalWeight;
    let { x, z, w, d } = rect;
    let index = 0;
    while (index < sorted.length) {
        const side = Math.min(w, d);
        const row: Item[] = [sorted[index]];
        index += 1;
        while (index < sorted.length) {
            const current = row.map((item) => item.weight);
            const next = [...current, sorted[index].weight];
            if (worst(next, side, scale) > worst(current, side, scale)) { break; }
            row.push(sorted[index]);
            index += 1;
        }
        const rowArea = row.reduce((sum, item) => sum + item.weight, 0) * scale;
        if (w >= d) {
            // Column on the left, items stacked along depth.
            const colW = rowArea / d;
            let cz = z;
            for (const item of row) {
                const itemD = (item.weight * scale) / colW;
                item.place({ x, z: cz, w: colW, d: itemD });
                cz += itemD;
            }
            x += colW; w -= colW;
        } else {
            const rowD = rowArea / w;
            let cx = x;
            for (const item of row) {
                const itemW = (item.weight * scale) / rowD;
                item.place({ x: cx, z, w: itemW, d: rowD });
                cx += itemW;
            }
            z += rowD; d -= rowD;
        }
    }
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
    const cityW = hasExtra && base.length > 0 ? box.width * (1 - EXTRA_STRIP_RATIO) : box.width;
    const cityRect: LayoutRect = { x: 0, z: 0, w: hasExtra && base.length === 0 ? 0 : cityW, d: box.depth };

    const placeNode = (node: DirNode, rect: LayoutRect): void => {
        if (node.depth > 0) {
            districts.push({ path: node.path, depth: node.depth, ...centred(rect, box) });
        }
        const inner = node.depth > 0 ? inset(rect, DISTRICT_PADDING) : rect;
        const items: Item[] = [];
        for (const child of node.dirs.values()) {
            items.push({ weight: child.weight, place: (r) => placeNode(child, r) });
        }
        for (const file of node.files) {
            items.push({
                weight: file.weight,
                place: (r) => files.set(file.path, centred(inset(r, FILE_GAP), box)),
            });
        }
        squarify(items, inner);
    };

    if (base.length > 0 && cityRect.w > 0) {
        placeNode(buildTree(base), cityRect);
    }
    let extraStrip: LayoutRect | null = null;
    if (hasExtra && (extra.length > 0 || base.length > 0)) {
        const stripRect: LayoutRect = base.length > 0
            ? { x: cityW, z: 0, w: box.width - cityW, d: box.depth }
            : { x: 0, z: 0, w: box.width, d: box.depth };
        extraStrip = centred(stripRect, box);
        // A plain grid, in arrival order: a new file must never move an old one.
        const inner = inset(stripRect, DISTRICT_PADDING);
        const cell = Math.min(0.22, Math.sqrt((inner.w * inner.d) / Math.max(1, extra.length)) * 0.88);
        const perColumn = Math.max(1, Math.floor(inner.d / cell));
        extra.forEach((file, index) => {
            const column = Math.floor(index / perColumn);
            const row = index % perColumn;
            files.set(file.path, centred(inset({ x: inner.x + column * cell, z: inner.z + row * cell, w: cell, d: cell }, FILE_GAP * 2), box));
        });
    }
    return { files, districts, extraStrip };
}
