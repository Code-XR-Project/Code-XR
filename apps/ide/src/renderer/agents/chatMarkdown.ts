import { el } from '../dom.ts';
import { parseMarkdown, type Block, type Inline } from './markdownModel.ts';

/**
 * Renders an answer's Markdown as DOM (A3). Text only ever goes in through
 * text nodes; links open nothing inside the IDE (navigation is blocked), so
 * their target is shown as a tooltip and copied on click.
 */
export function renderMarkdown(source: string, actions: { copy(text: string): void }): DocumentFragment {
    const fragment = document.createDocumentFragment();
    for (const block of parseMarkdown(source)) {
        fragment.append(renderBlock(block, actions));
    }
    return fragment;
}

function renderBlock(block: Block, actions: { copy(text: string): void }): Node {
    switch (block.kind) {
        case 'code': {
            const copy = el('button', { className: 'chat-code-action', text: 'Copy', attrs: { type: 'button', title: 'Copy code' } });
            copy.addEventListener('click', () => {
                actions.copy(block.text);
                copy.textContent = 'Copied';
                setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
            });
            return el('div', { className: 'chat-code' }, [
                el('div', { className: 'chat-code-head' }, [el('span', { className: 'chat-code-lang', text: block.language || 'text' }), copy]),
                el('pre', {}, [el('code', { text: block.text, attrs: block.language ? { 'data-lang': block.language } : {} })]),
            ]);
        }
        case 'heading':
            return el(`h${Math.min(6, block.level + 2)}` as 'h3', { className: 'chat-heading' }, renderInline(block.inline, actions));
        case 'list':
            return el(block.ordered ? 'ol' : 'ul', { className: 'chat-list' }, block.items.map((item) => el('li', {}, renderInline(item, actions))));
        case 'quote':
            return el('blockquote', { className: 'chat-quote' }, renderInline(block.inline, actions));
        case 'rule':
            return el('hr', { className: 'chat-rule' });
        case 'paragraph':
            return el('p', { className: 'chat-paragraph' }, renderInline(block.inline, actions));
    }
}

function renderInline(inline: readonly Inline[], actions: { copy(text: string): void }): Node[] {
    return inline.map((span) => {
        switch (span.kind) {
            case 'text':
                return document.createTextNode(span.text);
            case 'code':
                return el('code', { className: 'chat-inline-code', text: span.text });
            case 'strong':
                return el('strong', {}, renderInline(span.children, actions));
            case 'em':
                return el('em', {}, renderInline(span.children, actions));
            case 'link': {
                const link = el('a', { className: 'chat-link', text: span.text, attrs: { href: span.href, title: `${span.href} (click to copy)` } });
                link.addEventListener('click', (event) => {
                    event.preventDefault();
                    actions.copy(span.href);
                });
                return link;
            }
        }
    });
}
