import { blameText, changeAtLine, lineChanges, revertEdit, type GitBlameLine, type LineChange } from '../../shared/gitGutter.ts';
import { el } from '../dom.ts';
import { monaco } from './monaco.ts';

/**
 * #175: Git in the editor. Each open file is compared with its text at HEAD
 * as it is edited, and the lines that differ get a marker in the gutter
 * (added, modified, deleted) and in the overview ruler. Clicking a marker
 * opens, under the change, what HEAD had there with a Revert button (one
 * undoable edit). The cursor line ends with its blame: author, when, and the
 * commit's summary, from `git blame --contents` on the editor's text, so
 * unsaved lines say so.
 *
 * Everything comes from the main process (`baseline`, `blame`), which answers
 * null for a folder without Git, outside a repository, in Restricted Mode or
 * for an untracked file: then this draws nothing and says nothing.
 */

export interface GitDecorationsHooks {
    baseline(path: string): Promise<string | null>;
    blame(path: string, contents: string): Promise<readonly GitBlameLine[] | null>;
}

export interface GitDecorations {
    /** A model was opened for `path`: compare it with HEAD from now on. */
    attach(model: monaco.editor.ITextModel, path: string): void;
    /** A model is about to be disposed. */
    forget(model: monaco.editor.ITextModel): void;
    /** The repository moved (commit, checkout, stage): every baseline and blame is read again. */
    repositoryChanged(): void;
    /** An editor (one per group): its cursor line's blame and the gutter clicks. */
    addEditor(editor: monaco.editor.ICodeEditor): monaco.IDisposable;
    setBlameEnabled(enabled: boolean): void;
}

const DIFF_DELAY_MS = 150;
/** The peek's header (its buttons) and padding around the HEAD lines. */
const PEEK_CHROME_PX = 44;
const BLAME_DELAY_MS = 350;
const KIND_CLASS: Record<LineChange['kind'], string> = { added: 'is-added', modified: 'is-modified', deleted: 'is-deleted' };
const KIND_RULER: Record<LineChange['kind'], string> = {
    added: 'editorOverviewRuler.addedForeground',
    modified: 'editorOverviewRuler.modifiedForeground',
    deleted: 'editorOverviewRuler.deletedForeground',
};
const KIND_LABEL: Record<LineChange['kind'], string> = { added: 'Added lines', modified: 'Changed lines', deleted: 'Deleted lines' };

interface ModelState {
    readonly path: string;
    /** Undefined while it is being read; null when there is nothing to compare with. */
    baseline: string | null | undefined;
    changes: LineChange[];
    decorations: string[];
    timer: ReturnType<typeof setTimeout> | undefined;
    blame: { readonly version: number; readonly lines: readonly GitBlameLine[] | null } | null;
    blameLoading: Promise<void> | null;
    readonly listener: monaco.IDisposable;
    /** Bumped by `repositoryChanged`, so a slow answer about the old HEAD is dropped. */
    generation: number;
}

