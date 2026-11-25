import * as vscode from 'vscode';
import * as fs from 'fs';
import { DEFAULT_VISUALIZATION_SETTINGS } from '../model/settingsModel';
import {
    LEGACY_STORAGE_KEY,
    StoredVisualizationSettingsJson,
    getVisualizationSettingsFilePath,
} from '../storage/settingsFile';
import { getLogger } from '../../core/logging/sink';

const logger = getLogger('SETTINGS_ACCESSORS');

/**
 * Settings Accessors
 * Clean utility functions to access visualization settings for babia-templates integration
 */

// Module-level cache for context
let extensionContext: vscode.ExtensionContext | null = null;

/**
 * Initialize the settings accessors with extension context
 * Must be called during extension activation
 */
export function initializeSettingsAccessors(context: vscode.ExtensionContext): void {
    extensionContext = context;
    logger.debug('VISUALIZATION-SETTINGS: Settings accessors initialized');
}

/**
 * Get the settings file path (the storage's own location, see settingsFile.ts)
 */
function getSettingsFilePath(): string {
    if (!extensionContext) {
        throw new Error('Settings accessors not initialized. Call initializeSettingsAccessors() first.');
    }
    return getVisualizationSettingsFilePath(extensionContext.globalStorageUri);
}

/**
 * Read settings from the JSON file
 */
function readSettingsFromFile(): StoredVisualizationSettingsJson | null {
    try {
        const settingsFilePath = getSettingsFilePath();
        
        if (fs.existsSync(settingsFilePath)) {
            const fileContent = fs.readFileSync(settingsFilePath, 'utf8');
            const jsonSettings = JSON.parse(fileContent) as StoredVisualizationSettingsJson;
            
            logger.debug('VISUALIZATION-SETTINGS: Read settings from file:', jsonSettings);
            return jsonSettings;
        }
    } catch (error) {
        logger.error('VISUALIZATION-SETTINGS: Error reading settings file:', error);
    }
    
    return null;
}

type ColorField = 'backgroundColor' | 'groundColor';

const COLOR_LABELS: Record<ColorField, string> = {
    backgroundColor: 'background',
    groundColor: 'ground',
};

/**
 * A colour from the settings file, or from globalState for backward
 * compatibility (only the two colours have this fallback), or the default.
 */
function resolveColor(field: ColorField, fileSettings: StoredVisualizationSettingsJson | null): string {
    try {
        const fileValue = fileSettings?.[field];
        if (fileValue) {
            return fileValue;
        }

        // Fallback to globalState for backward compatibility
        if (extensionContext) {
            const legacySettings = extensionContext.globalState.get<any>(LEGACY_STORAGE_KEY);
            if (legacySettings?.[field]) {
                return legacySettings[field];
            }
        }
    } catch (error) {
        logger.error(`VISUALIZATION-SETTINGS: Error reading ${COLOR_LABELS[field]} color from storage:`, error);
    }

    return DEFAULT_VISUALIZATION_SETTINGS[field];
}

function resolveEnvironment(fileSettings: StoredVisualizationSettingsJson | null): string {
    return fileSettings?.environment || DEFAULT_VISUALIZATION_SETTINGS.environmentPreset;
}

function resolvePalette(fileSettings: StoredVisualizationSettingsJson | null): string {
    return fileSettings?.palette || DEFAULT_VISUALIZATION_SETTINGS.chartPalette;
}

/**
 * Get the currently selected background color
 * @returns Promise<string> Hex color value (e.g., "#B10DC9")
 */
export async function getSelectedBackgroundColor(): Promise<string> {
    logger.debug('VISUALIZATION-SETTINGS: Getting selected background color');
    const color = resolveColor('backgroundColor', readSettingsFromFile());
    logger.debug(() => `VISUALIZATION-SETTINGS: Background color: ${color}`);
    return color;
}

/**
 * Get the currently selected ground color
 * @returns Promise<string> Hex color value (e.g., "#FFFFFF")
 */
export async function getSelectedGroundColor(): Promise<string> {
    logger.debug('VISUALIZATION-SETTINGS: Getting selected ground color');
    const color = resolveColor('groundColor', readSettingsFromFile());
    logger.debug(() => `VISUALIZATION-SETTINGS: Ground color: ${color}`);
    return color;
}

/**
 * Get the currently selected environment preset
 * @returns Promise<string> Environment preset name (e.g., "forest")
 */
export async function getSelectedEnvironment(): Promise<string> {
    logger.debug('VISUALIZATION-SETTINGS: Getting selected environment');
    const environment = resolveEnvironment(readSettingsFromFile());
    logger.debug(() => `VISUALIZATION-SETTINGS: Environment: ${environment}`);
    return environment;
}

/**
 * Get the currently selected chart palette
 * @returns Promise<string> Chart palette name (e.g., "ubuntu")
 */
export async function getSelectedPalette(): Promise<string> {
    logger.debug('VISUALIZATION-SETTINGS: Getting selected chart palette');
    const palette = resolvePalette(readSettingsFromFile());
    logger.debug(() => `VISUALIZATION-SETTINGS: Palette: ${palette}`);
    return palette;
}

/**
 * Get all current settings in a single call: one read of the settings file
 * for the four values (the single accessors read it once each).
 * @returns Promise<object> Object containing all current settings
 */
export async function getAllSelectedSettings(): Promise<{
    backgroundColor: string;
    groundColor: string;
    environment: string;
    palette: string;
}> {
    logger.debug('VISUALIZATION-SETTINGS: Getting all selected settings');

    const settings = readSettingsFromFile();
    const allSettings = {
        backgroundColor: resolveColor('backgroundColor', settings),
        groundColor: resolveColor('groundColor', settings),
        environment: resolveEnvironment(settings),
        palette: resolvePalette(settings),
    };

    logger.debug('VISUALIZATION-SETTINGS: All settings:', allSettings);
    return allSettings;
}
