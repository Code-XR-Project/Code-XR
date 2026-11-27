import { monaco } from './monaco.ts';

/**
 * #180: the debugger in the editor. A click in the glyph margin (left of the
 * line numbers) sets or clears a breakpoint; breakpoints are decorations
 * that follow the text as it is edited, and when an edit moves them the new
 * lines are reported, so the debugger and the Breakpoints list follow too.
 * While a session is paused, the line it stopped on is highlighted with an
 * arrow in the margin (the top frame's, or the one picked in Call Stack).
 */

export interface DebugBreakpointMark {
    readonly line: number;
    /** False: the debugger could not place it (drawn hollow); null: no session yet. */
    readonly verified: boolean | null;
    readonly message: string | null;
}

export interface DebugDecorationsHooks {
    breakpoints(path: string): readonly DebugBreakpointMark[];
    /** A click in the glyph margin of `line`. */
    toggle(path: string, line: number): void;
    /** Edits moved the file's breakpoints (or removed lines under them). */
    moved(path: string, lines: readonly number[]): void;
}

export interface DebugDecorations {
    attach(model: monaco.editor.ITextModel, path: string): void;
    forget(model: monaco.editor.ITextModel): void;
    addEditor(editor: monaco.editor.ICodeEditor): monaco.IDisposable;
    /** Redraws the breakpoints of `path` (every file when null). */
    refresh(path: string | null): void;
    /** The paused line, or null when nothing is paused. `top` is false for a frame below the top one. */
    setExecutionPoint(point: { readonly path: string; readonly line: number; readonly top: boolean } | null): void;
}

interface ModelState {
    readonly path: string;
    breakpoints: string[];
    execution: string[];
    readonly listener: monaco.IDisposable;
}

export function installDebugDecorations(hooks: DebugDecorationsHooks): DebugDecorations {
    const states = new Map<monaco.editor.ITextModel, ModelState>();
    let point: { readonly path: string; readonly line: number; readonly top: boolean } | null = null;

    function drawBreakpoints(model: monaco.editor.ITextModel, state: ModelState): void {
        const lineCount = model.getLineCount();
        const decorations = hooks.breakpoints(state.path)
            .filter((mark) => mark.line <= lineCount)
            .map((mark): monaco.editor.IModelDeltaDecoration => ({
                range: new monaco.Range(mark.line, 1, mark.line, 1),
                options: {
                    glyphMarginClassName: mark.verified === false ? 'debug-breakpoint is-unverified' : 'debug-breakpoint',
                    glyphMarginHoverMessage: { value: mark.verified === false ? (mark.message ?? 'Unverified breakpoint') : 'Breakpoint' },
                    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                    overviewRuler: { color: '#e51400', position: monaco.editor.OverviewRulerLane.Left },
                },
            }));
        state.breakpoints = model.deltaDecorations(state.breakpoints, decorations);
    }

    function drawExecution(model: monaco.editor.ITextModel, state: ModelState): void {
        const here = point !== null && point.path === state.path && point.line <= model.getLineCount() ? point : null;
        state.execution = model.deltaDecorations(state.execution, here ? [{
            range: new monaco.Range(here.line, 1, here.line, 1),
            options: {
                isWholeLine: true,
                className: here.top ? 'debug-current-line' : 'debug-frame-line',
                glyphMarginClassName: here.top ? 'debug-current-arrow' : 'debug-frame-arrow',
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                zIndex: 10,
            },
        }] : []);
    }

    /** After an edit: the lines the breakpoint decorations ended on. */
    function readBack(model: monaco.editor.ITextModel, state: ModelState): void {
        const before = hooks.breakpoints(state.path).map((mark) => mark.line);
        const after = [...new Set(state.breakpoints.flatMap((id) => {
            const range = model.getDecorationRange(id);
            return range ? [range.startLineNumber] : [];
        }))].sort((a, b) => a - b);
        if (before.length !== after.length || before.some((line, index) => line !== after[index])) {
            hooks.moved(state.path, after);
        }
    }

    return {
        attach(model, path): void {
            if (states.has(model)) {
                return;
            }
            const state: ModelState = {
                path,
                breakpoints: [],
                execution: [],
                listener: model.onDidChangeContent(() => {
                    if (state.breakpoints.length > 0) {
                        readBack(model, state);
                    }
                }),
            };
            states.set(model, state);
            drawBreakpoints(model, state);
            drawExecution(model, state);
        },
        forget(model): void {
            states.get(model)?.listener.dispose();
            states.delete(model);
        },
        addEditor(editor): monaco.IDisposable {
            const hover = editor.createDecorationsCollection();
            return {
                dispose: combine(
                    editor.onMouseDown((event) => {
                        if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !event.event.leftButton) {
                            return;
                        }
                        const model = editor.getModel();
                        const state = model ? states.get(model) : undefined;
                        const line = event.target.position?.lineNumber;
                        if (state && line) {
                            hooks.toggle(state.path, line);
                        }
                    }),
                    // A faint dot where a click would put one, as in VS Code.
                    editor.onMouseMove((event) => {
                        const line = event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ? event.target.position?.lineNumber : undefined;
                        const model = editor.getModel();
                        const state = model ? states.get(model) : undefined;
                        if (!line || !state || hooks.breakpoints(state.path).some((mark) => mark.line === line)) {
                            hover.clear();
                            return;
                        }
                        hover.set([{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'debug-breakpoint-hint' } }]);
                    }),
                    editor.onMouseLeave(() => hover.clear()),
                ),
            };
        },
        refresh(path): void {
            for (const [model, state] of states) {
                if (path === null || state.path === path) {
                    drawBreakpoints(model, state);
                }
            }
        },
        setExecutionPoint(next): void {
            point = next;
            for (const [model, state] of states) {
                drawExecution(model, state);
            }
        },
    };
}

function combine(...disposables: monaco.IDisposable[]): () => void {
    return () => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
    };
}
