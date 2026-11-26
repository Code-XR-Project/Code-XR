import * as fs from 'fs';
import * as path from 'path';

/**
 * One analyzed file as the Python backend writes it into data.json. Only the
 * fields this module reads are named; the rest of the record passes through.
 */
export interface AnalysisFileEntry {
    filePath?: string | null;
    file_path?: string | null;
    relativePath?: unknown;
    fileName?: unknown;
    status?: string;
    language?: string;
    totalLines?: number;
    codeLines?: number;
    commentLines?: number;
    blankLines?: number;
    functionCount?: number;
    classCount?: number;
    cyclomaticComplexityNumber?: number;
    maxComplexity?: number;
    [field: string]: unknown;
}

/** The XR data.json: a flat array of file entries. */
export type XRAnalysisData = AnalysisFileEntry[];

/** The LivePanel data.json: file entries plus a summary block. */
export interface LivePanelAnalysisData {
    files?: AnalysisFileEntry[];
    summary?: Record<string, unknown>;
    [field: string]: unknown;
}

interface LivePanelSummary {
    totalFiles: number;
    totalFilesAnalyzed: number;
    totalFilesNotAnalyzed: number;
    totalLines: number;
    totalLinesOfCode: number;
    totalComments: number;
    totalBlankLines: number;
    totalFunctions: number;
    totalClasses: number;
    averageComplexity: number;
    languages: Record<string, number>;
}

export function isXRDataFormat(data: unknown): data is XRAnalysisData {
    return Array.isArray(data);
}

export function normalizeAnalysisPath(pathValue: string | null | undefined): string | null {
    if (!pathValue || typeof pathValue !== 'string') {
        return null;
    }

    let normalized = pathValue.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(normalized)) {
        normalized = normalized.slice(2);
    }

    while (normalized.includes('//')) {
        normalized = normalized.replace(/\/\//g, '/');
    }

    return normalized;
}

export function getAnalysisEntryPathCandidates(entry: AnalysisFileEntry | null | undefined): string[] {
    const candidates = new Set<string>();
    const filePath = normalizeAnalysisPath(entry?.filePath);
    const legacyPath = normalizeAnalysisPath(entry?.file_path);

    if (filePath) {
        candidates.add(filePath);
    }
    if (legacyPath) {
        candidates.add(legacyPath);
    }

    return Array.from(candidates);
}

export function matchesAnalysisEntryPath(entry: AnalysisFileEntry | null | undefined, targetPath: string): boolean {
    const normalizedTarget = normalizeAnalysisPath(targetPath);
    if (!normalizedTarget) {
        return false;
    }

    return getAnalysisEntryPathCandidates(entry).includes(normalizedTarget);
}

function removeMatchingEntries(entries: AnalysisFileEntry[], targetPath: string): number {
    const indexesToRemove: number[] = [];

    entries.forEach((entry, index) => {
        if (matchesAnalysisEntryPath(entry, targetPath)) {
            indexesToRemove.push(index);
        }
    });

    for (const index of indexesToRemove.reverse()) {
        entries.splice(index, 1);
    }

    return indexesToRemove.length;
}

export function hasMatchingXRFile(data: XRAnalysisData, filePath: string): boolean {
    return data.some((entry) => matchesAnalysisEntryPath(entry, filePath));
}

export function hasMatchingLivePanelFile(data: LivePanelAnalysisData, filePath: string): boolean {
    if (!data.files || !Array.isArray(data.files)) {
        return false;
    }

    return data.files.some((entry) => matchesAnalysisEntryPath(entry, filePath));
}

export function removeDeletedFileFromXRFormat(data: XRAnalysisData, deletedPath: string): boolean {
    return removeMatchingEntries(data, deletedPath) > 0;
}

export function removeDeletedFileFromLivePanelFormat(data: LivePanelAnalysisData, deletedPath: string): boolean {
    if (!data.files || !Array.isArray(data.files)) {
        return false;
    }

    return removeMatchingEntries(data.files, deletedPath) > 0;
}

export function upsertXRFiles(data: XRAnalysisData, entries: AnalysisFileEntry[]): boolean {
    let changed = false;

    for (const entry of entries) {
        const publicPath = entry?.filePath ?? entry?.file_path;
        if (typeof publicPath === 'string' && publicPath.length > 0) {
            removeMatchingEntries(data, publicPath);
        }

        data.push(entry);
        changed = true;
    }

    return changed;
}

export function upsertLivePanelFiles(data: LivePanelAnalysisData, entries: AnalysisFileEntry[]): boolean {
    if (!data.files) {
        data.files = [];
    }

    let changed = false;
    for (const entry of entries) {
        const publicPath = entry?.filePath ?? entry?.file_path;
        if (typeof publicPath === 'string' && publicPath.length > 0) {
            removeMatchingEntries(data.files, publicPath);
        }

        data.files.push(entry);
        changed = true;
    }

    return changed;
}

