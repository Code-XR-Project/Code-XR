import type { AnalysisKind, AnalysisStartResult, AutoStartMode, CodeXRApi, FileAnalysisKind, ProjectAnalysisKind, PythonEnvStatus } from '../shared/api.ts';
import { el } from './dom.ts';

/**
 * The "Analyse" section of the Analysis view (#16): starts an analysis of the
 * open folder. The button is only enabled with a ready Python environment, and
 * the main process checks again, so nothing here can trigger a download.
 *
 * #139: with "Analyse in XR when a folder opens" on (the default), a folder
 * that opens is analysed unasked; without a ready Python environment the
 * analysis waits for one, and never sets it up by itself.
 */
export interface AnalysisRunView {
    setPython(status: PythonEnvStatus): void;
    setHasFolder(hasFolder: boolean): void;
    /** A folder has just opened in this window. */
    folderOpened(root: string): void;
    /** #18: the palette's "Analyse Project in XR"; false when it cannot start now. */
    analyse(kind?: ProjectAnalysisKind): boolean;
    /** #16: one file of the folder (explorer, tab menu, palette); false when it cannot start now. */
    analyseFile(kind: FileAnalysisKind, path: string): boolean;
    readonly canAnalyse: () => boolean;
}

/** What to analyse: the whole folder, or one of its files (`path`, a workspace path). */
interface AnalysisRequest {
    readonly kind: AnalysisKind;
    readonly path?: string;
}

/** How each analysis is named while it runs, and once its view is ready. */
const DESCRIPTIONS: Readonly<Record<AnalysisKind, { readonly how: string; readonly ready: string }>> = {
    'xr-deep': { how: 'in XR (deep)', ready: 'The XR (deep) scene' },
    'livepanel-deep': { how: 'as a LivePanel (deep)', ready: 'The LivePanel (deep)' },
    'xr-file': { how: 'in XR', ready: 'The XR scene' },
    'livepanel-file': { how: 'as a LivePanel', ready: 'The LivePanel' },
};

