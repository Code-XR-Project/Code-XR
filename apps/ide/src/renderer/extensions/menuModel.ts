import type { IconData } from '../../shared/extensionViewsProtocol.ts';
import type { ContributedCommand, ContributedMenuItem } from '../../shared/extensions.ts';
import { whenHolds, type ContextLookup } from '../../shared/whenClause.ts';

/**
 * #261: the entries of an extension menu (`contributes.menus`) that apply in
 * a context, grouped and ordered as VS Code draws them: `navigation` first
 * (the buttons of a title bar), `inline` apart (the buttons on a tree row),
 * then the other groups by name, each by `@order`. Pure: unit-tested in Node.
 */

export interface MenuAction {
    readonly command: string;
    readonly title: string;
    readonly icon: IconData | null;
    readonly enabled: boolean;
    readonly extensionId: string;
}

export interface MenuGroup {
    readonly group: string;
    readonly actions: readonly MenuAction[];
}

export function menuGroups(menu: string, items: readonly ContributedMenuItem[], commands: readonly ContributedCommand[], lookup: ContextLookup, runnable: (extensionId: string) => boolean = () => true): MenuGroup[] {
    const byId = new Map(commands.map((command) => [command.command, command]));
    const groups = new Map<string, { order: number; index: number; action: MenuAction }[]>();
    items.forEach((item, index) => {
        if (item.menu !== menu || !runnable(item.extensionId) || !whenHolds(item.when, lookup)) {
            return;
        }
        const command = byId.get(item.command);
        const title = command ? (command.category && menu === 'commandPalette' ? `${command.category}: ${command.title}` : command.title) : item.command;
        const action: MenuAction = {
            command: item.command,
            title,
            icon: command?.icon ?? null,
            enabled: whenHolds(command?.enablement ?? null, lookup),
            extensionId: item.extensionId,
        };
        const list = groups.get(item.group) ?? [];
        list.push({ order: item.order, index, action });
        groups.set(item.group, list);
    });
    const rank = (group: string): string => (group === 'navigation' ? '0' : group === 'inline' ? '1' : group === '' ? '3' : `2${group}`);
    return [...groups.entries()]
        .sort(([a], [b]) => rank(a).localeCompare(rank(b)))
        .map(([group, list]) => ({ group, actions: list.sort((a, b) => a.order - b.order || a.index - b.index).map((entry) => entry.action) }));
}

/** The buttons of a title bar (`navigation`) or of a row (`inline`), and the rest for its `...` menu. */
export function splitActions(groups: readonly MenuGroup[], primary: 'navigation' | 'inline'): { primary: MenuAction[]; secondary: MenuGroup[] } {
    return {
        primary: groups.filter((group) => group.group === primary).flatMap((group) => group.actions),
        secondary: groups.filter((group) => group.group !== primary && group.group !== (primary === 'navigation' ? 'inline' : 'navigation')),
    };
}

/** The context keys of a workspace file, as VS Code sets them for `explorer/context` and `editor/*` menus. */
export function resourceContext(path: string | null, languageId: string | null, isFolder = false): Record<string, unknown> {
    if (path === null) {
        return {};
    }
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return {
        resource: path,
        resourcePath: path,
        resourceScheme: 'file',
        resourceFilename: name,
        resourceDirname: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
        resourceExtname: dot > 0 ? name.slice(dot) : '',
        resourceLangId: languageId ?? undefined,
        explorerResourceIsFolder: isFolder,
    };
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
    '.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript', '.cts': 'typescript', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
    '.json': 'json', '.jsonc': 'jsonc', '.md': 'markdown', '.markdown': 'markdown', '.py': 'python', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
    '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php', '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml', '.sh': 'shellscript', '.bash': 'shellscript', '.ps1': 'powershell', '.sql': 'sql', '.kt': 'kotlin', '.swift': 'swift',
    '.lua': 'lua', '.r': 'r', '.dart': 'dart', '.vue': 'vue', '.svelte': 'svelte', '.toml': 'toml', '.ini': 'ini', '.txt': 'plaintext',
};

/** A file's language id when no editor has it open (`resourceLangId` of the explorer's menu). */
export function guessLanguageId(path: string): string | null {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (name === 'dockerfile') {
        return 'dockerfile';
    }
    if (name === 'makefile') {
        return 'makefile';
    }
    const dot = name.lastIndexOf('.');
    return dot > 0 ? LANGUAGE_BY_EXTENSION[name.slice(dot)] ?? null : null;
}

/** The `file:` URI of a workspace file (`root` absolute, in the OS's spelling; `path` relative, with `/`). */
export function fileUriOf(root: string, path: string): string {
    const absolute = `${root.replace(/\\/g, '/').replace(/\/$/, '')}/${path}`;
    const withSlash = absolute.startsWith('/') ? absolute : `/${absolute}`;
    return `file://${withSlash.split('/').map((segment, index) => (index === 1 && /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment))).join('/')}`;
}
