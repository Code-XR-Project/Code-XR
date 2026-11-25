/**
 * File Hash record
 * The (path, SHA256) entry shared by the watchers and the analysis session.
 */

/**
 * Tuple representing a file path and its SHA256 hash
 */
export interface FileHash {
    filePath: string;
    hash: string;
    size?: number;
    mtimeMs?: number;
}
