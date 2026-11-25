import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Where the visualization settings live on disk, and the globalState key of
 * the pre-file format. Shared by the storage (which writes them) and the
 * accessors scene generation reads, so the two can never point at different
 * files. The names are persisted: changing one loses every user's settings.
 */
export const VISUALIZATION_CONFIG_DIR = 'visualization-configuration';
export const SETTINGS_FILE = 'visualization-settings.json';
/** globalState key of the settings before they moved to a file (still mirrored on save). */
export const LEGACY_STORAGE_KEY = 'visualizationSettings';

/** The JSON shape of the settings file. */
export interface StoredVisualizationSettingsJson {
    backgroundColor?: string;
    groundColor?: string;
    environment: string;
    palette: string;
}

export function getVisualizationConfigDirectory(globalStorageUri: vscode.Uri): string {
    return path.join(globalStorageUri.fsPath, VISUALIZATION_CONFIG_DIR);
}

export function getVisualizationSettingsFilePath(globalStorageUri: vscode.Uri): string {
    return path.join(getVisualizationConfigDirectory(globalStorageUri), SETTINGS_FILE);
}
