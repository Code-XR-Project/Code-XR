import type { ExtensionContributions, ExtensionsApi, ResolvedTheme } from '../../shared/extensions.ts';
import { monaco, setThemeOverride } from '../editor/monaco.ts';
import { detectLanguage, mergeLanguages, snippetsFor, toLanguageConfiguration, type MonacoLanguageEntry } from './languageModel.ts';
import { TextMateGrammars } from './textmate.ts';
import { toMonacoTheme } from './themeModel.ts';

/**
 * The Monaco half of the declarative contributions (#257, #258): languages,
 * language configurations, TextMate grammars, snippets and the editor side of
 * a colour theme. Loaded only when an enabled extension contributes one of
 * them, so an IDE without extensions does not load Monaco earlier than before.
 *
 * Monaco cannot unregister a language: one whose extension is removed keeps
 * its file associations until the window reloads (its grammar, configuration
 * and snippets go at once).
 */

const registeredLanguages = new Set<string>();
let disposables: monaco.IDisposable[] = [];
let grammars: TextMateGrammars | null = null;
let themeCounter = 0;

export function applyContributions(contributions: ExtensionContributions, api: Pick<ExtensionsApi, 'grammarContent'>, onError: (message: string) => void): void {
    for (const disposable of disposables) {
        disposable.dispose();
    }
    disposables = [];
    grammars?.dispose();
    grammars = null;

    const merged = mergeLanguages(contributions.languages);
    const known = new Set(monaco.languages.getLanguages().map((language) => language.id));
    for (const { entry, configuration } of merged) {
        if (!registeredLanguages.has(entry.id)) {
            // A language Monaco already knows (an extension adding `.mjs` to javascript) keeps its own entry and gains the new names.
            monaco.languages.register(entry);
            registeredLanguages.add(entry.id);
        }
        if (configuration !== null && !known.has(entry.id)) {
            try {
                disposables.push(monaco.languages.setLanguageConfiguration(entry.id, toLanguageConfiguration(configuration, monaco.languages.IndentAction) as monaco.languages.LanguageConfiguration));
            } catch (error) {
                onError(`The language configuration of ${entry.id} could not be applied: ${String(error)}`);
            }
        }
    }

    grammars = new TextMateGrammars(contributions.grammars, (ref) => api.grammarContent(ref), onError);
    grammars.attach();

    const snippetLanguages = new Set(contributions.snippets.map((snippet) => snippet.language));
    for (const language of snippetLanguages) {
        const selector = language === '*' ? '*' : language;
        disposables.push(monaco.languages.registerCompletionItemProvider(selector, {
            provideCompletionItems(model, position) {
                const word = model.getWordUntilPosition(position);
                const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
                const list = language === '*' ? contributions.snippets.filter((s) => s.language === '*') : snippetsFor(contributions.snippets, model.getLanguageId()).filter((s) => s.language !== '*');
                return {
                    suggestions: list.flatMap((snippet) => snippet.prefixes.map((prefix) => ({
                        label: { label: prefix, description: snippet.name },
                        kind: monaco.languages.CompletionItemKind.Snippet,
                        insertText: snippet.body,
                        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                        documentation: snippet.description ? `${snippet.description}\n\n${snippet.body}` : snippet.body,
                        detail: `Snippet from ${snippet.extensionId}`,
                        range,
                    }))),
                };
            },
        }));
    }

    reassignPlainTextModels(merged.map((m) => m.entry));
}

/** Files opened before their language was registered were opened as plain text: give them their language now. */
function reassignPlainTextModels(entries: readonly MonacoLanguageEntry[]): void {
    for (const model of monaco.editor.getModels()) {
        if (model.getLanguageId() !== 'plaintext') {
            continue;
        }
        const name = model.uri.path.split('/').pop() ?? '';
        const language = detectLanguage(name, entries);
        if (language) {
            monaco.editor.setModelLanguage(model, language);
        }
    }
}

/** The editor side of a colour theme; null goes back to following the OS. */
export function applyEditorTheme(theme: ResolvedTheme | null): void {
    if (!theme) {
        setThemeOverride(null);
        return;
    }
    const name = `codexr-ext-${++themeCounter}`;
    monaco.editor.defineTheme(name, toMonacoTheme(theme) as monaco.editor.IStandaloneThemeData);
    setThemeOverride(name);
}