export function resolveTrackedSystemPath(rootPath: string, entry: AnalysisFileEntry | null | undefined): string | null {
    const relativePath = typeof entry?.relativePath === 'string' ? entry.relativePath.trim() : '';
    if (relativePath) {
        const systemRelativePath = relativePath.split('/').join(path.sep).split('\\').join(path.sep);
        return path.normalize(path.resolve(rootPath, systemRelativePath));
    }

    const fileName = typeof entry?.fileName === 'string' ? entry.fileName.trim() : '';
    if (fileName) {
        return path.normalize(path.resolve(rootPath, fileName));
    }

    const directCandidates = [entry?.filePath, entry?.file_path]
        .filter((value): value is string => typeof value === 'string' && value.length > 0);

    for (const candidate of directCandidates) {
        const normalizedCandidate = path.normalize(candidate);
        if (path.isAbsolute(normalizedCandidate) && fs.existsSync(normalizedCandidate)) {
            return normalizedCandidate;
        }
    }

    return null;
}

export function recalculateLivePanelSummary(data: LivePanelAnalysisData): void {
    if (!data.files || !Array.isArray(data.files)) {
        return;
    }

    const summary: LivePanelSummary = {
        totalFiles: data.files.length,
        totalFilesAnalyzed: 0,
        totalFilesNotAnalyzed: 0,
        totalLines: 0,
        totalLinesOfCode: 0,
        totalComments: 0,
        totalBlankLines: 0,
        totalFunctions: 0,
        totalClasses: 0,
        averageComplexity: 0,
        languages: {} as Record<string, number>,
    };

    let totalComplexity = 0;
    let filesWithComplexity = 0;

    for (const file of data.files) {
        if (file.status === 'success') {
            summary.totalFilesAnalyzed++;
            summary.totalLines += file.totalLines || 0;
            summary.totalLinesOfCode += file.codeLines || 0;
            summary.totalComments += file.commentLines || 0;
            summary.totalBlankLines += file.blankLines || 0;
            summary.totalFunctions += file.functionCount || 0;
            summary.totalClasses += file.classCount || 0;

            const complexity = file.cyclomaticComplexityNumber || file.maxComplexity || 0;
            if (complexity > 0) {
                totalComplexity += complexity;
                filesWithComplexity++;
            }

            const language = file.language || 'Unknown';
            summary.languages[language] = (summary.languages[language] || 0) + 1;
        } else {
            summary.totalFilesNotAnalyzed++;
        }
    }

    summary.averageComplexity = filesWithComplexity > 0
        ? Math.round((totalComplexity / filesWithComplexity) * 100) / 100
        : 0;

    data.summary = { ...data.summary, ...summary };
}

export function createEmptyFileEntry(filePath: string, rootPath?: string): AnalysisFileEntry {
    const fileName = path.basename(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const publicFilePath = normalizeAnalysisPath(filePath) ?? filePath;
    const relativePath = rootPath
        ? normalizeAnalysisPath(path.relative(rootPath, filePath)) ?? fileName
        : fileName;

    return {
        fileName,
        filePath: publicFilePath,
        relativePath,
        language: getLanguageFromExtension(extension),
        timestamp: new Date().toISOString(),
        status: 'empty',
        totalLines: 0,
        codeLines: 0,
        commentLines: 0,
        blankLines: 0,
        commentRatio: 0,
        codeRatio: 0,
        blankRatio: 0,
        classCount: 0,
        functionCount: 0,
        complexity: {
            averageComplexity: 0,
            maxComplexity: 0,
            functionCount: 0,
            highComplexityFunctions: 0,
            criticalComplexityFunctions: 0,
        },
        functions: [],
        classes: [],
        maxComplexity: 0,
        cyclomaticComplexityNumber: 0,
        cyclomaticComplexityDensity: 0,
        highComplexityFunctions: 0,
        criticalComplexityFunctions: 0,
        averageFunctionParameters: 0,
        maxFunctionParameters: 0,
        averageFunctionLines: 0,
        maxFunctionLines: 0,
        averageFunctionNestingDepth: 0,
        maxFunctionNestingDepth: 0,
        averageCognitiveComplexity: 0,
        maxCognitiveComplexity: 0,
        averageMaintainabilityIndex: 0,
        minMaintainabilityIndex: 0,
        totalHalsteadVolume: 0,
        totalHalsteadBugs: 0,
        fileSizeBytes: 0,
        file_path: publicFilePath,
    };
}

function getLanguageFromExtension(extension: string): string {
    const languageMap: Record<string, string> = {
        '.js': 'JavaScript',
        '.ts': 'TypeScript',
        '.tsx': 'TypeScript',
        '.jsx': 'JavaScript',
        '.py': 'Python',
        '.java': 'Java',
        '.cpp': 'C++',
        '.c': 'C',
        '.cs': 'C#',
        '.go': 'Go',
        '.rs': 'Rust',
        '.rb': 'Ruby',
        '.php': 'PHP',
        '.swift': 'Swift',
        '.kt': 'Kotlin',
        '.scala': 'Scala',
        '.vue': 'Vue',
        '.html': 'HTML',
        '.css': 'CSS',
        '.scss': 'SCSS',
        '.less': 'LESS',
    };

    return languageMap[extension] || 'Unknown';
}
