import type { AnalysisStartResult, AutoStartMode, CodeXRApi, PythonEnvStatus } from '../shared/api.ts';
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
}

export function createAnalysisRunView(
    container: HTMLElement,
    api: CodeXRApi['analysis'],
    callbacks: { onStatus(message: string): void },
): AnalysisRunView {
    const run = el('button', { className: 'primary-button', text: 'Analyse project in XR (deep)', attrs: { type: 'button', 'data-testid': 'analyse-project-xr-deep' } });
    const note = el('p', { className: 'muted small', attrs: { 'data-testid': 'analysis-note' } });
    const auto = el('input', { attrs: { type: 'checkbox', id: 'analysis-auto-start', 'data-testid': 'analysis-auto-start' } });
    const autoLabel = el('label', { className: 'checkbox-row small', attrs: { for: 'analysis-auto-start' } }, [auto, el('span', { text: 'Analyse in XR when a folder opens' })]);
    container.append(el('section', { className: 'env-section', attrs: { 'aria-labelledby': 'analysis-run-heading' } }, [
        el('h3', { className: 'side-bar-subtitle', text: 'Analyse', attrs: { id: 'analysis-run-heading' } }),
        el('div', { className: 'env-body' }, [
            el('p', { className: 'small', text: 'Every file of the open folder, with its subfolders, as an XR scene beside the code.' }),
            el('div', { className: 'env-actions' }, [run]),
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
        note.textContent = running ? 'Analysing… the scene opens when it is ready.'
            : !hasFolder ? 'Open a folder to analyse it.'
            : !pythonReady ? 'Set up the Python environment above first.'
            : '';
    };

    function start(automatic: boolean): void {
        running = true;
        update();
        callbacks.onStatus(automatic ? 'Analysing the opened project in XR (deep)…' : 'Analysing the project in XR (deep)…');
        api.analyseProject('xr-deep', { auto: automatic }).then((result: AnalysisStartResult) => {
            callbacks.onStatus(result.ok ? 'Analysis ready.' : result.message);
        }, (error: unknown) => callbacks.onStatus(`The analysis failed: ${String(error)}`)).finally(() => {
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

    return {
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
                callbacks.onStatus('Set up Python in the Analysis view to see this project in XR.');
            }
            startPendingAuto();
        },
    };
}
