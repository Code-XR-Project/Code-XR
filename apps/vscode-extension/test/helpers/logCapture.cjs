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
 *   replaced, unless the message still carries a module tag of its own (a
 *   compound one such as REQUEST_UPDATE: or SERVER_DEBUG:, or SERVER:, which
 *   the migration left in place where it is not the file's scope; any other
 *   plain word, such as NOTE:, is message text);
 * - rest: the metadata as the one extra console argument, or nothing.
 * Returns the unsubscribe function.
 */
const OWN_TAG = /^\[?(?:[A-Z][A-Z0-9]*[_-][A-Z0-9_-]*|SERVER)\]?:/;

function observeLogsAsConsole(sink, record) {
    return sink.observeLogEntries((entry) => {
        const level = entry.level === 'debug' || entry.level === 'info' ? 'log' : entry.level;
        const first = OWN_TAG.test(entry.message) ? entry.message : `${entry.scope}: ${entry.message}`;
        record(level, first, [...entry.metadata]);
    });
}

module.exports = { observeLogsAsConsole };
