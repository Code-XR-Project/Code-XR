import 'monaco-editor/base/common/codicons.js';
import { getCodiconFontCharacters } from 'monaco-editor/base/common/codiconsUtil.js';
// The codicon font Monaco ships, bundled by Vite and served from the app (CSP `font-src 'self'`).
import codiconFontUrl from '../../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf?url';

/**
 * #261: VS Code's product icons (`$(refresh)`, `new ThemeIcon('gear')`), for
 * what extensions draw in the workbench: their view containers, tree items
 * and menu buttons. The font is Monaco's own and is loaded once, on the first
 * icon; an unknown name draws as the `blank` icon rather than as a letter.
 */

let fontLoaded = false;

function loadFont(): void {
    if (fontLoaded) {
        return;
    }
    fontLoaded = true;
    try {
        const face = new FontFace('codicon', `url("${codiconFontUrl}") format("truetype")`, { display: 'block' });
        document.fonts.add(face);
        void face.load().catch(() => undefined);
    } catch {
        // No FontFace (tests): the icons stay blank.
    }
}

/** Whether `name` is a codicon this IDE has. */
export function hasCodicon(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(getCodiconFontCharacters(), name);
}

/** The colours of `ThemeColor` ids extensions use on icons, in the workbench's palette. */
const THEME_COLORS: Readonly<Record<string, string>> = {
    'charts.red': 'var(--crit)', 'charts.orange': 'var(--warn)', 'charts.yellow': 'var(--warn)', 'charts.green': 'var(--ok, #3fb950)',
    'charts.blue': 'var(--accent)', 'charts.purple': 'var(--symbol)', 'charts.foreground': 'var(--fg)',
    errorForeground: 'var(--crit)', 'list.errorForeground': 'var(--crit)', 'list.warningForeground': 'var(--warn)',
    'problemsErrorIcon.foreground': 'var(--crit)', 'problemsWarningIcon.foreground': 'var(--warn)', 'problemsInfoIcon.foreground': 'var(--accent)',
    'testing.iconPassed': 'var(--ok, #3fb950)', 'testing.iconFailed': 'var(--crit)', 'testing.iconQueued': 'var(--warn)',
    'gitDecoration.addedResourceForeground': 'var(--ok, #3fb950)', 'gitDecoration.modifiedResourceForeground': 'var(--warn)', 'gitDecoration.deletedResourceForeground': 'var(--crit)',
    'gitDecoration.untrackedResourceForeground': 'var(--ok, #3fb950)', 'gitDecoration.ignoredResourceForeground': 'var(--muted)',
    'icon.foreground': 'var(--fg)', 'descriptionForeground': 'var(--muted)', 'disabledForeground': 'var(--muted)',
};

/** A codicon as an element: one character of the codicon font, hidden from screen readers. */
export function codicon(name: string, options: { readonly className?: string; readonly color?: string } = {}): HTMLElement {
    loadFont();
    const characters = getCodiconFontCharacters();
    const code = characters[name] ?? characters['blank'];
    const span = document.createElement('span');
    span.className = ['codicon-glyph', options.className].filter(Boolean).join(' ');
    span.setAttribute('aria-hidden', 'true');
    span.dataset['codicon'] = name;
    span.textContent = code === undefined ? '' : String.fromCodePoint(code);
    const color = options.color ? THEME_COLORS[options.color] : undefined;
    if (color) {
        span.style.color = color;
    }
    return span;
}
