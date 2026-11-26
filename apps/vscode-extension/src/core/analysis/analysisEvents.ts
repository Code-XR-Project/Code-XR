import type { HostDisposable } from '../host/codeXRHost';
import type { AnalysisMode, TargetType } from './session/analysisSession';

/** An analysis that the orchestrator launched (its scene or panel is up). */
export interface AnalysisLaunched {
    readonly targetPath: string;
    readonly targetType: TargetType;
    readonly analysisMode: AnalysisMode;
    readonly isDeep: boolean;
}

type Listener = (event: AnalysisLaunched) => void;

const listeners = new Set<Listener>();

/**
 * Lets a feature follow the analyses that ran without the orchestrator
 * knowing about it (#178: after a folder's analysis, its functions are
 * measured for the editor's lenses and the Problems view). A throwing
 * listener never breaks the analysis that notified it.
 */
export function onAnalysisLaunched(listener: Listener): HostDisposable {
    listeners.add(listener);
    return { dispose: () => { listeners.delete(listener); } };
}

export function notifyAnalysisLaunched(event: AnalysisLaunched, onError: (error: unknown) => void): void {
    for (const listener of [...listeners]) {
        try {
            listener(event);
        } catch (error) {
            onError(error);
        }
    }
}
