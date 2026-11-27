import path from 'node:path';
import type { Problem, ProblemSeverity } from '../../shared/problems.ts';
import type { ProblemMatcherName } from '../../shared/tasks.ts';
import { plainOutput } from '../agents/tools/commandTool.ts';

/**
 * #176: problem matchers. A task's output, read after it exits, becomes
 * Problems panel entries: `tsc` (both its plain and its `--pretty` lines) and
 * ESLint's default "stylish" report. Paths are made relative to the open
 * folder; anything outside it is dropped, as the panel only lists the
 * folder's files.
 */

export const MAX_TASK_PROBLEMS = 2000;

const TSC_PLAIN = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
const TSC_PRETTY = /^(.+?):(\d+):(\d+) - (error|warning|message) (TS\d+): (.*)$/;
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/;

export function matchProblems(rawOutput: string, matchers: readonly ProblemMatcherName[], root: string, platform: string = process.platform): Problem[] {
    const lines = plainOutput(rawOutput).split('\n');
    const problems: Problem[] = [];
    const add = (file: string, line: number, column: number, severity: ProblemSeverity, message: string, source: string, code?: string): void => {
        const relative = workspacePath(file.trim(), root, platform);
        if (relative === null || problems.length >= MAX_TASK_PROBLEMS) {
            return;
        }
        problems.push({
            path: relative,
            severity,
            message: message.trim(),
            source,
            origin: 'task',
            ...(code ? { code } : {}),
            startLine: line,
            startColumn: column,
            endLine: line,
            endColumn: column + 1,
        });
    };
    if (matchers.includes('tsc')) {
        for (const line of lines) {
            const match = TSC_PLAIN.exec(line) ?? TSC_PRETTY.exec(line);
            if (match) {
                const [, file = '', row = '1', column = '1', kind = 'error', code = '', message = ''] = match;
                add(file, Number(row), Number(column), kind === 'error' ? 'error' : kind === 'warning' ? 'warning' : 'info', message, 'tsc', code);
            }
        }
    }
    if (matchers.includes('eslint')) {
        let file: string | null = null;
        for (const line of lines) {
            if (line.trim() === '') {
                file = null;
                continue;
            }
            const row = file === null ? null : ESLINT_ROW.exec(line);
            if (row && file !== null) {
                const [, at = '1', column = '1', kind = 'error', message = '', rule] = row;
                add(file, Number(at), Number(column), kind === 'error' ? 'error' : 'warning', message, 'eslint', rule);
            } else if (!/^\s/.test(line) && !/^[\u2716\u00d7!]|problems? \(/.test(line)) {
                // Stylish prints the file on its own line, unindented, before its rows.
                file = line.trim();
            }
        }
    }
    return problems;
}

/** `file` (absolute, or relative to the folder) as a workspace path; null when it is outside. */
export function workspacePath(file: string, root: string, platform: string): string | null {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const absolute = paths.resolve(root, file);
    const relative = paths.relative(root, absolute);
    if (!relative || relative.startsWith('..') || paths.isAbsolute(relative)) {
        return null;
    }
    return relative.split(paths.sep).join('/');
}
