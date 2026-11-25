import { getLogger } from '../core/logging/sink';

const logger = getLogger('VISUALIZATION_CONFIG');

/**
 * Visualization Configuration Utility
 * Common functions for retrieving visualization settings across templates
 */

export interface TemplateVisualizationSettings {
    palette: string;
    environment: string;
    backgroundColor: string;
    groundColor: string;
}

/**
 * Get visualization settings (palette, environment, colors)
 * Centralized function used by all template processors
 */
export async function getVisualizationConfiguration(): Promise<TemplateVisualizationSettings> {
    try {
        logger.debug('Retrieving visualization settings...');
        
        // Import visualization settings functions directly (no dynamic import needed)
        const { 
            getSelectedPalette,
            getSelectedEnvironment,
            getSelectedBackgroundColor,
            getSelectedGroundColor
        } = require('../visualization_settings/utils/settingsAccessors');

        const settings = {
            palette: await getSelectedPalette(),
            environment: await getSelectedEnvironment(),
            backgroundColor: await getSelectedBackgroundColor(),
            groundColor: await getSelectedGroundColor()
        };

        logger.debug('Settings retrieved:', settings);
        return settings;

    } catch (error) {
        logger.error('Error retrieving settings:', error);
        
        // Return default settings if there's an error
        const defaultSettings = {
            palette: 'blues',
            environment: 'forest',
            backgroundColor: '#001122',
            groundColor: '#553311'
        };
        
        logger.warn('Using default settings:', defaultSettings);
        return defaultSettings;
    }
}
