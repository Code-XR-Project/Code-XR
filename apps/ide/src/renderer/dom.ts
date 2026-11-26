/**
 * DOM helpers shared by the workbench views. Text only ever goes in through
 * `textContent` or attributes, never parsed as markup.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
    children: Node[] = [],
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (props.className) { node.className = props.className; }
    if (props.text !== undefined) { node.textContent = props.text; }
    for (const [key, value] of Object.entries(props.attrs ?? {})) {
        node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
}

export function icon(pathData: string, className?: string): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (className) { svg.setAttribute('class', className); }
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', pathData);
    svg.append(p);
    return svg;
}
