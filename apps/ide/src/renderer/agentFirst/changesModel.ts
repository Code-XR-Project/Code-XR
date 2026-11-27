import type { ChangedFileView, MetricChangeView, TurnMetricDeltaView } from '../../shared/agentSession.ts';

/**
 * Pure helpers of the review of a chat's changes (AF5, #270), its restores
 * (AF6, #271) and the metric delta under a turn (AF9, #274). No DOM.
 */

/** The Changes tab of a chat lives in the editor group under this scheme. */
export const CHANGES_ID_PREFIX = 'chat-changes:';

export function changesTabId(sessionId: string): string {
    return `${CHANGES_ID_PREFIX}${sessionId}`;
}

/** The session behind a Changes tab id, or null for any other tab. */
export function changesIdOf(tabId: string): string | null {
    if (!tabId.startsWith(CHANGES_ID_PREFIX)) {
        return null;
    }
    const id = tabId.slice(CHANGES_ID_PREFIX.length);
    return id.length > 0 ? id : null;
}

/** One letter per status, as Source Control shows them. */
export function statusLetter(status: ChangedFileView['status']): 'A' | 'M' | 'D' {
    return status === 'added' ? 'A' : status === 'deleted' ? 'D' : 'M';
}

/** "3 files, +40 -12". */
export function changesSummary(files: readonly ChangedFileView[]): string {
    if (files.length === 0) {
        return 'No pending changes.';
    }
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    return `${files.length} file${files.length === 1 ? '' : 's'}, +${additions} -${deletions}`;
}

/**
 * The file to show after the list changed: the one shown before if it is
 * still pending, else the one at the same position, else the first.
 */
export function nextSelection(files: readonly ChangedFileView[], previous: string | null, previousIndex = 0): string | null {
    if (files.length === 0) {
        return null;
    }
    if (previous !== null && files.some((file) => file.path === previous)) {
        return previous;
    }
    return files[Math.min(Math.max(previousIndex, 0), files.length - 1)]?.path ?? null;
}

/** What the inline confirmation of "Restore files to here" says. */
export function restorePrompt(paths: readonly string[]): string {
    if (paths.length === 0) {
        return 'The files are already as they were before this message.';
    }
    return `Restore ${paths.length} file${paths.length === 1 ? '' : 's'} to how they were before this message? The conversation is kept.`;
}

const METRIC_LABELS: Readonly<Record<string, string>> = {
    maxComplexity: 'Complexity max',
    avgComplexity: 'Complexity avg',
    cyclomaticComplexityNumber: 'Complexity avg',
    maxCognitiveComplexity: 'Cognitive max',
    averageMaintainabilityIndex: 'Maintainability',
    codeLines: 'LOC',
    totalLines: 'Lines',
    functionCount: 'Functions',
    classCount: 'Classes',
    highComplexityFunctions: 'High-complexity functions',
    criticalComplexityFunctions: 'Critical functions',
    files: 'Analysed files',
};

/** Metrics shown as "before -> after" (levels), the others as a signed difference (counts). */
const LEVELS = new Set(['maxComplexity', 'avgComplexity', 'cyclomaticComplexityNumber', 'maxCognitiveComplexity', 'averageMaintainabilityIndex']);

export function metricLabel(metric: string): string {
    return METRIC_LABELS[metric] ?? metric;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** "Complexity max 9 -> 1" or "LOC -6". */
export function formatMetricChange(change: MetricChangeView): string {
    const label = metricLabel(change.metric);
    if (LEVELS.has(change.metric) || change.before === null || change.after === null) {
        return `${label} ${change.before ?? '-'} -> ${change.after ?? '-'}`;
    }
    const delta = round(change.after - change.before);
    return `${label} ${delta > 0 ? '+' : ''}${delta}`;
}

/** The short line under a turn: the first few totals that moved, else the analysis' own summary. */
export function metricDeltaHeadline(delta: TurnMetricDeltaView, max = 3): string {
    if (delta.totals.length === 0) {
        return delta.summary;
    }
    return delta.totals.slice(0, max).map(formatMetricChange).join(', ');
}

/** One line per file for the details: "src/a.ts (changed): Complexity max 9 -> 1, LOC -6". */
export function metricDeltaFileLines(delta: TurnMetricDeltaView): string[] {
    const lines = delta.files.map((file) => `${file.path} (${file.status})${file.changes.length > 0 ? `: ${file.changes.map(formatMetricChange).join(', ')}` : ''}`);
    if (delta.moreFiles > 0) {
        lines.push(`and ${delta.moreFiles} more file${delta.moreFiles === 1 ? '' : 's'}`);
    }
    return lines;
}
