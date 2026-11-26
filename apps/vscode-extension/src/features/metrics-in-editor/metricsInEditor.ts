import * as path from 'path';
import * as vscode from 'vscode';
import { onAnalysisLaunched, type AnalysisLaunched } from '../../core/analysis/analysisEvents';
import { ExecutePython } from '../../core/analysis/python/executePython';
import {
    complexityBand,
    metricLensTitle,
    metricProblems,
    type FunctionMetric,
    type FunctionMetricsSnapshot,
    type MetricThresholds,
} from '../../core/metrics/functionMetrics';
import { FunctionMetricsTracker } from '../../core/metrics/functionMetricsTracker';
import { getLogger } from '../../platform/logging/sink';

const logger = getLogger('METRICS_IN_EDITOR');

const SECTION = 'codeXR.problems.metrics';
const STALE_TITLE = '$(history) Code-XR metrics are out of date: save to measure this file again';

interface MetricSettings {
    readonly thresholds: MetricThresholds;
    readonly showInEditor: boolean;
}

function readSettings(): MetricSettings {
    const config = vscode.workspace.getConfiguration(SECTION);
    return {
        thresholds: {
            complexity: config.get<number>('maxComplexity', 10),
            lines: config.get<number>('maxFunctionLines', 50),
            parameters: config.get<number>('maxParameters', 5),
        },
        showInEditor: config.get<boolean>('showInEditor', true),
    };
}

function bandDecoration(color: string): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        overviewRulerColor: new vscode.ThemeColor(color),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        borderColor: new vscode.ThemeColor(color),
        borderStyle: 'solid',
        borderWidth: '0 0 0 2px',
    });
}

/**
 * The Code-XR IDE's metric checks and editor lenses (#173, #178), in VS Code.
 * After a folder or project analysis the backend measures every function
 * under it (the tracker in core/metrics, shared with the IDE), and then:
 * - each function over a limit is a warning in the Problems view;
 * - each function carries a CodeLens with its numbers;
 * - the functions the scene draws as high or critical complexity get a mark
 *   in the overview ruler and a line at the left of their code.
 * A saved file, or a measured file that changes on disk, is measured again.
 * The limits and the lenses are settings, applied without a new run.
 */
class MetricsInEditor implements vscode.CodeLensProvider {
    private readonly diagnostics = vscode.languages.createDiagnosticCollection('Code-XR');
    private readonly lensChanged = new vscode.EventEmitter<void>();
    private readonly decorations = { high: bandDecoration('editorWarning.foreground'), critical: bandDecoration('editorError.foreground') };
    private readonly staleDocuments = new Set<string>();
    private readonly tracker: FunctionMetricsTracker;
    private snapshot: FunctionMetricsSnapshot | null = null;
    private watcher: vscode.FileSystemWatcher | undefined;

    readonly onDidChangeCodeLenses = this.lensChanged.event;

    constructor(executor: ExecutePython) {
        this.tracker = new FunctionMetricsTracker(
            (target, kind, root) => executor.executeFunctionMetrics(target, kind, root),
            {
                onChange: (next) => {
                    this.snapshot = next;
                    this.refresh();
                },
                onLog: (level, message) => (level === 'warn' ? logger.warn(message) : logger.info(message)),
            },
        );
    }

