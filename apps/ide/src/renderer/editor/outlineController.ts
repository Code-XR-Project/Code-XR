import { outlineFromFunctions, outlineKindOfTypeScript, sortOutline, type OutlineSymbol } from '../../shared/outline.ts';
import type { CodeXRApi, DirEntry } from '../../shared/api.ts';
import type { FileFunctionMetrics, FunctionMetricsSnapshot } from '../../shared/problems.ts';
import type { OutlineState, OutlineView } from '../outline/outlineView.ts';
import { createBreadcrumbs } from './breadcrumbs.ts';
import type { EditorGroup } from './editorGroup.ts';
import { monaco } from './monaco.ts';

/**
 * #172: where the Outline view and the breadcrumbs get their symbols.
 *
 * - TypeScript and JavaScript: Monaco's own TypeScript service (its
 *   navigation tree), refreshed as the text changes.
 * - Every other language: the functions the Code-XR analysis measured,
 *   nested in the classes around them (core/metrics/functionOutline.ts,
 *   shared with the VS Code extension). The window's metrics are used when
 *   an analysis covered the file; otherwise the backend measures that file
 *   alone. Those symbols describe the file on disk, so they are read again
 *   when the tab is saved, not on every keystroke.
 *
 * A language server (#21) will take the first place once the IDE has one.
 */

export interface OutlineController {
    /** The active editor changed (or its language did). */
    activeChanged(): void;
    /** The cursor of the active file moved. */
    cursorMoved(line: number): void;
    /** A tab's text matches the disk again: its measured functions may have changed. */
    fileClean(path: string): void;
    /** The window's metrics changed (an analysis, or a save it re-measured). */
    setSnapshot(snapshot: FunctionMetricsSnapshot | null): void;
    setBreadcrumbsEnabled(enabled: boolean): void;
}

interface NavigationItem {
    readonly text: string;
    readonly kind: string;
    readonly spans: readonly { readonly start: number; readonly length: number }[];
    readonly nameSpan?: { readonly start: number; readonly length: number };
    readonly childItems?: readonly NavigationItem[];
}

const TYPESCRIPT_LANGUAGES = new Set(['typescript', 'javascript']);
/** Languages the analysis does not measure: asking the backend about them would only cost a Python run. */
const NO_ANALYSIS = new Set(['plaintext', 'json', 'jsonc', 'markdown', 'css', 'scss', 'less', 'html', 'xml', 'yaml', 'ini', 'dockerfile', 'shell', 'bat', 'powershell', 'sql', 'handlebars', 'razor']);
const TYPING_DELAY_MS = 400;
const MAX_CACHED_FILES = 100;

function fromNavigationTree(model: monaco.editor.ITextModel, items: readonly NavigationItem[]): OutlineSymbol[] {
    return items.flatMap((item): OutlineSymbol[] => {
        const span = item.spans[0];
        if (!span || item.kind === 'alias') {
            return [];
        }
        const start = model.getPositionAt(span.start).lineNumber;
        const end = model.getPositionAt(span.start + span.length).lineNumber;
        const line = item.nameSpan ? model.getPositionAt(item.nameSpan.start).lineNumber : start;
        return [{ name: item.text, kind: outlineKindOfTypeScript(item.kind), startLine: start, endLine: end, line, children: fromNavigationTree(model, item.childItems ?? []) }];
    });
}

async function typeScriptSymbols(model: monaco.editor.ITextModel): Promise<OutlineSymbol[]> {
    const getWorker = model.getLanguageId() === 'typescript' ? monaco.typescript.getTypeScriptWorker : monaco.typescript.getJavaScriptWorker;
    const client = await (await getWorker())(model.uri);
    const tree = await client.getNavigationTree(model.uri.toString()) as NavigationItem | undefined;
    // The navigation tree lists each level by name; the breadcrumbs' menus read them in file order.
    return sortOutline(fromNavigationTree(model, tree?.childItems ?? []), 'position');
}

