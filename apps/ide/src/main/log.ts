/**
 * Main-process logging. A single place to swap for a file sink later; for now
 * it writes to the terminal that started the IDE. No telemetry, ever.
 */
const PREFIX = '[code-xr-ide]';

export const log = {
    info(message: string): void {
        console.log(`${PREFIX} ${message}`);
    },
    warn(message: string): void {
        console.warn(`${PREFIX} ${message}`);
    },
    error(message: string, error?: unknown): void {
        console.error(`${PREFIX} ${message}`, error ?? '');
    },
};