export function installGitDecorations(hooks: GitDecorationsHooks): GitDecorations {
    const states = new Map<monaco.editor.ITextModel, ModelState>();
    const editors = new Set<{ refreshBlame(): void; closePeek(model: monaco.editor.ITextModel | null): void }>();
    let blameEnabled = true;

    function loadBaseline(model: monaco.editor.ITextModel, state: ModelState): void {
        const generation = state.generation;
        state.baseline = undefined;
        hooks.baseline(state.path).then((text) => {
            if (states.get(model) !== state || state.generation !== generation) {
                return;
            }
            state.baseline = text;
            recompute(model, state);
        }, () => undefined);
    }

    function recompute(model: monaco.editor.ITextModel, state: ModelState): void {
        clearTimeout(state.timer);
        state.timer = undefined;
        state.changes = typeof state.baseline === 'string' ? lineChanges(state.baseline, model.getValue(monaco.editor.EndOfLinePreference.LF)) : [];
        const lastLine = model.getLineCount();
        state.decorations = model.deltaDecorations(state.decorations, state.changes.map((change): monaco.editor.IModelDeltaDecoration => ({
            range: new monaco.Range(Math.min(change.startLine, lastLine), 1, Math.min(change.endLine, lastLine), 1),
            options: {
                isWholeLine: true,
                linesDecorationsClassName: `git-gutter ${KIND_CLASS[change.kind]}`,
                overviewRuler: { color: { id: KIND_RULER[change.kind] }, position: monaco.editor.OverviewRulerLane.Left },
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
        })));
    }

    function schedule(model: monaco.editor.ITextModel, state: ModelState): void {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => recompute(model, state), DIFF_DELAY_MS);
    }

    /** The blame of the model's current text, read once per version. */
    function blameOf(model: monaco.editor.ITextModel, state: ModelState): readonly GitBlameLine[] | null | undefined {
        const version = model.getAlternativeVersionId();
        if (state.blame?.version === version) {
            return state.blame.lines;
        }
        if (!state.blameLoading && state.baseline !== null) {
            const generation = state.generation;
            state.blameLoading = hooks.blame(state.path, model.getValue()).then((lines) => {
                if (states.get(model) === state && state.generation === generation) {
                    state.blame = { version, lines };
                }
            }, () => undefined).finally(() => {
                state.blameLoading = null;
                if (states.get(model) === state) {
                    for (const editor of editors) {
                        editor.refreshBlame();
                    }
                }
            });
        }
        // Until the new one arrives, the last blame still describes the unchanged lines well enough.
        return state.baseline === null ? null : undefined;
    }

    return {
        attach(model, path): void {
            if (states.has(model)) {
                return;
            }
            const state: ModelState = {
                path,
                baseline: undefined,
                changes: [],
                decorations: [],
                timer: undefined,
                blame: null,
                blameLoading: null,
                listener: model.onDidChangeContent(() => {
                    schedule(model, state);
                    for (const editor of editors) {
                        editor.closePeek(model);
                    }
                }),
                generation: 0,
            };
            states.set(model, state);
            loadBaseline(model, state);
        },
        forget(model): void {
            const state = states.get(model);
            if (state) {
                clearTimeout(state.timer);
                state.listener.dispose();
                states.delete(model);
            }
        },
        repositoryChanged(): void {
            for (const [model, state] of states) {
                state.generation += 1;
                state.blame = null;
                loadBaseline(model, state);
            }
            for (const editor of editors) {
                editor.refreshBlame();
            }
        },
        setBlameEnabled(enabled): void {
            blameEnabled = enabled;
            for (const editor of editors) {
                editor.refreshBlame();
            }
        },
        addEditor(editor): monaco.IDisposable {
            const blameLine = editor.createDecorationsCollection();
            let blameTimer: ReturnType<typeof setTimeout> | undefined;
            let peek: { zone: string; model: monaco.editor.ITextModel; change: LineChange; dispose(): void } | null = null;

            function showBlame(): void {
                clearTimeout(blameTimer);
                const model = editor.getModel();
                const state = model ? states.get(model) : undefined;
                const position = editor.getPosition();
                if (!blameEnabled || !model || !state || !position) {
                    blameLine.clear();
                    return;
                }
                const lines = blameOf(model, state);
                const entry = lines?.find((line) => line.line === position.lineNumber);
                if (!entry) {
                    if (lines !== undefined) {
                        blameLine.clear();
                    }
                    return;
                }
                const end = model.getLineMaxColumn(position.lineNumber);
                const date = new Date(entry.authorTime * 1000).toLocaleString();
                blameLine.set([{
                    range: new monaco.Range(position.lineNumber, end, position.lineNumber, end),
                    options: {
                        showIfCollapsed: true,
                        after: { content: `    ${blameText(entry, Date.now())}`, inlineClassName: 'git-blame-inline', cursorStops: monaco.editor.InjectedTextCursorStops.None },
                        hoverMessage: entry.uncommitted
                            ? { value: 'Not committed yet' }
                            : { value: `**${escapeMarkdown(entry.author)}** ${escapeMarkdown(entry.authorMail)}, ${escapeMarkdown(date)}\n\n${escapeMarkdown(entry.summary)}\n\n\`${entry.hash}\`` },
                    },
                }]);
            }

            function scheduleBlame(): void {
                clearTimeout(blameTimer);
                blameLine.clear();
                blameTimer = setTimeout(showBlame, BLAME_DELAY_MS);
            }

            function closePeek(model: monaco.editor.ITextModel | null): void {
                if (!peek || (model && peek.model !== model)) {
                    return;
                }
                const { zone, dispose } = peek;
                peek = null;
                dispose();
                editor.changeViewZones((accessor) => accessor.removeZone(zone));
            }

            function openPeek(model: monaco.editor.ITextModel, change: LineChange): void {
                const sameChange = peek?.model === model && peek.change.hunk === change.hunk;
                closePeek(null);
                if (sameChange) {
                    return;
                }
                const revert = el('button', { className: 'secondary-button', attrs: { type: 'button', 'data-testid': 'git-peek-revert' }, text: 'Revert' });
                const close = el('button', { className: 'secondary-button', attrs: { type: 'button', 'data-testid': 'git-peek-close' }, text: 'Close' });
                const shown = change.originalLines.slice(0, 200);
                const body = change.kind === 'added'
                    ? el('p', { className: 'git-peek-note muted', text: 'These lines are not in HEAD. Revert removes them.' })
                    : el('pre', { className: 'git-peek-original', text: shown.join('\n') + (change.originalLines.length > shown.length ? '\n...' : '') });
                const node = el('div', { className: 'git-peek', attrs: { 'data-testid': 'git-peek' } }, [
                    el('div', { className: 'git-peek-header' }, [
                        el('span', { className: 'git-peek-title', text: `${KIND_LABEL[change.kind]}: HEAD had${change.kind === 'added' ? ' nothing here' : ':'}` }),
                        revert,
                        close,
                    ]),
                    body,
                ]);
                // A view zone sits under the text layer and gets no clicks, so the zone only makes room and
                // the peek itself is an overlay widget kept on top of it (as VS Code's own zone widgets are).
                node.addEventListener('mousedown', (event) => event.stopPropagation());
                const layout = (): void => {
                    const info = editor.getLayoutInfo();
                    node.style.width = `${Math.max(0, info.width - info.minimap.minimapWidth - info.verticalScrollbarWidth)}px`;
                };
                layout();
                revert.addEventListener('click', () => {
                    const edit = revertEdit(model.getValue(monaco.editor.EndOfLinePreference.LF).split('\n'), change);
                    const eol = model.getEOL();
                    closePeek(null);
                    editor.pushUndoStop();
                    editor.executeEdits('git.revert', [{
                        range: new monaco.Range(edit.startLine, edit.startColumn, edit.endLine, edit.endColumn),
                        text: eol === '\n' ? edit.text : edit.text.replace(/\n/g, eol),
                    }]);
                    editor.pushUndoStop();
                    editor.focus();
                });
                close.addEventListener('click', () => {
                    closePeek(null);
                    editor.focus();
                });
                const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
                const rows = change.kind === 'added' ? 1 : Math.min(12, Math.max(1, shown.length));
                const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo);
                body.style.fontFamily = fontInfo.fontFamily;
                body.style.fontSize = `${fontInfo.fontSize}px`;
                body.style.lineHeight = `${lineHeight}px`;
                const height = rows * lineHeight + PEEK_CHROME_PX;
                node.style.height = `${height}px`;
                const widget: monaco.editor.IOverlayWidget = {
                    getId: () => 'codexr.gitPeek',
                    getDomNode: () => node,
                    getPosition: () => null,
                };
                editor.addOverlayWidget(widget);
                const resize = editor.onDidLayoutChange(layout);
                editor.changeViewZones((accessor) => {
                    const zone = accessor.addZone({
                        afterLineNumber: change.endLine,
                        heightInPx: height,
                        domNode: el('div'),
                        onDomNodeTop: (top) => { node.style.top = `${top}px`; },
                    });
                    peek = { zone, model, change, dispose: () => { resize.dispose(); editor.removeOverlayWidget(widget); } };
                });
                editor.revealLineInCenterIfOutsideViewport(change.endLine + 1);
            }

            const handle = {
                refreshBlame: (): void => showBlame(),
                closePeek,
            };
            editors.add(handle);
            const disposables = [
                editor.onDidChangeCursorPosition(scheduleBlame),
                editor.onDidChangeModel(() => {
                    closePeek(null);
                    scheduleBlame();
                }),
                editor.onDidFocusEditorText(scheduleBlame),
                editor.onDidBlurEditorText(() => {
                    clearTimeout(blameTimer);
                    blameLine.clear();
                }),
                editor.onMouseDown((event) => {
                    if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) {
                        return;
                    }
                    const model = editor.getModel();
                    const state = model ? states.get(model) : undefined;
                    const line = event.target.position?.lineNumber;
                    const change = state && line !== undefined ? changeAtLine(state.changes, line) : undefined;
                    if (model && change) {
                        openPeek(model, change);
                    }
                }),
            ];
            return {
                dispose(): void {
                    clearTimeout(blameTimer);
                    editors.delete(handle);
                    closePeek(null);
                    blameLine.clear();
                    for (const disposable of disposables) {
                        disposable.dispose();
                    }
                },
            };
        },
    };
}

function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}
