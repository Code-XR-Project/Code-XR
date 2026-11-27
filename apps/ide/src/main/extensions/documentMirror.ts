import fs from 'node:fs';
import path from 'node:path';
import {
    MAX_DOCUMENT_EVENTS, MAX_SYNCED_DOCUMENT_LENGTH, rewritePaths, type DocumentEvent, type EditorStateData, type PositionData, type RangeData, type SelectionData, type TextChangeData,
} from '../../shared/extensionLanguageProtocol.ts';
import { TextDocumentModel } from '../../extensionHost/textDocument.ts';
import { Range, Uri } from '../../extensionHost/types.ts';
import { isInside, parseWorkspacePath } from '../workspace/workspacePath.ts';

/**
 * The main process's copy of a window's editor documents (#260). The
 * renderer reports every change of the files it has open; this checks each
 * event (the renderer is untrusted: paths go through the workspace path
 * rules), keeps the text, and hands the events on with absolute paths. A host
 * that starts later gets the documents from here, so `*` extensions see the
 * open files before the renderer could say anything.
 */

const MAX_LANGUAGE_ID = 128;
const MAX_CHANGES_PER_EVENT = 10_000;
const MAX_SELECTIONS = 1000;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;

function position(value: unknown): PositionData {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(isCount)) {
        throw new Error('Invalid position.');
    }
    return [value[0] as number, value[1] as number];
}

function range(value: unknown): RangeData {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(isCount)) {
        throw new Error('Invalid range.');
    }
    return [value[0] as number, value[1] as number, value[2] as number, value[3] as number];
}

function languageId(value: unknown): string {
    if (typeof value !== 'string' || value === '' || value.length > MAX_LANGUAGE_ID) {
        throw new Error('Invalid language id.');
    }
    return value;
}

/** Converts between the renderer's workspace paths and absolute paths of one folder. */
export class FolderPaths {
    readonly root: string;
    private readonly realRoot: string;

    constructor(root: string) {
        this.root = root;
        let real = root;
        try {
            real = fs.realpathSync(root);
        } catch {
            // The folder went away: only its own spelling matches.
        }
        this.realRoot = real;
    }

    /** The absolute path of a workspace path from the renderer; throws on anything else. */
    toAbsolute(workspacePath: unknown): string {
        const segments = parseWorkspacePath(workspacePath);
        if (segments.length === 0) {
            throw new Error('The folder itself is not a document.');
        }
        return path.join(this.root, ...segments);
    }

    /** The workspace path of an absolute path, or null when it is outside the folder. */
    toWorkspace(absolute: string): string | null {
        for (const root of this.root === this.realRoot ? [this.root] : [this.root, this.realRoot]) {
            if (isInside(root, absolute)) {
                const relative = path.relative(root, absolute);
                return relative === '' ? null : relative.split(path.sep).join('/');
            }
        }
        return null;
    }

    /** `rewritePaths` towards the renderer. */
    outward(value: unknown): unknown {
        return rewritePaths(value, (absolute) => (path.isAbsolute(absolute) ? this.toWorkspace(absolute) : null));
    }

    /** `rewritePaths` towards the host. */
    inward(value: unknown): unknown {
        return rewritePaths(value, (workspacePath) => {
            try {
                return this.toAbsolute(workspacePath);
            } catch {
                return null;
            }
        });
    }
}

export class DocumentMirror {
    private readonly documents = new Map<string, TextDocumentModel>();
    private editor: EditorStateData | null = null;

    /** Drops everything (the folder changed: the editor closes every tab). */
    reset(): void {
        this.documents.clear();
        this.editor = null;
    }

    /**
     * Checks and applies the renderer's events; returns them with absolute
     * paths for the host. An invalid event is dropped (and so is a change to
     * a document that was never opened).
     */
    accept(raw: unknown, paths: FolderPaths): DocumentEvent[] {
        if (!Array.isArray(raw)) {
            return [];
        }
        const accepted: DocumentEvent[] = [];
        for (const item of raw.slice(0, MAX_DOCUMENT_EVENTS)) {
            try {
                const event = this.acceptOne(item, paths);
                if (event) {
                    accepted.push(event);
                }
            } catch {
                // The renderer sent something it should not have: ignore that event.
            }
        }
        return accepted;
    }

