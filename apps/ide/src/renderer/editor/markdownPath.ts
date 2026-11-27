/** #179: which files the Markdown preview takes, by extension (kept apart from the renderer of markdownModel.ts, which loads with the editor). */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn']);

export function isMarkdownPath(path: string | null | undefined): boolean {
    const name = path?.split('/').pop() ?? '';
    const dot = name.lastIndexOf('.');
    return dot > 0 && MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
