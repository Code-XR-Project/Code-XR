/**
 * A small Markdown reader for chat answers (A3): the subset models actually
 * write (fenced code, headings, lists, quotes, paragraphs; inline code, bold,
 * italic, links). It produces a plain data tree; chatMarkdown.ts turns it into
 * DOM nodes with textContent only, so an answer can never inject markup.
 * Pure: no DOM, testable in Node.
 */

export type Inline =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'code'; readonly text: string }
    | { readonly kind: 'strong'; readonly children: readonly Inline[] }
    | { readonly kind: 'em'; readonly children: readonly Inline[] }
    | { readonly kind: 'link'; readonly text: string; readonly href: string };

export type Block =
    | { readonly kind: 'code'; readonly language: string; readonly text: string; readonly open: boolean }
    | { readonly kind: 'heading'; readonly level: number; readonly inline: readonly Inline[] }
    | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
    | { readonly kind: 'quote'; readonly inline: readonly Inline[] }
    | { readonly kind: 'rule' }
    | { readonly kind: 'paragraph'; readonly inline: readonly Inline[] };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** Parses a (possibly still streaming) answer; an unclosed fence is kept as an `open` code block. */
export function parseMarkdown(source: string): Block[] {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const blocks: Block[] = [];
    let paragraph: string[] = [];
    const flush = (): void => {
        if (paragraph.length > 0) {
            blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join('\n')) });
            paragraph = [];
        }
    };
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const fence = FENCE.exec(line);
        if (fence) {
            flush();
            const marker = fence[1] ?? '```';
            const body: string[] = [];
            let open = true;
            for (i += 1; i < lines.length; i += 1) {
                const inner = lines[i] ?? '';
                if (inner.trim().startsWith(marker) && inner.trim().replace(new RegExp(`^${marker[0] === '`' ? '`' : '~'}+`), '').trim() === '') {
                    open = false;
                    break;
                }
                body.push(inner);
            }
            blocks.push({ kind: 'code', language: fence[2] ?? '', text: body.join('\n'), open });
            continue;
        }
        if (!line.trim()) {
            flush();
            continue;
        }
        const heading = HEADING.exec(line);
        if (heading) {
            flush();
            blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, inline: parseInline(heading[2] ?? '') });
            continue;
        }
        if (RULE.test(line)) {
            flush();
            blocks.push({ kind: 'rule' });
            continue;
        }
        const bullet = BULLET.exec(line);
        const ordered = bullet ? null : ORDERED.exec(line);
        if (bullet || ordered) {
            flush();
            const isOrdered = ordered !== null;
            const pattern = isOrdered ? ORDERED : BULLET;
            const items: Inline[][] = [];
            for (; i < lines.length; i += 1) {
                const match = pattern.exec(lines[i] ?? '');
                if (match) {
                    items.push(parseInline(match[1] ?? ''));
                } else if ((lines[i] ?? '').match(/^\s{2,}\S/) && items.length > 0) {
                    // A continuation line of the previous item.
                    const last = items[items.length - 1] ?? [];
                    items[items.length - 1] = [...last, { kind: 'text', text: ' ' }, ...parseInline((lines[i] ?? '').trim())];
                } else {
                    break;
                }
            }
            i -= 1;
            blocks.push({ kind: 'list', ordered: isOrdered, items });
            continue;
        }
        const quote = QUOTE.exec(line);
        if (quote) {
            flush();
            const quoted: string[] = [];
            for (; i < lines.length; i += 1) {
                const match = QUOTE.exec(lines[i] ?? '');
                if (!match) {
                    break;
                }
                quoted.push(match[1] ?? '');
            }
            i -= 1;
            blocks.push({ kind: 'quote', inline: parseInline(quoted.join('\n')) });
            continue;
        }
        paragraph.push(line);
    }
    flush();
    return blocks;
}

/** Inline spans: `code`, **strong**, *em* / _em_, [text](https://…). Anything else is text. */
export function parseInline(text: string): Inline[] {
    const out: Inline[] = [];
    let buffer = '';
    const pushText = (): void => {
        if (buffer) {
            out.push({ kind: 'text', text: buffer });
            buffer = '';
        }
    };
    let i = 0;
    while (i < text.length) {
        const rest = text.slice(i);
        const code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest);
        if (code) {
            pushText();
            out.push({ kind: 'code', text: (code[2] ?? '').trim() || (code[2] ?? '') });
            i += code[0].length;
            continue;
        }
        const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
        if (strong) {
            pushText();
            out.push({ kind: 'strong', children: parseInline(strong[2] ?? '') });
            i += strong[0].length;
            continue;
        }
        const em = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?![*_\w])/.exec(rest);
        if (em && !(em[1] === '_' && /\w/.test(text[i - 1] ?? ''))) {
            pushText();
            out.push({ kind: 'em', children: parseInline(em[2] ?? '') });
            i += em[0].length;
            continue;
        }
        const link = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest);
        if (link) {
            pushText();
            out.push({ kind: 'link', text: link[1] ?? '', href: link[2] ?? '' });
            i += link[0].length;
            continue;
        }
        buffer += text[i];
        i += 1;
    }
    pushText();
    return out;
}
