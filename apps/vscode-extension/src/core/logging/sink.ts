import { CodeXRLogLevel, shouldEmitLog } from './logPolicy';

/**
 * The one place CodeXR diagnostics go through. Deliberately free of `vscode`,
 * so any module can log, including the ones the unit tests load without the
 * fake vscode. `logger.ts` attaches the "CodeXR" output channel as the target
 * at activation and keeps the verbose flag in sync with the setting.
 *
 * Until a target is attached, lines are kept in a bounded buffer that the
 * attach flushes through the level policy, so nothing logged before
 * activation is lost. Warnings and errors are also echoed to the console in
 * that window (and after the target is detached), so a failure that happens
 * before the channel exists, or outside the extension host, stays visible.
 * This file is the only one in src/ allowed to call `console.*`.
 */

export type MessageFactory = string | (() => string);

export interface ScopedLogger {
    debug(message: MessageFactory, metadata?: unknown): void;
    info(message: MessageFactory, metadata?: unknown): void;
    warn(message: MessageFactory, metadata?: unknown): void;
    error(message: MessageFactory, metadata?: unknown): void;
}

/** Anything that accepts whole lines: the output channel, in practice. */
export interface LogTarget {
    appendLine(line: string): void;
}

interface PendingEntry {
    readonly level: CodeXRLogLevel;
    readonly scope: string;
    readonly message: MessageFactory;
    readonly metadata: unknown;
    readonly timestamp: string;
}

/** How many lines the pre-attach buffer keeps; older ones are dropped first. */
export const PRE_ATTACH_BUFFER_LIMIT = 1000;

let target: LogTarget | undefined;
let verboseLoggingEnabled = false;
let pending: PendingEntry[] = [];
let droppedWhileDetached = 0;

class ScopedLoggerImpl implements ScopedLogger {
    constructor(private readonly scope: string) {}

    debug(message: MessageFactory, metadata?: unknown): void {
        writeLog('debug', this.scope, message, metadata);
    }

    info(message: MessageFactory, metadata?: unknown): void {
        writeLog('info', this.scope, message, metadata);
    }

    warn(message: MessageFactory, metadata?: unknown): void {
        writeLog('warn', this.scope, message, metadata);
    }

    error(message: MessageFactory, metadata?: unknown): void {
        writeLog('error', this.scope, message, metadata);
    }
}

/** A logger whose lines carry `[SCOPE]`. Cheap: it holds nothing but the scope. */
export function getLogger(scope: string): ScopedLogger {
    return new ScopedLoggerImpl(scope);
}

export function writeLog(
    level: CodeXRLogLevel,
    scope: string,
    message: MessageFactory,
    metadata?: unknown,
): void {
    const timestamp = new Date().toISOString();

    if (!target) {
        bufferEntry({ level, scope, message, metadata, timestamp });
        echoToConsole(level, scope, message, metadata);
        return;
    }

    if (!shouldEmitLog(level, verboseLoggingEnabled)) {
        return;
    }

    appendEntry(target, { level, scope, message, metadata, timestamp });
}

/**
 * Routes every later line to `newTarget` and flushes the buffer into it,
 * filtered by the verbose flag in force at that moment.
 */
export function attachLogTarget(newTarget: LogTarget): void {
    target = newTarget;

    const entries = pending;
    const dropped = droppedWhileDetached;
    pending = [];
    droppedWhileDetached = 0;

    if (dropped > 0) {
        appendEntry(newTarget, {
            level: 'warn',
            scope: 'LOGGER',
            message: `${dropped} earlier log line(s) were dropped before the output channel was ready.`,
            metadata: undefined,
            timestamp: new Date().toISOString(),
        });
    }

    for (const entry of entries) {
        if (shouldEmitLog(entry.level, verboseLoggingEnabled)) {
            appendEntry(newTarget, entry);
        }
    }
}

/** Stops writing to the target (it is being disposed); later lines are buffered again. */
export function detachLogTarget(): void {
    target = undefined;
}

export function setVerboseLogging(enabled: boolean): void {
    verboseLoggingEnabled = enabled;
}

export function isVerboseLogging(): boolean {
    return verboseLoggingEnabled;
}

function bufferEntry(entry: PendingEntry): void {
    pending.push(entry);
    if (pending.length > PRE_ATTACH_BUFFER_LIMIT) {
        pending.shift();
        droppedWhileDetached += 1;
    }
}

function appendEntry(destination: LogTarget, entry: PendingEntry): void {
    destination.appendLine(
        `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.scope}] ${renderMessage(entry.message)}`,
    );

    if (entry.metadata !== undefined) {
        destination.appendLine(formatMetadata(entry.metadata));
    }
}

function echoToConsole(level: CodeXRLogLevel, scope: string, message: MessageFactory, metadata: unknown): void {
    if (level !== 'warn' && level !== 'error') {
        return;
    }

    const line = `[CodeXR] [${scope}] ${renderMessage(message)}`;
    const args = metadata === undefined ? [line] : [line, metadata];
    if (level === 'warn') {
        console.warn(...args);
    } else {
        console.error(...args);
    }
}

function renderMessage(message: MessageFactory): string {
    if (typeof message !== 'function') {
        return message;
    }

    try {
        return message();
    } catch (error) {
        return `<log message failed to render: ${error instanceof Error ? error.message : String(error)}>`;
    }
}

export function formatMetadata(metadata: unknown): string {
    if (metadata instanceof Error) {
        return metadata.stack ?? metadata.message;
    }

    if (typeof metadata === 'string') {
        return metadata;
    }

    try {
        const json = JSON.stringify(metadata, null, 2);
        return json === undefined ? String(metadata) : json;
    } catch {
        return String(metadata);
    }
}
