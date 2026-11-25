import * as vscode from 'vscode';
import * as fs from 'fs';
import { VisualizationSettings, DEFAULT_VISUALIZATION_SETTINGS } from './settingsModel';
import {
    LEGACY_STORAGE_KEY,
    StoredVisualizationSettingsJson,
    getVisualizationConfigDirectory,
    getVisualizationSettingsFilePath,
} from './settingsFile';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('SETTINGS_STORAGE');

/**
 * Visualization Settings Storage
 * Manages persistent storage and retrieval of visualization configuration using file system
 */
export class VisualizationSettingsStorage {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        logger.debug('VISUALIZATION-SETTINGS: Storage manager initialized with file-based storage');
    }

    /**
     * Get the visualization configuration directory path
     */
    private getConfigDirectory(): string {
        return getVisualizationConfigDirectory(this.context.globalStorageUri);
    }

    /**
     * Get the settings file path
     */
    private getSettingsFilePath(): string {
        return getVisualizationSettingsFilePath(this.context.globalStorageUri);
    }

    /**
     * Ensure the configuration directory exists
     */
    private ensureConfigDirectory(): void {
        const configDir = this.getConfigDirectory();
        
        try {
            if (!fs.existsSync(configDir)) {
                logger.debug(() => `VISUALIZATION-SETTINGS: Creating configuration directory: ${configDir}`);
                fs.mkdirSync(configDir, { recursive: true });
            }
        } catch (error) {
            logger.error('VISUALIZATION-SETTINGS: Error creating configuration directory:', error);
            throw new Error(`Failed to create configuration directory: ${error}`);
        }
    }

    /**
     * Migrate legacy settings from globalState to file system
     */
    private migrateLegacySettings(): void {
        try {
            const legacySettings = this.context.globalState.get<VisualizationSettings>(
                LEGACY_STORAGE_KEY
            );

            if (legacySettings && !fs.existsSync(this.getSettingsFilePath())) {
                logger.debug('VISUALIZATION-SETTINGS: Migrating legacy settings to file system');
                
                const settingsFilePath = this.getSettingsFilePath();
                const jsonSettings = {
                    backgroundColor: legacySettings.backgroundColor,
                    groundColor: legacySettings.groundColor,
                    environment: legacySettings.environmentPreset,
                    palette: legacySettings.chartPalette
                };

                fs.writeFileSync(settingsFilePath, JSON.stringify(jsonSettings, null, 2), 'utf8');
                logger.debug('VISUALIZATION-SETTINGS: Legacy settings migration completed with all settings');
            }
        } catch (error) {
            logger.error('VISUALIZATION-SETTINGS: Error during legacy migration:', error);
            // Don't throw - migration failure shouldn't prevent normal operation
        }
    }

    /**
     * Get current visualization settings from file system
     */
    public getSettings(): VisualizationSettings {
        try {
            // Ensure directory exists and migrate legacy settings if needed
            this.ensureConfigDirectory();
            this.migrateLegacySettings();

            const settingsFilePath = this.getSettingsFilePath();
            
            if (fs.existsSync(settingsFilePath)) {
                const fileContent = fs.readFileSync(settingsFilePath, 'utf8');
                const jsonSettings = JSON.parse(fileContent) as StoredVisualizationSettingsJson;

                // Build complete settings from JSON with fallbacks to defaults
                const settings: VisualizationSettings = {
                    backgroundColor: jsonSettings.backgroundColor || DEFAULT_VISUALIZATION_SETTINGS.backgroundColor,
                    groundColor: jsonSettings.groundColor || DEFAULT_VISUALIZATION_SETTINGS.groundColor,
                    environmentPreset: jsonSettings.environment as any,
                    chartPalette: jsonSettings.palette as any
                };
                
                logger.debug('VISUALIZATION-SETTINGS: Loaded settings from file', settings);
                return settings;
            }
        } catch (error) {
            logger.error('VISUALIZATION-SETTINGS: Failed to load settings from file:', error);
        }

        logger.debug('VISUALIZATION-SETTINGS: Using default settings');
        return { ...DEFAULT_VISUALIZATION_SETTINGS };
    }

    /**
     * Save visualization settings to file system
     */
    public async saveSettings(settings: VisualizationSettings): Promise<void> {
        try {
            this.ensureConfigDirectory();
            
            const settingsFilePath = this.getSettingsFilePath();
            
            // Create settings object for JSON file (all four settings)
            const jsonSettings = {
                backgroundColor: settings.backgroundColor,
                groundColor: settings.groundColor,
                environment: settings.environmentPreset,
                palette: settings.chartPalette
            };

            // Save to JSON file
            fs.writeFileSync(settingsFilePath, JSON.stringify(jsonSettings, null, 2), 'utf8');
            
            // Also save complete settings to globalState for backward compatibility
            await this.context.globalState.update(
                LEGACY_STORAGE_KEY,
                settings
            );
            
            logger.debug('VISUALIZATION-SETTINGS: Settings saved to file and globalState', settings);
        } catch (error) {
            logger.error('VISUALIZATION-SETTINGS: Failed to save settings:', error);
            throw new Error(`Failed to save visualization settings: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Update a single setting field
     */
    public async updateSetting<K extends keyof VisualizationSettings>(
        key: K,
        value: VisualizationSettings[K]
    ): Promise<void> {
        const currentSettings = this.getSettings();
        const updatedSettings = {
            ...currentSettings,
            [key]: value
        };

        await this.saveSettings(updatedSettings);
        logger.debug(() => `VISUALIZATION-SETTINGS: Updated ${key} to '${value}'`);
    }

    /**
     * Reset settings to defaults
     */
    public async resetSettings(): Promise<void> {
        await this.saveSettings({ ...DEFAULT_VISUALIZATION_SETTINGS });
        logger.debug('VISUALIZATION-SETTINGS: Settings reset to defaults');
    }

    /**
     * Check if settings exist in storage
     */
    public hasStoredSettings(): boolean {
        const settingsFilePath = this.getSettingsFilePath();
        return fs.existsSync(settingsFilePath);
    }

    /**
     * Get formatted settings for display
     */
    public getFormattedSettings(): Record<string, string> {
        const settings = this.getSettings();
        return {
            backgroundColor: settings.backgroundColor,
            groundColor: settings.groundColor,
            environmentPreset: settings.environmentPreset,
            chartPalette: settings.chartPalette
        };
    }

    /**
     * Validate settings structure
     */
    public validateSettings(settings: any): settings is VisualizationSettings {
        return (
            typeof settings === 'object' &&
            typeof settings.backgroundColor === 'string' &&
            typeof settings.groundColor === 'string' &&
            typeof settings.environmentPreset === 'string' &&
            typeof settings.chartPalette === 'string'
        );
    }
}
