import { EventEmitter } from 'events';
import type { HostDisposable, HostEvent } from './codeXRHost';

const FIRED = 'fired';

/**
 * A `vscode.EventEmitter` replacement for the core, built on Node `events` (#13, step 3).
 *
 * It keeps the contract the feature layer relies on, the same one
 * `ActiveServerRegistry.onRegistryChange` already keeps:
 * - `event` has the `vscode.Event` call shape (`listener, thisArgs?, disposables?`),
 *   so `features/` subscribers compile unchanged;
 * - listeners run synchronously, in subscription order;
 * - a throwing listener is reported through `onListenerError` and does not stop the others;
 * - after `dispose()` nothing is delivered and new subscriptions are inert.
 *
 * Dependency-free on purpose (core/host may import nothing): the owner passes
 * its own logger as `onListenerError`.
 */
export class HostEmitter<T> {
    private readonly emitter = new EventEmitter();
    private disposed = false;

    constructor(private readonly onListenerError: (error: unknown) => void) {
        // The registries this replaces are subscribed by a handful of views; no leak warning.
        this.emitter.setMaxListeners(0);
    }

    public readonly event: HostEvent<T> = (listener, thisArgs, disposables) => {
        const bound = (value: T): void => {
            try {
                listener.call(thisArgs, value);
            } catch (error) {
                this.onListenerError(error);
            }
        };
        if (!this.disposed) {
            this.emitter.on(FIRED, bound);
        }
        const subscription: HostDisposable = {
            dispose: () => {
                this.emitter.off(FIRED, bound);
            },
        };
        disposables?.push(subscription);
        return subscription;
    };

    public fire(value: T): void {
        if (!this.disposed) {
            this.emitter.emit(FIRED, value);
        }
    }

    public dispose(): void {
        this.disposed = true;
        this.emitter.removeAllListeners();
    }
}
