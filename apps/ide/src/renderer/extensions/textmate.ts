import { INITIAL, parseRawGrammar, Registry, type IGrammar, type StateStack } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';
import type { ContributedGrammar, GrammarContent } from '../../shared/extensions.ts';
import { monaco } from '../editor/monaco.ts';

/**
 * TextMate grammars contributed by extensions (#258), tokenized with the
 * libraries VS Code itself uses: `vscode-textmate` and the Oniguruma regex
 * engine compiled to WebAssembly (`vscode-oniguruma`), bundled with the app
 * and fetched from its own origin. Compiling WebAssembly is the one thing
 * the CSP gained for this (`'wasm-unsafe-eval'`); `eval` stays blocked.
 *
 * Each token handed to Monaco carries its innermost scope
 * (`keyword.control.ts`), which Monaco's theme matches by prefix, so a
 * theme's `keyword.control` rule colours it.
 */

/** A line longer than this is not tokenized (as in VS Code), so a minified file cannot freeze the editor. */
const MAX_LINE = 20_000;
/** Milliseconds one line may take before the tokenizer gives up on it. */
const TIME_LIMIT_MS = 500;

class TextMateState implements monaco.languages.IState {
    readonly stack: StateStack;

    constructor(stack: StateStack) {
        this.stack = stack;
    }

    clone(): TextMateState {
        return new TextMateState(this.stack);
    }

    equals(other: monaco.languages.IState): boolean {
        return other instanceof TextMateState && other.stack.equals(this.stack);
    }
}

export type GrammarLoader = (ref: string) => Promise<GrammarContent | null>;

let onigLib: Promise<{ createOnigScanner(patterns: string[]): OnigScanner; createOnigString(text: string): OnigString }> | null = null;

function oniguruma(): NonNullable<typeof onigLib> {
    onigLib ??= fetch(onigWasmUrl)
        .then((response) => response.arrayBuffer())
        .then((bytes) => loadWASM(bytes))
        .then(() => ({
            createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
            createOnigString: (text: string) => new OnigString(text),
        }));
    return onigLib;
}

export class TextMateGrammars {
    private readonly byScope = new Map<string, ContributedGrammar>();
    private readonly injections = new Map<string, string[]>();
    private readonly registry: Registry;
    private readonly languageIds = new Map<string, number>();
    private readonly registered = new Set<string>();
    private readonly disposables: monaco.IDisposable[] = [];
    private readonly onError: (message: string) => void;

    constructor(grammars: readonly ContributedGrammar[], load: GrammarLoader, onError: (message: string) => void) {
        this.onError = onError;
        for (const grammar of grammars) {
            this.byScope.set(grammar.scopeName, grammar);
            for (const target of grammar.injectTo) {
                this.injections.set(target, [...(this.injections.get(target) ?? []), grammar.scopeName]);
            }
        }
        this.registry = new Registry({
            onigLib: oniguruma(),
            loadGrammar: async (scopeName) => {
                const grammar = this.byScope.get(scopeName);
                if (!grammar) {
                    return null;
                }
                const content = await load(grammar.ref);
                if (!content) {
                    return null;
                }
                return parseRawGrammar(content.content, content.format === 'json' ? 'grammar.json' : 'grammar.tmLanguage');
            },
            getInjections: (scopeName) => this.injections.get(scopeName),
        });
    }

    private languageNumber(languageId: string): number {
        let id = this.languageIds.get(languageId);
        if (id === undefined) {
            id = this.languageIds.size + 1;
            this.languageIds.set(languageId, id);
        }
        return id;
    }

    /** Puts every language that has a grammar on TextMate, loading the grammar when Monaco first needs it. */
    attach(): void {
        for (const grammar of this.byScope.values()) {
            const languageId = grammar.language;
            if (!languageId || this.registered.has(languageId)) {
                continue;
            }
            this.registered.add(languageId);
            const embedded: Record<string, number> = {};
            for (const [scope, language] of Object.entries(grammar.embeddedLanguages)) {
                embedded[scope] = this.languageNumber(language);
            }
            let started = false;
            const start = (): void => {
                if (started) {
                    return;
                }
                started = true;
                this.registry
                    .loadGrammarWithConfiguration(grammar.scopeName, this.languageNumber(languageId), { embeddedLanguages: embedded })
                    .then((loaded) => {
                        if (!loaded) {
                            throw new Error(`grammar ${grammar.scopeName} did not load`);
                        }
                        this.disposables.push(monaco.languages.setTokensProvider(languageId, tokensProvider(loaded)));
                    })
                    .catch((error: unknown) => this.onError(`${grammar.extensionId}: the ${languageId} grammar could not be loaded (${String(error)}).`));
            };
            // Loaded when Monaco first meets the language, or now if a file of it is already open.
            this.disposables.push(monaco.languages.onLanguage(languageId, start));
            if (monaco.editor.getModels().some((model) => model.getLanguageId() === languageId)) {
                start();
            }
        }
    }

    dispose(): void {
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
    }
}

function tokensProvider(grammar: IGrammar): monaco.languages.TokensProvider {
    return {
        getInitialState: () => new TextMateState(INITIAL),
        tokenize(line: string, state: monaco.languages.IState): monaco.languages.ILineTokens {
            const stack = (state as TextMateState).stack;
            if (line.length > MAX_LINE) {
                return { tokens: [{ startIndex: 0, scopes: '' }], endState: state };
            }
            const result = grammar.tokenizeLine(line, stack, TIME_LIMIT_MS);
            return {
                endState: new TextMateState(result.ruleStack),
                tokens: result.tokens.map((token) => ({ startIndex: token.startIndex, scopes: token.scopes[token.scopes.length - 1] ?? '' })),
            };
        },
    };
}
