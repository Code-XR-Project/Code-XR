/**
 * DOM helpers shared by the workbench views. Text only ever goes in through
 * `textContent` or attributes, never parsed as markup.
 */
import { fileIconStyleSheet, iconClass, iconFor, type IconKind } from './fileIcons.ts';

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

let iconSheetAdopted = false;

/**
 * A file or folder icon from the bundled set (#138): an empty `<span>` whose
 * class picks the SVG from one stylesheet, built from the icon tables and
 * adopted on first use. A row costs one element and one class, with no image
 * request of its own, so a folder of thousands of entries renders as fast as
 * with one fixed icon; each SVG is fetched once, from the app.
 */
export function fileIcon(name: string, kind: IconKind, expanded = false): HTMLElement {
    if (!iconSheetAdopted) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(fileIconStyleSheet());
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        iconSheetAdopted = true;
    }
    const id = iconFor(name, kind, expanded);
    return el('span', { className: `file-icon ${iconClass(id)}`, attrs: { 'aria-hidden': 'true', 'data-icon': id } });
}

/**
 * Copies through a throwaway textarea and `execCommand('copy')`: it runs in
 * a key or click handler (a user gesture), so it needs no clipboard permission, and
 * the IDE grants none.
 */
export function copyText(text: string): void {
    const active = document.activeElement as HTMLElement | null;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    active?.focus();
}
