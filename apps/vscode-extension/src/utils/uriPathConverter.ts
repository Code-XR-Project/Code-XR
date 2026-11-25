/**
 * URI Path Converter Utility
 * Handles conversion between VS Code URIs and file system paths
 */

import * as vscode from 'vscode';
import { getLogger } from '../core/logging/sink';

const logger = getLogger('URI_PATH_CONVERTER');

/**
 * Convert VS Code URI or file path to a standard file system path
 * Handles various input types that VS Code commands can receive
 */
export function convertToFileSystemPath(input: any): string | null {
    try {
        // Handle null/undefined
        if (!input) {
            return null;
        }

        logger.debug(() => `Processing input (${typeof input})`, input);

        // If it's already a string path
        if (typeof input === 'string') {
            // Check if it's a URI string
            if (input.startsWith('file://') || input.startsWith('vscode-')) {
                const uri = vscode.Uri.parse(input);
                logger.debug('Converted URI string to path:', uri.fsPath);
                return uri.fsPath;
            }
            // It's already a file system path
            logger.debug('Input is already a file system path:', input);
            return input;
        }

        // If it's a VS Code URI object
        if (input && typeof input === 'object') {
            // Check if it has fsPath property (VS Code URI)
            if ('fsPath' in input && typeof input.fsPath === 'string') {
                logger.debug('Extracted fsPath from URI object:', input.fsPath);
                return input.fsPath;
            }

            // Check if it has scheme and path properties (URI-like object)
            if ('scheme' in input && 'path' in input) {
                const uri = vscode.Uri.from(input);
                logger.debug('Created URI from object and extracted path:', uri.fsPath);
                return uri.fsPath;
            }

            // Try to convert object to string and parse as URI
            const stringified = String(input);
            if (stringified.startsWith('file://') || stringified.startsWith('vscode-')) {
                const uri = vscode.Uri.parse(stringified);
                logger.debug('Converted stringified object to path:', uri.fsPath);
                return uri.fsPath;
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
