/**
 * Reading the Python backend's stderr, one line at a time.
 *
 * The backend reports progress as one JSON object per line (`progress`,
 * `info`, `debug`, `warning` or `error`); anything else is free text from
 * Python or a library. `classifyStderrLine` turns a line into what the
 * extension does with it: the diagnostic lines to log and, when the line
 * means progress, the report for the analysis notification. Pure, so it is
 * tested directly (test/analysis/pythonStderrStream.test.cjs) and end to end
 * through ExecutePython (test/analysis/pythonStderrProgress.test.cjs).
 */

type JsonRecord = Record<string, unknown>;

export interface StderrProgressReport {
    message: string;
    increment?: number;
}

export interface ClassifiedStderrLine {
    /** Diagnostic lines to log, in order. */
    logLines: string[];
    /** Present only when the line should update the progress notification. */
    report?: StderrProgressReport;
}

/** Returns null for a line that produces neither a log line nor a report. */
export function classifyStderrLine(line: string): ClassifiedStderrLine | null {
    const trimmed = line.trim();
    if (!trimmed) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return classifyText(trimmed);
    }

    // `null` parses but has no properties: it is read as free text, as is any
    // line that is not JSON. Other JSON values without a known key are ignored.
    if (parsed === null) {
        return classifyText(trimmed);
    }

    return classifyJson(parsed as JsonRecord);
}

function classifyJson(parsed: JsonRecord): ClassifiedStderrLine | null {
    if (parsed.progress) {
        return classifyProgress(parsed.progress as JsonRecord);
    }
    if (parsed.debug) {
        return { logLines: [`DEBUG: ${parsed.debug}`] };
    }
    if (parsed.info) {
        return { logLines: [`INFO: ${parsed.info}`], report: { message: parsed.info as string } };
    }
    if (parsed.warning) {
        return { logLines: [`WARNING: ${parsed.warning}`] };
    }
    if (parsed.error) {
        return { logLines: [`ERROR: ${parsed.error}`] };
    }
    return null;
}

function classifyProgress(progress: JsonRecord): ClassifiedStderrLine {
    const current = progress.current || 0;
    const total = progress.total || 0;
    const percentage = progress.percentage || 0;
    const fileName = progress.fileName || progress.file || progress.current_file || 'Processing file...';
    const message = progress.message || 'Processing';

    const logLines = [
        `PROGRESS [${current}/${total}] (${percentage}%) - ${message}`,
        `Current file: ${fileName}`,
    ];
    if (progress.operation) {
        logLines.push(`Operation: ${progress.operation}`);
    }
    if (progress.estimatedTime) {
        logLines.push(`Estimated time remaining: ${progress.estimatedTime}`);
    }

    if (!(Number(total) > 0)) {
        return { logLines };
    }

    const name = String(fileName);
    const displayFileName = name.includes('/') ? name.split('/').pop() : name;
    return {
        logLines,
        report: {
            message: `${current}/${total} (${percentage}%) - ${displayFileName}`,
            increment: Number(percentage) > 0 ? 100 / Number(total) : 0,
        },
    };
}

function classifyText(text: string): ClassifiedStderrLine {
    const reportsProgress = text.includes('Analyzing') || text.includes('Processing')
        || text.includes('Progress:') || text.includes('%');
    return reportsProgress
        ? { logLines: [text], report: { message: text } }
        : { logLines: [text] };
}