    register(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            this.diagnostics,
            this.lensChanged,
            this.decorations.high,
            this.decorations.critical,
            { dispose: () => { this.tracker.dispose(); this.watcher?.dispose(); } },
            vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
            onAnalysisLaunched((event) => this.analysisLaunched(event)),
            vscode.workspace.onDidSaveTextDocument((document) => this.saved(document)),
            vscode.workspace.onDidChangeTextDocument((event) => this.edited(event.document)),
            vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((editor) => this.decorate(editor))),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration(SECTION)) {
                    this.refresh();
                }
            }),
        );
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const { thresholds, showInEditor } = readSettings();
        const functions = showInEditor ? this.functionsOf(document) : [];
        if (functions.length === 0) {
            return [];
        }
        if (document.isDirty) {
            return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: STALE_TITLE, command: '' })];
        }
        return functions.filter((fn) => fn.lineStart <= document.lineCount).map((fn) => {
            const { title, over } = metricLensTitle(fn, thresholds);
            const range = new vscode.Range(fn.lineStart - 1, 0, fn.lineStart - 1, 0);
            return new vscode.CodeLens(range, over
                ? { title, command: 'workbench.actions.view.problems', tooltip: `Show the problems of '${fn.name}'` }
                : { title, command: '' });
        });
    }

    /** A folder's analysis ran: measure its functions (and follow its files on disk). */
    private analysisLaunched(event: AnalysisLaunched): void {
        if (event.targetType !== 'directory') {
            return;
        }
        if (this.snapshot?.root !== event.targetPath) {
            this.watcher?.dispose();
            this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(event.targetPath, '**/*'), true, false, true);
            this.watcher.onDidChange((uri) => this.fileChanged(uri, true));
        }
        this.tracker.analyse(event.targetPath);
    }

    private saved(document: vscode.TextDocument): void {
        if (this.staleDocuments.delete(document.uri.toString())) {
            this.lensChanged.fire();
        }
        this.fileChanged(document.uri, false);
    }

    /** A document's lenses turn "out of date" with its first unsaved change, and back on undo. */
    private edited(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        if (document.isDirty !== this.staleDocuments.has(key)) {
            if (document.isDirty) { this.staleDocuments.add(key); } else { this.staleDocuments.delete(key); }
            this.lensChanged.fire();
        }
    }

    private relativePath(uri: vscode.Uri): string | undefined {
        if (!this.snapshot || uri.scheme !== 'file') {
            return undefined;
        }
        const relative = path.relative(this.snapshot.root, uri.fsPath);
        return relative.startsWith('..') || path.isAbsolute(relative) ? undefined : relative.split(path.sep).join('/');
    }

    private fileChanged(uri: vscode.Uri, onlyKnown: boolean): void {
        const relative = this.relativePath(uri);
        const root = this.snapshot?.root;
        if (relative === undefined || root === undefined || (onlyKnown && !this.tracker.knows(root, relative))) {
            return;
        }
        this.tracker.fileChanged(root, relative, uri.fsPath);
    }

    private functionsOf(document: vscode.TextDocument): readonly FunctionMetric[] {
        const relative = this.relativePath(document.uri);
        return relative === undefined ? [] : this.snapshot?.files.find((file) => file.path === relative)?.functions ?? [];
    }

    private refresh(): void {
        this.diagnostics.clear();
        if (this.snapshot) {
            const root = this.snapshot.root;
            const byFile = new Map<string, vscode.Diagnostic[]>();
            for (const problem of metricProblems(this.snapshot.files, readSettings().thresholds)) {
                const line = Math.max(0, problem.startLine - 1);
                const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER), problem.message, vscode.DiagnosticSeverity.Warning);
                diagnostic.source = problem.source;
                diagnostic.code = problem.code;
                byFile.set(problem.path, [...(byFile.get(problem.path) ?? []), diagnostic]);
            }
            for (const [relativePath, list] of byFile) {
                this.diagnostics.set(vscode.Uri.file(path.join(root, ...relativePath.split('/'))), list);
            }
        }
        vscode.window.visibleTextEditors.forEach((editor) => this.decorate(editor));
        this.lensChanged.fire();
    }

    private decorate(editor: vscode.TextEditor): void {
        const ranges = { high: [] as vscode.Range[], critical: [] as vscode.Range[] };
        const lastLine = editor.document.lineCount;
        for (const fn of readSettings().showInEditor ? this.functionsOf(editor.document) : []) {
            const band = complexityBand(fn.complexity);
            if (band !== 'normal' && fn.lineStart <= lastLine) {
                ranges[band].push(new vscode.Range(fn.lineStart - 1, 0, Math.min(fn.lineEnd, lastLine) - 1, 0));
            }
        }
        editor.setDecorations(this.decorations.high, ranges.high);
        editor.setDecorations(this.decorations.critical, ranges.critical);
    }
}

export function registerMetricsInEditor(context: vscode.ExtensionContext): void {
    new MetricsInEditor(new ExecutePython(context)).register(context);
}
