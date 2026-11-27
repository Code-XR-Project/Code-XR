/**
 * #179: the pure half of the Markdown preview. Turns a document into blocks
 * of HTML that each know the source line they start on (scroll sync), and
 * classifies the links and images the rendered HTML holds. Nothing here
 * touches the DOM: sanitising happens in markdownPreview.ts, on the result.
 */
import { Lexer, Parser, type Token, type TokensList } from 'marked';

export interface MarkdownBlock {
    /** 1-based line of the source where the block starts. */
    readonly line: number;
    /** Unsanitised HTML: raw HTML in the source passes through, DOMPurify runs on it later. */
    readonly html: string;
}

/** One block per top-level token, so a block can be scrolled to by its first line. */
export function renderMarkdownBlocks(text: string): MarkdownBlock[] {
    const tokens = new Lexer({ gfm: true }).lex(text);
    const blocks: MarkdownBlock[] = [];
    let line = 1;
    for (const token of tokens) {
        const startLine = line;
        line += countNewlines(token.raw);
        if (token.type === 'space') {
            continue;
        }
        const single = Object.assign([token], { links: tokens.links }) as Token[] as TokensList;
        blocks.push({ line: startLine, html: new Parser({ gfm: true }).parse(single) });
    }
    return blocks;
}

function countNewlines(text: string): number {
    let count = 0;
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
        count += 1;
    }
    return count;
}

/** The block to show for an editor whose first visible line is `line`: the last one starting at or before it. */
export function blockIndexForLine(blocks: readonly { line: number }[], line: number): number {
    let found = 0;
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (block && block.line <= line) {
            found = index;
        } else {
            break;
        }
    }
    return found;
}

/** GitHub-style heading anchors: lower case, punctuation dropped, spaces to dashes; repeats get -1, -2... */
export function headingSlugger(): (text: string) => string {
    const seen = new Map<string, number>();
    return (text) => {
        const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        return count === 0 ? base : `${base}-${count}`;
    };
}

export type LinkTarget =
    | { readonly kind: 'anchor'; readonly id: string }
    | { readonly kind: 'file'; readonly path: string; readonly anchor: string | null }
    | { readonly kind: 'external'; readonly url: string }
    | { readonly kind: 'none' };

const EXTERNAL = /^(https?:|mailto:)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Where a link in `docPath` (a workspace-relative path) points. Files resolve
 * against the document's folder and may not leave the open folder; any other
 * scheme (javascript:, file:, data:...) is `none`.
 */
export function resolveLink(docPath: string, href: string | null | undefined): LinkTarget {
    const value = (href ?? '').trim();
    if (!value) {
        return { kind: 'none' };
    }
    if (value.startsWith('#')) {
        return { kind: 'anchor', id: safeDecode(value.slice(1)) };
    }
    if (EXTERNAL.test(value)) {
        return { kind: 'external', url: value };
    }
    if (SCHEME.test(value) || value.startsWith('//')) {
        return { kind: 'none' };
    }
    const hash = value.indexOf('#');
    const pathPart = (hash === -1 ? value : value.slice(0, hash)).split('?')[0] ?? '';
    const path = resolveRelativePath(docPath, safeDecode(pathPart));
    return path ? { kind: 'file', path, anchor: hash === -1 ? null : safeDecode(value.slice(hash + 1)) } : { kind: 'none' };
}

export type ImageSource =
    | { readonly kind: 'workspace'; readonly path: string }
    | { readonly kind: 'remote'; readonly url: string }
    | { readonly kind: 'data' }
    | { readonly kind: 'none' };

/** Where an image comes from: the open folder, the network (only after a click), inline data, or nowhere. */
export function resolveImage(docPath: string, src: string | null | undefined): ImageSource {
    const value = (src ?? '').trim();
    if (!value) {
        return { kind: 'none' };
    }
    if (/^data:image\/(png|jpeg|gif|webp|bmp);/i.test(value)) {
        return { kind: 'data' };
    }
    if (/^https?:/i.test(value)) {
        return { kind: 'remote', url: value };
    }
    if (SCHEME.test(value) || value.startsWith('//')) {
        return { kind: 'none' };
    }
    const path = resolveRelativePath(docPath, safeDecode(value.split(/[?#]/)[0] ?? ''));
    return path ? { kind: 'workspace', path } : { kind: 'none' };
}

/** `target` relative to the folder of `docPath`; a leading slash means the open folder's root. Null when it leaves it. */
export function resolveRelativePath(docPath: string, target: string): string | null {
    if (!target) {
        return null;
    }
    const parts = target.startsWith('/') ? [] : docPath.split('/').slice(0, -1);
    for (const segment of target.replace(/\\/g, '/').split('/')) {
        if (segment === '' || segment === '.') {
            continue;
        }
        if (segment === '..') {
            if (parts.length === 0) {
                return null;
            }
            parts.pop();
        } else {
            parts.push(segment);
        }
    }
    return parts.length > 0 ? parts.join('/') : null;
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
