/**
 * The set-up downloads the tree-sitter parsers the dependency graph uses
 * (backend `tools/download_parsers.py`), so an analysis never downloads
 * anything. The script prints one JSON line; this reads it.
 */

/** Generous: about 20 parsers from GitHub on a slow connection. */
export const PARSER_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface ParserDownloadSummary {
    requested: string[];
    downloaded: string[];
    missing: string[];
    error?: string;
}

function stringList(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
}

/** The summary in the script's output (its last JSON line), or undefined when there is none. */
export function parseParserDownload(stdout: string): ParserDownloadSummary | undefined {
    const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('{'));
    const last = lines.at(-1);
    if (!last) {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(last);
    } catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const requested = stringList(record.requested);
    const downloaded = stringList(record.downloaded);
    const missing = stringList(record.missing);
    if (!requested || !downloaded || !missing) {
        return undefined;
    }
    const summary: ParserDownloadSummary = { requested, downloaded, missing };
    if (typeof record.error === 'string') {
        summary.error = record.error;
    }
    return summary;
}
