import type { OutputChannelId } from '../shared/output.ts';

/**
 * Main-process logging. Lines go to the terminal that started the IDE and,
 * once the Output panel's service is up (#174), to its channels. No
 * telemetry, ever.
 */
const PREFIX = '[code-xr-ide]';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogSink = (channel: OutputChannelId, level: LogLevel, message: string) => void;

let sink: LogSink | null = null;

/** #174: where every line also goes (the Output panel); null detaches it. */
export function setLogSink(next: LogSink | null): void {
    sink = next;
}

function describe(error: unknown): string {
    if (error === undefined || error === '') {
        return '';
    }
    return error instanceof Error ? `\n${error.stack ?? error.message}` : `\n${String(error)}`;
}

export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
}

/** A logger whose lines go to one Output channel. */
export function channelLog(channel: OutputChannelId): Logger {
    return {
        info(message: string): void {
            console.log(`${PREFIX} ${message}`);
            sink?.(channel, 'info', message);
        },
        warn(message: string): void {
            console.warn(`${PREFIX} ${message}`);
            sink?.(channel, 'warn', message);
        },
        error(message: string, error?: unknown): void {
            console.error(`${PREFIX} ${message}`, error ?? '');
            sink?.(channel, 'error', `${message}${describe(error)}`);
        },
    };
}

/** The IDE's own channel. */
export const log = channelLog('ide');
