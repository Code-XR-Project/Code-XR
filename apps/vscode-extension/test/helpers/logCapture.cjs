'use strict';

/**
 * Lets a characterization test that recorded console lines keep recording
 * them after the module moved to the logger (logging programme, story #34).
 *
 * `observeLogsAsConsole(sink, record)` subscribes to the sink the modules
 * under test use (the one cached in the current fake-vscode scope) and hands
 * every log call to `record(level, first, rest)` in the console shape the
 * goldens were written in:
 * - level: debug and info become `log` (what console.log was mapped to);
 *   warn and error stay;
 * - first: `SCOPE: message`, the hand-written prefix the logger's [SCOPE] tag
 *   replaced, unless the message still carries a prefix of its own;
 * - rest: the metadata as the one extra console argument, or nothing.
 * Returns the unsubscribe function.
 */
function observeLogsAsConsole(sink, record) {
    return sink.observeLogEntries((entry) => {
        const level = entry.level === 'debug' || entry.level === 'info' ? 'log' : entry.level;
        const first = /^\[?[A-Z][A-Z0-9_-]*\]?:/.test(entry.message) ? entry.message : `${entry.scope}: ${entry.message}`;
        record(level, first, entry.metadata === undefined ? [] : [entry.metadata]);
    });
}

module.exports = { observeLogsAsConsole };
