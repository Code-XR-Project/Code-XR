import { complexityBand, metricLensTitle, type FileFunctionMetrics, type FunctionMetric, type MetricThresholds } from '../../shared/problems.ts';
import { monaco } from './monaco.ts';

/**
 * #178: the analysis in the editor. A CodeLens over each function the last
 * analysis measured ("CCN 7 · NLOC 42 · 3 params", a value over its
 * Problems limit marked), and a thin strip in the gutter and the overview
 * ruler beside the functions the scene draws as high or critical.
 *
 * The numbers describe the file as it was measured, which is the file on
 * disk: while a tab has unsaved changes its lenses give way to one
 * "out of date" lens, and saving measures it again. The strip is a set of
 * decorations, so it follows the lines as they are edited.
 */

export interface MetricLens {
    /** The measured functions, the limits, and whether the setting shows them. */
    update(files: readonly FileFunctionMetrics[], thresholds: MetricThresholds, enabled: boolean): void;
    /** A model was opened (it gets its strip) or its unsaved state changed (its lenses follow). */
    refresh(model: monaco.editor.ITextModel): void;
    /** A model is about to be disposed. */
    forget(model: monaco.editor.ITextModel): void;
}

export const SHOW_PROBLEMS_COMMAND = 'codexr.metrics.showProblems';

const BAND_CLASS = { high: 'metric-heat is-high', critical: 'metric-heat is-critical' } as const;
const BAND_RULER = { high: 'editorWarning.foreground', critical: 'editorError.foreground' } as const;

export function installMetricLens(scheme: string, hooks: {
    isStale(model: monaco.editor.ITextModel): boolean;
    /** A lens over a function past a limit was clicked: list its problems. */
    showProblems(path: string, name: string): void;
}): MetricLens {
    let byPath = new Map<string, readonly FunctionMetric[]>();
    let thresholds: MetricThresholds = { complexity: 0, lines: 0, parameters: 0 };
    let enabled = true;
    const strips = new Map<monaco.editor.ITextModel, string[]>();
    const changed = new monaco.Emitter<monaco.languages.CodeLensProvider>();
    const pathOf = (model: monaco.editor.ITextModel): string => model.uri.path.replace(/^\//, '');

    monaco.editor.registerCommand(SHOW_PROBLEMS_COMMAND, (_accessor, path: unknown, name: unknown) => {
        if (typeof path === 'string' && typeof name === 'string') {
            hooks.showProblems(path, name);
        }
    });

    const provider: monaco.languages.CodeLensProvider = {
        onDidChange: changed.event,
        provideCodeLenses(model) {
            const functions = enabled ? byPath.get(pathOf(model)) : undefined;
            if (!functions || functions.length === 0) {
                return { lenses: [], dispose(): void {} };
            }
            if (hooks.isStale(model)) {
                return {
                    lenses: [{
                        range: new monaco.Range(1, 1, 1, 1),
                        command: { id: '', title: '$(history) Code-XR metrics are out of date: save to measure this file again' },
                    }],
                    dispose(): void {},
                };
            }
            const lastLine = model.getLineCount();
            const lenses = functions.filter((fn) => fn.lineStart <= lastLine).map((fn): monaco.languages.CodeLens => {
                const { title, over } = metricLensTitle(fn, thresholds);
                return {
                    range: new monaco.Range(fn.lineStart, 1, fn.lineStart, 1),
                    command: over
                        ? { id: SHOW_PROBLEMS_COMMAND, title, arguments: [pathOf(model), fn.name], tooltip: `Show the problems of '${fn.name}'` }
                        : { id: '', title },
                };
            });
            return { lenses, dispose(): void {} };
        },
    };
    monaco.languages.registerCodeLensProvider({ scheme }, provider);

    function applyStrip(model: monaco.editor.ITextModel): void {
        const lastLine = model.getLineCount();
        const functions = enabled ? byPath.get(pathOf(model)) ?? [] : [];
        const decorations = functions.flatMap((fn): monaco.editor.IModelDeltaDecoration[] => {
            const band = complexityBand(fn.complexity);
            if (band === 'normal' || fn.lineStart > lastLine) {
                return [];
            }
            return [{
                range: new monaco.Range(fn.lineStart, 1, Math.min(fn.lineEnd, lastLine), 1),
                options: {
                    isWholeLine: true,
                    linesDecorationsClassName: BAND_CLASS[band],
                    overviewRuler: { color: { id: BAND_RULER[band] }, position: monaco.editor.OverviewRulerLane.Left },
                    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                },
            }];
        });
        strips.set(model, model.deltaDecorations(strips.get(model) ?? [], decorations));
    }

    return {
        update(files, nextThresholds, nextEnabled): void {
            byPath = new Map(files.map((file) => [file.path, file.functions]));
            thresholds = nextThresholds;
            enabled = nextEnabled;
            for (const model of monaco.editor.getModels()) {
                if (model.uri.scheme === scheme) {
                    applyStrip(model);
                }
            }
            changed.fire(provider);
        },
        refresh(model): void {
            if (!strips.has(model)) {
                applyStrip(model);
            }
            changed.fire(provider);
        },
        forget(model): void {
            strips.delete(model);
        },
    };
}
