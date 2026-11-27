import { getLogger } from '../../platform/logging/sink';
import type { HostDisposable } from '../host/codeXRHost';
import { HostEmitter } from '../host/hostEmitter';
import { getHost } from '../host/hostRegistry';

const logger = getLogger('PYTHON_ENV');

export type PythonEnvUiStatus = 'idle' | 'installing' | 'ready' | 'error';

export interface PythonEnvUiState {
    status: PythonEnvUiStatus;
    message: string;
    detail?: string;
    isUiRestricted: boolean;
    updatedAt: string;
}

/**
 * Shared UI state for Python environment setup.
 * Allows the tree view and command handlers to react consistently.
 */
export class PythonEnvUiStateService {
    private static instance: PythonEnvUiStateService | undefined;

    private readonly emitter = new HostEmitter<PythonEnvUiState>((error) => {
        logger.error('Python environment state listener failed:', error);
    });
    private state: PythonEnvUiState = {
        status: 'idle',
        message: 'Python environment has not been configured yet.',
        isUiRestricted: false,
        updatedAt: new Date().toISOString(),
    };

    private constructor() {
        this.syncContextKeys();
    }

    public static getInstance(): PythonEnvUiStateService {
        if (!this.instance) {
            this.instance = new PythonEnvUiStateService();
        }

        return this.instance;
    }

    public getState(): PythonEnvUiState {
        return { ...this.state };
    }

    public onDidChangeState(listener: (state: PythonEnvUiState) => void): HostDisposable {
        return this.emitter.event(listener);
    }

    public beginInstallation(message: string, detail?: string): void {
        this.updateState({
            status: 'installing',
            message,
            detail,
            isUiRestricted: true,
        });
    }

    public reportProgress(message: string, detail?: string): void {
        this.updateState({
            status: 'installing',
            message,
            detail: detail ?? this.state.detail,
            isUiRestricted: true,
        });
    }

    public setReady(message: string, detail?: string): void {
        this.updateState({
            status: 'ready',
            message,
            detail,
            isUiRestricted: false,
        });
    }

    public setError(message: string, detail?: string): void {
        this.updateState({
            status: 'error',
            message,
            detail,
            isUiRestricted: true,
        });
    }

    public setIdle(message: string, detail?: string): void {
        this.updateState({
            status: 'idle',
            message,
            detail,
            isUiRestricted: false,
        });
    }

    private updateState(next: Omit<PythonEnvUiState, 'updatedAt'>): void {
        this.state = {
            ...next,
            updatedAt: new Date().toISOString(),
        };

        this.syncContextKeys();
        this.emitter.fire(this.getState());
    }

    /** Tells the host which Python-environment UI to lock (the extension: `setContext` keys `codeXR.pythonEnv.*`). */
    private syncContextKeys(): void {
        try {
            const host = getHost();
            host.signal({ kind: 'state', key: 'pythonEnv.uiLocked', value: this.state.isUiRestricted });
            host.signal({ kind: 'state', key: 'pythonEnv.retryAvailable', value: this.state.status === 'error' });
        } catch (error) {
            logger.warn('Failed to update the host UI state:', error);
        }
    }
}
