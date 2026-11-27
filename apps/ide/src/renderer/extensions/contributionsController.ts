import type { ExtensionContributions, ExtensionsApi, ResolvedTheme } from '../../shared/extensions.ts';
import { workbenchVariables } from './themeModel.ts';
import type * as MonacoContributions from './monacoContributions.ts';

/**
 * Applies the declarative contributions of the enabled extensions to this
 * window (#257, #258) and follows changes: installing, enabling or removing
 * an extension, or choosing another colour theme. The workbench colours are
 * set here (CSS custom properties on the root element, no Monaco); Monaco's
 * part lives in monacoContributions.ts and is loaded only when needed.
 */

export interface ContributionsController {
    /** The contributions as last loaded. */
    current(): ExtensionContributions;
    /** Re-reads the contributions (an extension changed). */
    reload(): Promise<void>;
    /** Applies the theme the settings name (`workbench.colorThemeExtension`), '' for none. */
    setTheme(themeId: string): Promise<void>;
    /** Shows a theme without storing it (the theme picker); null goes back to the applied one. */
    previewTheme(themeId: string | null): Promise<void>;
}

const EMPTY: ExtensionContributions = { themes: [], languages: [], grammars: [], snippets: [] };

export function createContributionsController(api: ExtensionsApi, onError: (message: string) => void): ContributionsController {
    let contributions = EMPTY;
    let appliedThemeId = '';
    let shownThemeId = '';
    let setVariables: string[] = [];
    let monacoPart: Promise<typeof MonacoContributions> | null = null;
    const loadMonaco = (): Promise<typeof MonacoContributions> => (monacoPart ??= import('./monacoContributions.ts'));

    const needsMonaco = (c: ExtensionContributions): boolean => c.languages.length > 0 || c.grammars.length > 0 || c.snippets.length > 0;

    const paint = async (themeId: string): Promise<void> => {
        shownThemeId = themeId;
        let theme: ResolvedTheme | null = null;
        if (themeId !== '') {
            try {
                theme = await api.theme(themeId);
            } catch (error) {
                onError(`The theme could not be read: ${String(error)}`);
            }
            if (!theme) {
                onError(`The colour theme ${themeId} is not available (its extension was disabled or removed); following the OS.`);
            }
        }
        if (shownThemeId !== themeId) {
            return;
        }
        const root = document.documentElement;
        for (const name of setVariables) {
            root.style.removeProperty(name);
        }
        setVariables = [];
        if (theme) {
            for (const [name, value] of Object.entries(workbenchVariables(theme))) {
                root.style.setProperty(name, value);
                setVariables.push(name);
            }
        }
        root.dataset.extensionTheme = theme ? theme.id : '';
        if (theme || monacoPart) {
            (await loadMonaco()).applyEditorTheme(theme);
        }
    };

    const reload = async (): Promise<void> => {
        try {
            contributions = await api.contributions();
        } catch (error) {
            onError(`Could not read the extensions' contributions: ${String(error)}`);
            return;
        }
        if (needsMonaco(contributions) || monacoPart) {
            (await loadMonaco()).applyContributions(contributions, api, onError);
        }
        // A theme whose extension went away falls back to the OS.
        if (appliedThemeId !== '') {
            await paint(appliedThemeId);
        }
    };

    return {
        current: () => contributions,
        reload,
        async setTheme(themeId: string): Promise<void> {
            appliedThemeId = themeId;
            await paint(themeId);
        },
        async previewTheme(themeId: string | null): Promise<void> {
            await paint(themeId ?? appliedThemeId);
        },
    };
}