    private acceptOne(item: unknown, paths: FolderPaths): DocumentEvent | null {
        if (typeof item !== 'object' || item === null) {
            return null;
        }
        const event = item as Record<string, unknown>;
        if (event['kind'] === 'editor') {
            this.editor = this.editorState(event['editor']);
            return { kind: 'editor', editor: this.editor ? { ...this.editor, path: paths.toAbsolute(this.editor.path) } : null };
        }
        const workspacePath = parseWorkspacePath(event['path']).join('/');
        const absolute = paths.toAbsolute(workspacePath);
        const document = this.documents.get(workspacePath);
        switch (event['kind']) {
            case 'open': {
                const text = event['text'];
                if (typeof text !== 'string' || text.length > MAX_SYNCED_DOCUMENT_LENGTH || !isCount(event['version'])) {
                    return null;
                }
                const opened = new TextDocumentModel(Uri.file(absolute), languageId(event['languageId']), event['version'], text);
                this.documents.set(workspacePath, opened);
                return { kind: 'open', path: absolute, languageId: opened.languageId, version: opened.version, text };
            }
            case 'change': {
                const changes = event['changes'];
                if (!document || !Array.isArray(changes) || changes.length > MAX_CHANGES_PER_EVENT || !isCount(event['version'])) {
                    return null;
                }
                const checked: TextChangeData[] = changes.map((change: unknown) => {
                    const { range: changeRange, text } = (change ?? {}) as { range?: unknown; text?: unknown };
                    if (typeof text !== 'string') {
                        throw new Error('Invalid change.');
                    }
                    return { range: range(changeRange), text };
                });
                for (const change of checked) {
                    const [startLine, startCharacter, endLine, endCharacter] = change.range;
                    document.applyChange(new Range(startLine, startCharacter, endLine, endCharacter), change.text);
                }
                if (document.getText().length > MAX_SYNCED_DOCUMENT_LENGTH) {
                    // Grew past the limit: the host stops following it.
                    this.documents.delete(workspacePath);
                    return { kind: 'close', path: absolute };
                }
                document.version = event['version'];
                return { kind: 'change', path: absolute, version: document.version, changes: checked };
            }
            case 'language': {
                if (!document) {
                    return null;
                }
                document.languageId = languageId(event['languageId']);
                return { kind: 'language', path: absolute, languageId: document.languageId };
            }
            case 'save':
                return document ? { kind: 'save', path: absolute } : null;
            case 'close':
                if (!document) {
                    return null;
                }
                this.documents.delete(workspacePath);
                if (this.editor?.path === workspacePath) {
                    this.editor = null;
                }
                return { kind: 'close', path: absolute };
            default:
                return null;
        }
    }

    private editorState(value: unknown): EditorStateData | null {
        if (value === null || typeof value !== 'object') {
            return null;
        }
        const state = value as Record<string, unknown>;
        const workspacePath = parseWorkspacePath(state['path']).join('/');
        if (!this.documents.has(workspacePath)) {
            return null;
        }
        const selections = Array.isArray(state['selections']) ? state['selections'].slice(0, MAX_SELECTIONS).map((selection: unknown): SelectionData => {
            const { anchor, active } = (selection ?? {}) as { anchor?: unknown; active?: unknown };
            return { anchor: position(anchor), active: position(active) };
        }) : [];
        const visibleRanges = Array.isArray(state['visibleRanges']) ? state['visibleRanges'].slice(0, MAX_SELECTIONS).map(range) : [];
        const tabSize = isCount(state['tabSize']) && state['tabSize'] > 0 && state['tabSize'] <= 64 ? state['tabSize'] : 4;
        return { path: workspacePath, selections, visibleRanges, tabSize, insertSpaces: state['insertSpaces'] !== false };
    }

    /** The documents and the active editor with absolute paths, for a host that starts now. */
    snapshot(paths: FolderPaths): { documents: { path: string; languageId: string; version: number; text: string }[]; activeEditor: EditorStateData | null } {
        const documents = [...this.documents.entries()].map(([workspacePath, document]) => ({
            path: paths.toAbsolute(workspacePath), languageId: document.languageId, version: document.version, text: document.getText(),
        }));
        return { documents, activeEditor: this.editor ? { ...this.editor, path: paths.toAbsolute(this.editor.path) } : null };
    }
}
