/**
 * #284: what a failed push, pull or fetch says to the person. Git's own
 * message stays (it is the precise one); a sentence in front of it says what
 * to do for the failures that are not self-explanatory: a credential the IDE
 * will not ask for, a remote it cannot reach, a push the remote rejected.
 * Pure, unit-tested on strings.
 */

const AUTH_PATTERNS: readonly RegExp[] = [
    /terminal prompts disabled/i,
    /could not read (?:username|password)/i,
    /authentication failed/i,
    /permission denied \(publickey/i,
    /host key verification failed/i,
    /access denied/i,
    /the requested url returned error: 40[13]/i,
    /invalid username or (?:password|token)/i,
];

const NETWORK_PATTERNS: readonly RegExp[] = [
    /could not resolve host/i,
    /connection refused/i,
    /failed to connect/i,
    /network is unreachable/i,
    /connection timed out/i,
    /operation timed out/i,
];

export const AUTH_HINT = 'Git could not authenticate with the remote. The IDE never asks for passwords: set up a credential helper or an SSH key (for example by running the same Git command once in a terminal), then try again.';
export const NETWORK_HINT = 'Git could not reach the remote. Check the network and the remote URL.';
export const REJECTED_HINT = 'The remote has commits this branch does not have. Pull (or Sync) first, then push.';

/** The lines of git's output worth showing: errors and hints, not progress. */
function gitMessage(stderr: string): string {
    const lines = stderr.replace(/\r/g, '\n').split('\n').map((line) => line.trim()).filter((line) => line !== '');
    const important = lines.filter((line) => /^(?:fatal|error|remote|hint|warning):/i.test(line) || line.startsWith('! '));
    return (important.length > 0 ? important : lines).slice(-6).join('\n');
}

/** The message for a remote operation that failed with `stderr`. */
export function remoteErrorMessage(stderr: string): string {
    const message = gitMessage(stderr);
    if (AUTH_PATTERNS.some((pattern) => pattern.test(stderr))) {
        return `${AUTH_HINT}\n${message}`;
    }
    if (NETWORK_PATTERNS.some((pattern) => pattern.test(stderr))) {
        return `${NETWORK_HINT}\n${message}`;
    }
    if (/\[rejected\]|updates were rejected|non-fast-forward|fetch first/i.test(stderr)) {
        return `${REJECTED_HINT}\n${message}`;
    }
    return message || 'Git failed without saying why.';
}
