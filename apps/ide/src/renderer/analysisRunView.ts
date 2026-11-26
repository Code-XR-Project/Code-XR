import type { AnalysisStartResult, CodeXRApi, PythonEnvStatus } from '../shared/api.ts';
import { el } from './dom.ts';

/**
 * The "Analyse" section of the Analysis view (#16): starts an analysis of the
 * open folder. The button is only enabled with a ready Python environment, and
 * the main process checks again, so nothing here can trigger a download.
 */
export interface AnalysisRunView {
    setPython(status: PythonEnvStatus): void;
    setHasFolder(hasFolder: boolean): void;
}

export function createAnalysisRunView(
    container: HTMLElement,
    api: CodeXRApi['analysis'],
    callbacks: { onStatus(message: string): void },
): AnalysisRunView {
    const run = el('button', { className: 'primary-button', text: 'Analyse project in XR (deep)', attrs: { type: 'button', 'data-testid': 'analyse-project-xr-deep' } });
    const note = el('p', { className: 'muted small', attrs: { 'data-testid': 'analysis-note' } });
    container.append(el('section', { className: 'env-section', attrs: { 'aria-labelledby': 'analysis-run-heading' } }, [
        el('h3', { className: 'side-bar-subtitle', text: 'Analyse', attrs: { id: 'analysis-run-heading' } }),
        el('div', { className: 'env-body' }, [
            el('p', { className: 'small', text: 'Every file of the open folder, with its subfolders, as an XR scene beside the code.' }),
            el('div', { className: 'env-actions' }, [run]),
            note,
        ]),
    ]));

    let pythonReady = false;
    let hasFolder = false;
    let running = false;
    const update = (): void => {
        run.disabled = running || !pythonReady || !hasFolder;
        note.textContent = running ? 'Analysing… the scene opens when it is ready.'
            : !hasFolder ? 'Open a folder to analyse it.'
            : !pythonReady ? 'Set up the Python environment above first.'
            : '';
    };

    run.addEventListener('click', () => {
        running = true;
        update();
        callbacks.onStatus('Analysing the project in XR (deep)…');
        api.analyseProject('xr-deep').then((result: AnalysisStartResult) => {
            callbacks.onStatus(result.ok ? 'Analysis ready.' : result.message);
        }, (error: unknown) => callbacks.onStatus(`The analysis failed: ${String(error)}`)).finally(() => {
            running = false;
            update();
        });
    });
    update();

    return {
        setPython(status: PythonEnvStatus): void {
            pythonReady = status.state === 'ready';
            update();
        },
        setHasFolder(value: boolean): void {
            hasFolder = value;
            update();
        },
    };
}