export function createOutlineController(options: {
    readonly editors: EditorGroup;
    readonly view: OutlineView;
    readonly api: Pick<CodeXRApi, 'problems'> & { readonly workspace: { listDirectory(path: string): Promise<readonly DirEntry[]> } };
    openFile(path: string): void;
    revealFolder(path: string): void;
    rightInset(): number;
}): OutlineController {
    const { editors, view, api } = options;
    let snapshot: FunctionMetricsSnapshot | null = null;
    /** Files measured on their own (no analysis covered them), until their tab is saved again. */
    const measured = new Map<string, FileFunctionMetrics | null>();
    let generation = 0;
    let current: { path: string; model: monaco.editor.ITextModel } | null = null;
    let contentListener: monaco.IDisposable | null = null;
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    let shownSymbols: readonly OutlineSymbol[] = [];

    function reveal(symbol: OutlineSymbol, focus: boolean): void {
        editors.goToLine(symbol.line, 1, focus);
    }
    const breadcrumbs = createBreadcrumbs(editors.breadcrumbBar, {
        listFolder: (path) => api.workspace.listDirectory(path),
        openFile: options.openFile,
        revealFolder: options.revealFolder,
        reveal: (symbol) => reveal(symbol, true),
        rightInset: options.rightInset,
    });

    function publish(state: OutlineState): void {
        view.show(state);
        shownSymbols = state.kind === 'symbols' ? state.symbols : [];
        breadcrumbs.show(current?.path ?? null, shownSymbols);
    }

    function knownFunctions(path: string): FileFunctionMetrics | null | undefined {
        const fromSnapshot = snapshot?.files.find((file) => file.path === path);
        return fromSnapshot ?? measured.get(path);
    }

    function fromAnalysis(path: string, model: monaco.editor.ITextModel, file: FileFunctionMetrics | null): OutlineState {
        if (!file) {
            return { kind: 'empty', path, reason: 'No symbols: the Code-XR analysis could not read this file. Set up Python in the Analysis view to get an outline.' };
        }
        if (file.functions.length === 0) {
            return { kind: 'empty', path, reason: 'No functions found in this file.' };
        }
        return { kind: 'symbols', path, symbols: outlineFromFunctions(file.functions, model.getValue(), model.getLanguageId()), source: 'analysis' };
    }

    async function compute(): Promise<void> {
        const run = ++generation;
        const target = current;
        if (!target) {
            publish({ kind: 'no-editor' });
            return;
        }
        const { path, model } = target;
        const languageId = model.getLanguageId();
        if (TYPESCRIPT_LANGUAGES.has(languageId)) {
            const symbols = await typeScriptSymbols(model).catch(() => null);
            if (run === generation) {
                publish(symbols && symbols.length > 0 ? { kind: 'symbols', path, symbols, source: 'language' } : { kind: 'empty', path, reason: 'No symbols found in this file.' });
            }
            return;
        }
        if (NO_ANALYSIS.has(languageId)) {
            publish({ kind: 'empty', path, reason: 'The outline does not cover this kind of file.' });
            return;
        }
        const known = knownFunctions(path);
        if (known !== undefined) {
            publish(fromAnalysis(path, model, known));
            return;
        }
        publish({ kind: 'loading', path });
        const file = await api.problems.fileFunctions(path).catch(() => null);
        if (measured.size >= MAX_CACHED_FILES) {
            measured.delete(measured.keys().next().value ?? '');
        }
        measured.set(path, file);
        if (run === generation) {
            publish(fromAnalysis(path, model, file));
        }
    }

    function follow(model: monaco.editor.ITextModel): void {
        contentListener?.dispose();
        contentListener = null;
        if (!TYPESCRIPT_LANGUAGES.has(model.getLanguageId())) {
            return;
        }
        contentListener = model.onDidChangeContent(() => {
            clearTimeout(typingTimer);
            typingTimer = setTimeout(() => void compute(), TYPING_DELAY_MS);
        });
    }

    return {
        activeChanged(): void {
            const next = editors.activeModel();
            current = next ? { path: next.path, model: next.model } : null;
            clearTimeout(typingTimer);
            if (next) {
                follow(next.model);
            } else {
                contentListener?.dispose();
                contentListener = null;
            }
            void compute();
        },
        cursorMoved(line): void {
            view.follow(line);
            breadcrumbs.follow(line);
        },
        fileClean(path): void {
            measured.delete(path);
            if (current?.path === path && !TYPESCRIPT_LANGUAGES.has(current.model.getLanguageId())) {
                void compute();
            }
        },
        setSnapshot(next): void {
            snapshot = next;
            if (current && !TYPESCRIPT_LANGUAGES.has(current.model.getLanguageId())) {
                void compute();
            }
        },
        setBreadcrumbsEnabled(enabled): void {
            breadcrumbs.setEnabled(enabled);
        },
    };
}