export function createAnalysisRunView(
    container: HTMLElement,
    api: CodeXRApi['analysis'],
    callbacks: {
        onStatus(message: string): void;
        /** #153: an analysis started (shown as a progress notification until it ends). */
        onStarted?(title: string): void;
        onFinished?(ok: boolean, message: string): void;
    },
): AnalysisRunView {
    const run = el('button', { className: 'primary-button', text: 'Analyse project in XR (deep)', attrs: { type: 'button', 'data-testid': 'analyse-project-xr-deep' } });
    const runLivePanel = el('button', { className: 'secondary-button', text: 'Analyse project as LivePanel (deep)', attrs: { type: 'button', 'data-testid': 'analyse-project-livepanel-deep' } });
    const note = el('p', { className: 'muted small', attrs: { 'data-testid': 'analysis-note' } });
    const auto = el('input', { attrs: { type: 'checkbox', id: 'analysis-auto-start', 'data-testid': 'analysis-auto-start' } });
    const autoLabel = el('label', { className: 'checkbox-row small', attrs: { for: 'analysis-auto-start' } }, [auto, el('span', { text: 'Analyse in XR when a folder opens' })]);
    container.append(el('section', { className: 'env-section', attrs: { 'aria-labelledby': 'analysis-run-heading' } }, [
        el('h3', { className: 'side-bar-subtitle', text: 'Analyse', attrs: { id: 'analysis-run-heading' } }),
        el('div', { className: 'env-body' }, [
            el('p', { className: 'small', text: 'Every file of the open folder, with its subfolders, as an XR scene or a 2D LivePanel beside the code. A single file is analysed from its menu in the explorer.' }),
            el('div', { className: 'env-actions' }, [run, runLivePanel]),
            autoLabel,
            note,
        ]),
    ]));

    let pythonReady = false;
    let hasFolder = false;
    let running = false;
    let autoMode: AutoStartMode | null = null;
    /** A folder opened while auto-start was on but Python was not ready yet. */
    let pendingAuto = false;
    /** The folder of the automatic analysis waiting or running, so a folder announced twice is analysed once. */
    let autoRoot: string | null = null;
    const update = (): void => {
        run.disabled = running || !pythonReady || !hasFolder;
        runLivePanel.disabled = run.disabled;
        note.textContent = running ? 'Analysing… the scene opens when it is ready.'
            : !hasFolder ? 'Open a folder to analyse it.'
            : !pythonReady ? 'Set up the Python environment above first.'
            : '';
    };

    function start(automatic: boolean, request: AnalysisRequest = { kind: 'xr-deep' }): void {
        running = true;
        update();
        const { how, ready } = DESCRIPTIONS[request.kind];
        const title = automatic ? `Analysing the opened project ${how}…` : `Analysing ${request.path ?? 'the project'} ${how}…`;
        callbacks.onStatus(title);
        callbacks.onStarted?.(title);
        const started = request.path === undefined
            ? api.analyseProject(request.kind as ProjectAnalysisKind, { auto: automatic })
            : api.analyseFile(request.kind as FileAnalysisKind, request.path);
        started.then((result: AnalysisStartResult) => {
            callbacks.onStatus(result.ok ? 'Analysis ready.' : result.message);
            callbacks.onFinished?.(result.ok, result.ok ? `${ready} is ready beside the code.` : result.message);
        }, (error: unknown) => {
            callbacks.onStatus(`The analysis failed: ${String(error)}`);
            callbacks.onFinished?.(false, `The analysis failed: ${String(error)}`);
        }).finally(() => {
            running = false;
            if (automatic && !pendingAuto) {
                autoRoot = null;
            }
            update();
            // A folder that opened while this one was analysed has its turn now.
            startPendingAuto();
        });
    }

    function startPendingAuto(): void {
        if (!pendingAuto || autoMode === null || running || !hasFolder) {
            return;
        }
        if (autoMode === 'off') {
            pendingAuto = false;
            autoRoot = null;
            return;
        }
        if (pythonReady) {
            pendingAuto = false;
            start(true);
        }
    }

    run.addEventListener('click', () => start(false));
    runLivePanel.addEventListener('click', () => start(false, { kind: 'livepanel-deep' }));
    auto.addEventListener('change', () => {
        const mode: AutoStartMode = auto.checked ? 'xr-deep' : 'off';
        api.setAutoStart(mode).then((saved) => {
            autoMode = saved;
            auto.checked = saved !== 'off';
        }, (error: unknown) => {
            auto.checked = autoMode !== 'off';
            callbacks.onStatus(`Could not save the choice: ${String(error)}`);
        });
    });
    api.autoStart().then((mode) => {
        autoMode = mode;
        auto.checked = mode !== 'off';
        startPendingAuto();
    }, (error: unknown) => callbacks.onStatus(`Could not read the analysis settings: ${String(error)}`));
    update();

    const canAnalyse = (): boolean => !running && pythonReady && hasFolder;
    return {
        canAnalyse,
        analyse(kind: ProjectAnalysisKind = 'xr-deep'): boolean {
            if (!canAnalyse()) {
                return false;
            }
            start(false, { kind });
            return true;
        },
        analyseFile(kind: FileAnalysisKind, path: string): boolean {
            if (!canAnalyse()) {
                return false;
            }
            start(false, { kind, path });
            return true;
        },
        setPython(status: PythonEnvStatus): void {
            pythonReady = status.state === 'ready';
            update();
            startPendingAuto();
        },
        setHasFolder(value: boolean): void {
            hasFolder = value;
            if (!value) {
                pendingAuto = false;
                autoRoot = null;
            }
            update();
        },
        folderOpened(root: string): void {
            if (root === autoRoot) {
                return;
            }
            autoRoot = root;
            pendingAuto = true;
            if (autoMode === 'xr-deep' && !pythonReady) {
                callbacks.onStatus('The XR analysis starts once the analysis dependencies are installed.');
            }
            startPendingAuto();
        },
    };
}
