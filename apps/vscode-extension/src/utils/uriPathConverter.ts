/**
 * URI Path Converter Utility
 * Handles conversion between VS Code URIs and file system paths
 */

import * as vscode from 'vscode';
import { getLogger } from '../platform/logging/sink';

const logger = getLogger('URI_PATH_CONVERTER');

function isUriString(value: string): boolean {
    return value.startsWith('file://') || value.startsWith('vscode-');
}

function isObjectInput(input: unknown): input is Record<string, unknown> {
    return !!input && typeof input === 'object';
}

/**
 * One way of reading a path out of a command argument: the path, or `null`
 * when the input is not of that shape. An empty string is a result, not a miss.
 */
type UriResolver = (input: unknown) => string | null;

/** A string: a URI string is parsed, anything else is already a path. */
const fromStringInput: UriResolver = (input) => {
    if (typeof input !== 'string') {
        return null;
    }
    if (isUriString(input)) {
        const uri = vscode.Uri.parse(input);
        logger.debug('Converted URI string to path:', uri.fsPath);
        return uri.fsPath;
    }
    logger.debug('Input is already a file system path:', input);
    return input;
};

/** A VS Code Uri, or anything carrying a string fsPath. */
const fromFsPathProperty: UriResolver = (input) => {
    if (!isObjectInput(input) || !('fsPath' in input) || typeof input.fsPath !== 'string') {
        return null;
    }
    logger.debug('Extracted fsPath from URI object:', input.fsPath);
    return input.fsPath;
};

/** A URI-like object with scheme and path. */
const fromSchemeAndPath: UriResolver = (input) => {
    if (!isObjectInput(input) || !('scheme' in input) || !('path' in input)) {
        return null;
    }
    const uri = vscode.Uri.from(input as unknown as { scheme: string; path: string });
    logger.debug('Created URI from object and extracted path:', uri.fsPath);
    return uri.fsPath;
};

/** Any other object whose string form is a URI string. */
const fromStringifiedObject: UriResolver = (input) => {
    if (!isObjectInput(input)) {
        return null;
    }
    const stringified = String(input);
    if (!isUriString(stringified)) {
        return null;
    }
    const uri = vscode.Uri.parse(stringified);
    logger.debug('Converted stringified object to path:', uri.fsPath);
    return uri.fsPath;
};

/** Tried in this order; the first non-null result wins. */
const URI_RESOLVERS: readonly UriResolver[] = [
    fromStringInput,
    fromFsPathProperty,
    fromSchemeAndPath,
    fromStringifiedObject,
];

/**
 * Convert VS Code URI or file path to a standard file system path
 * Handles various input types that VS Code commands can receive
 */
export function convertToFileSystemPath(input: unknown): string | null {
    try {
        // Handle null/undefined
        if (!input) {
            return null;
        }

        logger.debug(() => `Processing input (${typeof input})`, input);

        for (const resolve of URI_RESOLVERS) {
            const resolved = resolve(input);
            if (resolved !== null) {
                return resolved;
            }
        }

        logger.warn('Could not convert input to file system path:', input);
        return null;

    } catch (error) {
        logger.error('Error converting input to file system path:', error);
        return null;
    }
}

/**
 * Get file system path from active editor or provided input
 */
export function getFileSystemPathFromEditorOrInput(input?: any): string | null {
    try {
        // First try to convert the provided input
        if (input) {
            const convertedPath = convertToFileSystemPath(input);
            if (convertedPath) {
                return convertedPath;
            }
        }

        // Fallback to active editor
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const editorPath = activeEditor.document.uri.fsPath;
            logger.debug('Using active editor path:', editorPath);
            return editorPath;
        }

        logger.warn('No valid file path found from input or active editor');
        return null;

    } catch (error) {
        logger.error('Error getting file system path:', error);
        return null;
    }
}
