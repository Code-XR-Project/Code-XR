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

/**
 * Get current background color from file storage or globalState fallback
 */
async function getBackgroundColorFromStorage(): Promise<string> {
    try {
        // First try to read from JSON file
        const fileSettings = readSettingsFromFile();
        if (fileSettings && fileSettings.backgroundColor) {
            return fileSettings.backgroundColor;
        }
        
        // Fallback to globalState for backward compatibility
        if (extensionContext) {
            const legacySettings = extensionContext.globalState.get<any>(LEGACY_STORAGE_KEY);
            if (legacySettings && legacySettings.backgroundColor) {
                return legacySettings.backgroundColor;
            }
        }
    } catch (error) {
        logger.error('VISUALIZATION-SETTINGS: Error reading background color from storage:', error);
    }
    
    return DEFAULT_VISUALIZATION_SETTINGS.backgroundColor;
}

/**
 * Get current ground color from file storage or globalState fallback
 */
async function getGroundColorFromStorage(): Promise<string> {
    try {
        // First try to read from JSON file
        const fileSettings = readSettingsFromFile();
        if (fileSettings && fileSettings.groundColor) {
            return fileSettings.groundColor;
        }
        
        // Fallback to globalState for backward compatibility
        if (extensionContext) {
            const legacySettings = extensionContext.globalState.get<any>(LEGACY_STORAGE_KEY);
            if (legacySettings && legacySettings.groundColor) {
                return legacySettings.groundColor;
            }
        }
    } catch (error) {
        logger.error('VISUALIZATION-SETTINGS: Error reading ground color from storage:', error);
    }
    
    return DEFAULT_VISUALIZATION_SETTINGS.groundColor;
}

/**
 * Get the currently selected background color
 * @returns Promise<string> Hex color value (e.g., "#B10DC9")
 */
export async function getSelectedBackgroundColor(): Promise<string> {
    logger.debug('VISUALIZATION-SETTINGS: Getting selected background color');
    const color = await getBackgroundColorFromStorage();
    logger.debug(() => `VISUALIZATION-SETTINGS: Background color: ${color}`);
    return color;
}

/**
 * Get the currently selected ground color
 * @returns Promise<string> Hex color value (e.g., "#FFFFFF")
 */
export async function getSelectedGroundColor(): Promise<string> {
    logger.debug('VISUALIZATION-SETTINGS: Getting selected ground color');
    const color = await getGroundColorFromStorage();
    logger.debug(() => `VISUALIZATION-SETTINGS: Ground color: ${color}`);
    return color;
}

/**
 * Get the currently selected environment preset
 * @returns Promise<string> Environment preset name (e.g., "forest")
 */
export async function getSelectedEnvironment(): Promise<string> {
    logger.debug('VISUALIZATION-SETTINGS: Getting selected environment');
    
    const settings = readSettingsFromFile();
    const environment = settings?.environment || DEFAULT_VISUALIZATION_SETTINGS.environmentPreset;
    
    logger.debug(() => `VISUALIZATION-SETTINGS: Environment: ${environment}`);
    return environment;
}

/**
 * Get the currently selected chart palette
 * @returns Promise<string> Chart palette name (e.g., "ubuntu")
 */
export async function getSelectedPalette(): Promise<string> {
    logger.debug('VISUALIZATION-SETTINGS: Getting selected chart palette');
    
    const settings = readSettingsFromFile();
    const palette = settings?.palette || DEFAULT_VISUALIZATION_SETTINGS.chartPalette;
    
    logger.debug(() => `VISUALIZATION-SETTINGS: Palette: ${palette}`);
    return palette;
}

/**
 * Get all current settings in a single call (for efficiency)
 * @returns Promise<object> Object containing all current settings
 */
export async function getAllSelectedSettings(): Promise<{
    backgroundColor: string;
    groundColor: string;
    environment: string;
    palette: string;
}> {
    logger.debug('VISUALIZATION-SETTINGS: Getting all selected settings');
    
    const [backgroundColor, groundColor] = await Promise.all([
        getSelectedBackgroundColor(),
        getSelectedGroundColor()
    ]);
    
    const settings = readSettingsFromFile();
    const environment = settings?.environment || DEFAULT_VISUALIZATION_SETTINGS.environmentPreset;
    const palette = settings?.palette || DEFAULT_VISUALIZATION_SETTINGS.chartPalette;
    
    const allSettings = {
        backgroundColor,
        groundColor,
        environment,
        palette
    };
    
    logger.debug('VISUALIZATION-SETTINGS: All settings:', allSettings);
    return allSettings;
}
