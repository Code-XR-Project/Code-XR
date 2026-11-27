import { BrowserWindow } from 'electron';
import { attachLogTarget, setVerboseLogging } from '@codexr/logging/sink';
import { IPC_EVENTS, type OutputAppended } from '../../shared/api.ts';
import { channelForScope, isOutputChannel, MAX_OUTPUT_LINES, OUTPUT_CHANNELS, OutputBuffer, outputLines, type OutputChannelId } from '../../shared/output.ts';
import { setLogSink } from '../log.ts';

/**
 * The Output panel's lines (#174). Every main-process log line (`log.ts`)
 * and every line the core logs (its sink, by scope) lands in a bounded
 * buffer per channel, with secrets taken out first. New lines reach the
 * windows in batches, at most every FLUSH_MS, so a chatty pip install does
 * not send one message per line.
 */

const FLUSH_MS = 80;

export class OutputService {
    private readonly buffers = new Map<OutputChannelId, OutputBuffer>(OUTPUT_CHANNELS.map((channel) => [channel.id, new OutputBuffer()]));
    private pending = new Map<OutputChannelId, string[]>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    /** The core's metadata lines (stack traces, JSON) follow their log line into its channel. */
    private lastCoreChannel: OutputChannelId = 'core';

    /** Starts collecting: the IDE's own logger and the core's. */
    install(): void {
        setLogSink((channel, level, message) => this.append(channel, `${timestamp()} [${level.toUpperCase()}] ${message}`));
        // The panel shows the core's info lines too (the log file would have them in development).
        setVerboseLogging(true);
        attachLogTarget({
            appendLine: (line: string) => {
                // The core writes a call's absent metadata as the word "undefined".
                if (line === 'undefined') {
                    return;
                }
                const scope = /^\[[^\]]*\] \[[A-Z]+\] \[([^\]]+)\]/.exec(line)?.[1];
                if (scope !== undefined) {
                    this.lastCoreChannel = channelForScope(scope);
                }
                this.append(this.lastCoreChannel, line);
            },
        });
    }

    append(channel: OutputChannelId, text: string): void {
        const lines = outputLines(text);
        this.buffers.get(channel)?.append(lines);
        const queued = this.pending.get(channel) ?? [];
        queued.push(...lines);
        this.pending.set(channel, queued);
        this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
    }

    lines(channel: unknown): readonly string[] {
        if (!isOutputChannel(channel)) {
            throw new Error('Unknown output channel.');
        }
        return this.buffers.get(channel)?.snapshot() ?? [];
    }

    clear(channel: unknown): void {
        if (!isOutputChannel(channel)) {
            throw new Error('Unknown output channel.');
        }
        this.buffers.get(channel)?.clear();
        this.pending.delete(channel);
        this.broadcast({ channel, lines: [], cleared: true });
    }

    private flush(): void {
        this.timer = undefined;
        const pending = this.pending;
        this.pending = new Map();
        for (const [channel, lines] of pending) {
            // A burst larger than the buffer only needs its tail.
            this.broadcast({ channel, lines: lines.slice(-MAX_OUTPUT_LINES), cleared: false });
        }
    }

    private broadcast(payload: OutputAppended): void {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.webContents.isDestroyed()) {
                win.webContents.send(IPC_EVENTS.outputAppended, payload);
            }
        }
    }
}

function timestamp(): string {
    return `[${new Date().toISOString()}]`;
}

