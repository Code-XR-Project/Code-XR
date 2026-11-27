import type { IconData } from '../../shared/extensionViewsProtocol.ts';
import { codicon } from '../codicons.ts';
import { fileIcon } from '../dom.ts';

/**
 * #261: draws an extension's icon (extensionViewsProtocol.ts `IconData`).
 * `monochrome` icons (activity bar, toolbar buttons) take the text colour,
 * as VS Code draws them: an image is used as a mask. Tree item images keep
 * their colours. Images are `data:` URLs the main process made.
 */

const darkQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function isDark(): boolean {
    const extensionTheme = document.documentElement.dataset['extensionThemeKind'];
    if (extensionTheme === 'light' || extensionTheme === 'dark') {
        return extensionTheme === 'dark';
    }
    return darkQuery?.matches ?? true;
}

export function extensionIcon(icon: IconData | null | undefined, options: { readonly monochrome?: boolean; readonly resourceName?: string; readonly expanded?: boolean } = {}): HTMLElement | null {
    if (!icon) {
        return null;
    }
    switch (icon.kind) {
        case 'codicon':
            return codicon(icon.name, { className: 'ext-icon', ...(icon.color ? { color: icon.color } : {}) });
        case 'file':
            return fileIcon(options.resourceName ?? '', 'file');
        case 'folder':
            return fileIcon(options.resourceName ?? '', 'directory', options.expanded === true);
        case 'image': {
            const url = isDark() ? icon.dark : icon.light;
            // Only the main process's data URLs are drawn: nothing here makes the page fetch.
            if (!url.startsWith('data:image/')) {
                return null;
            }
            const span = document.createElement('span');
            span.setAttribute('aria-hidden', 'true');
            if (options.monochrome) {
                span.className = 'ext-icon ext-icon-mask';
                span.style.setProperty('--ext-icon-url', `url("${url}")`);
            } else {
                span.className = 'ext-icon ext-icon-image';
                span.style.backgroundImage = `url("${url}")`;
            }
            return span;
        }
    }
}
