/**
 * Turns a shell command an agent ran into the step it really was. Agents that
 * only have a shell (Codex) read files with `cat`/`sed -n`, search with `rg`
 * and run tests with `npm test`; drawing all of that as "execute" would hide
 * most of what they look at. Pure, no imports.
 */
import type { AgentStepKind } from './agentFlowModels';

export interface ClassifiedCommand {
    kind: AgentStepKind;
    /** File operands that look like paths (read/search targets). */
    paths: string[];
}

const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'nl', 'bat', 'wc', 'sed', 'awk', 'type', 'get-content']);
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'find', 'fd', 'ls', 'tree', 'dir', 'git-grep', 'select-string']);

/** Splits a command line into words, honouring simple quotes. Not a full shell parser. */
export function splitShellWords(command: string): string[] {
    const words: string[] = [];
    let current = '';
    let quote: string | null = null;
    let has = false;
    for (const ch of command) {
        if (quote) {
            if (ch === quote) { quote = null; } else { current += ch; }
            continue;
        }
        if (ch === '"' || ch === '\'') { quote = ch; has = true; continue; }
        if (/\s/.test(ch)) {
            if (has || current) { words.push(current); current = ''; has = false; }
            continue;
        }
        current += ch;
    }
    if (has || current) { words.push(current); }
    return words;
}

/** The first simple command of a pipeline / list (`cd x && cat y | head` -> `cat y`). */
function primarySegment(command: string): string[] {
    const segments = command.split(/&&|\|\||;|\|/).map((part) => splitShellWords(part.trim())).filter((w) => w.length > 0);
    // `cd dir && cat file`: skip the cd, it says nothing about intent.
    const meaningful = segments.find((words) => words[0] !== 'cd' && words[0] !== 'export' && words[0] !== 'set');
    return meaningful ?? segments[0] ?? [];
}

function looksLikePath(word: string): boolean {
    if (!word || word.startsWith('-') || word.includes('$') || word.includes('*')) {
        return false;
    }
    if (/^\d+(,\d+)?p?$/.test(word)) { return false; }
    return /[./\\]/.test(word) && /[A-Za-z0-9_]/.test(word) && !/^[a-z]+:\/\//i.test(word);
}

/** Unwraps `bash -lc "..."`, `sh -c '...'`, `powershell -Command ...`. */
export function unwrapShell(words: string[]): string {
    if (words.length >= 3 && /(^|\/)(ba|z|)sh$/.test(words[0]) && /^-\w*c$/.test(words[1])) {
        return words.slice(2).join(' ');
    }
    if (words.length >= 3 && /^(pwsh|powershell)(\.exe)?$/i.test(words[0]) && /^-c(ommand)?$/i.test(words[1])) {
        return words.slice(2).join(' ');
    }
    return words.join(' ');
}

export function classifyShellCommand(command: string): ClassifiedCommand {
    const words = primarySegment(command);
    if (words.length === 0) {
        return { kind: 'execute', paths: [] };
    }
    let name = words[0].replace(/^.*[/\\]/, '').toLowerCase();
    let args = words.slice(1);
    if (name === 'git' && args[0] === 'grep') { name = 'git-grep'; args = args.slice(1); }
    if (name === 'sed' && !args.some((a) => a === '-n' || /^\d+(,\d+)?p$/.test(a))) {
        return { kind: 'execute', paths: [] };
    }
    if (READ_COMMANDS.has(name)) {
        return { kind: 'read', paths: args.filter(looksLikePath) };
    }
    if (SEARCH_COMMANDS.has(name)) {
        return { kind: 'search', paths: args.filter(looksLikePath) };
    }
    return { kind: 'execute', paths: [] };
}

/**
 * The files an apply_patch body touches (`*** Update File: a/b.ts`, `*** Add
 * File:`, `*** Delete File:`), and the lines it adds/removes.
 */
export function parseApplyPatch(patch: string): { updated: string[]; added: string[]; deleted: string[]; plus: number; minus: number } {
    const result = { updated: [] as string[], added: [] as string[], deleted: [] as string[], plus: 0, minus: 0 };
    for (const line of patch.split(/\r?\n/)) {
        const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
        if (header) {
            const target = header[2].trim();
            if (header[1] === 'Update') { result.updated.push(target); }
            else if (header[1] === 'Add') { result.added.push(target); }
            else { result.deleted.push(target); }
            continue;
        }
        const move = /^\*\*\* Move to: (.+)$/.exec(line);
        if (move) { result.added.push(move[1].trim()); continue; }
        if (line.startsWith('+') && !line.startsWith('+++')) { result.plus += 1; }
        else if (line.startsWith('-') && !line.startsWith('---')) { result.minus += 1; }
    }
    return result;
}
