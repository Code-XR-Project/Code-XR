/**
 * Profile Configuration Commands
 * Commands for managing analysis configuration profiles
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProfileConfigurationSetting } from './profileConfiguration';
import { CommandRegistration } from '../analysis-file-mode/analysisFileModeCommands';
import { AnalysisConfigurationStorage } from '../../../../../core/analysis/configuration/analysisConfigurationStorage';
import { getLogger } from '../../../../../platform/logging/sink';

const logger = getLogger('PROFILE_CONFIGURATION_COMMANDS');

interface StoredProfileItem {
    label: string;
    description: string;
    detail: string;
    profilePath: string;
}

export class ProfileConfigurationCommands {

    constructor(
        private context: vscode.ExtensionContext,
        private profileConfigurationSetting: ProfileConfigurationSetting
    ) {}

    /**
     * Get command registrations (don't register them yet)
     * This follows the "nested dolls" architecture pattern
     */
    static getCommandRegistrations(
        context: vscode.ExtensionContext, 
        profileConfigurationSetting: ProfileConfigurationSetting,
        refreshCallback: () => void
    ): CommandRegistration[] {
        logger.debug('Creating command registrations');
        const commands = new ProfileConfigurationCommands(context, profileConfigurationSetting);

        const registrations = [
            {
                commandId: 'codeXR.analysis.resetToDefaults',
                callback: async () => {
                    logger.debug(`Reset to defaults command TRIGGERED`);
                    await commands.resetToDefaults();
                    refreshCallback();
                },
                description: 'Reset analysis settings to default values'
            },
            {
                commandId: 'codeXR.analysis.saveProfile',
                callback: async () => {
                    logger.debug(`Save profile command TRIGGERED`);
                    await commands.saveProfile();
                    refreshCallback();
                },
                description: 'Save current configuration as a named profile'
            },
            {
                commandId: 'codeXR.analysis.loadProfile',
                callback: async () => {
                    logger.debug(`Load profile command TRIGGERED`);
                    await commands.loadProfile();
                    refreshCallback();
                },
                description: 'Load a previously saved configuration profile'
            },
            {
                commandId: 'codeXR.analysis.deleteProfile',
                callback: async () => {
                    logger.debug(`Delete profile command TRIGGERED`);
                    await commands.deleteProfile();
                    refreshCallback();
                },
                description: 'Delete a previously saved configuration profile'
            }
        ];

        logger.debug(() => `Created ${registrations.length} command registrations`);
        return registrations;
    }

    /**
     * Reset to default values
     */
    private async resetToDefaults(): Promise<void> {
        logger.debug('Resetting to default values');
        
        try {
            const shouldReset = await vscode.window.showWarningMessage(
                'This will reset all analysis settings to their default values. Are you sure?',
                'Reset to Defaults', 'Cancel'
            );

            if (shouldReset !== 'Reset to Defaults') {
                logger.debug('Reset cancelled by user');
                return;
            }

            // Use the profile configuration setting to reset
            await this.profileConfigurationSetting.resetToDefaults();
            
            logger.debug('Reset to defaults completed successfully');
            
        } catch (error) {
            logger.error('Error resetting to defaults:', error);
            void vscode.window.showErrorMessage(`Failed to reset to defaults: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Save current configuration as a profile
     */
    private async saveProfile(): Promise<void> {
        logger.debug('Saving profile');
        
        try {
            // Ask user for profile name
            const profileName = await vscode.window.showInputBox({
                prompt: 'Enter a name for this configuration profile',
                placeHolder: 'e.g., "My Custom Setup", "Project A Settings"',
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Profile name cannot be empty';
                    }
                    if (value.includes('/') || value.includes('\\') || value.includes(':')) {
                        return 'Profile name cannot contain special characters (/, \\, :)';
                    }
                    return null;
                }
            });

            if (!profileName) {
                logger.debug('Save profile cancelled - no name provided');
                return;
            }

            // Get current configuration from AnalysisConfigurationStorage
            const storage = AnalysisConfigurationStorage.getInstance(this.context);
            const currentConfig = await storage.loadConfiguration();
            
            logger.debug('Current config to save:', JSON.stringify(currentConfig, null, 2));
            
            // Save to globalStorage
            const profilesDir = path.join(this.context.globalStorageUri.fsPath, 'analysis_settings');
            
            // Create directory if it doesn't exist
            if (!fs.existsSync(profilesDir)) {
                fs.mkdirSync(profilesDir, { recursive: true });
            }

            const profilePath = path.join(profilesDir, `${profileName.trim()}.json`);
            
            // Check if profile already exists
            if (fs.existsSync(profilePath)) {
                const shouldOverwrite = await vscode.window.showWarningMessage(
                    `A profile named "${profileName}" already exists. Do you want to overwrite it?`,
                    'Overwrite', 'Cancel'
                );

                if (shouldOverwrite !== 'Overwrite') {
                    logger.debug('Save profile cancelled - user chose not to overwrite');
                    return;
                }
            }

            // Add metadata to the profile
            const profileData = {
                name: profileName.trim(),
                savedAt: new Date().toISOString(),
                version: '1.0',
                configuration: currentConfig
            };

            // Save the profile
            fs.writeFileSync(profilePath, JSON.stringify(profileData, null, 2));
            
            logger.debug(() => `Profile "${profileName}" saved successfully`);
            void vscode.window.showInformationMessage(`Configuration profile "${profileName}" saved successfully`);
            
        } catch (error) {
            logger.error('Error saving profile:', error);
            void vscode.window.showErrorMessage(`Failed to save profile: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Load a previously saved profile
     */
    private async loadProfile(): Promise<void> {
        logger.debug('Loading profile');
        
        try {
            const profileItems = this.listStoredProfiles();
            if (!profileItems) {
                return;
            }

            // Show profile selection
            const selectedProfile = await vscode.window.showQuickPick(profileItems, {
                placeHolder: 'Select a configuration profile to load',
                title: 'Load Configuration Profile'
            });

            if (!selectedProfile) {
                logger.debug('Load profile cancelled');
                return;
            }

            // Confirm loading
            const shouldLoad = await vscode.window.showWarningMessage(
                `This will replace your current configuration with "${selectedProfile.label}". Are you sure?`,
                'Load Profile', 'Cancel'
            );

            if (shouldLoad !== 'Load Profile') {
                logger.debug('Load profile cancelled by user');
                return;
            }

            // Load the profile
            const profileData = JSON.parse(fs.readFileSync(selectedProfile.profilePath, 'utf8'));
            
            logger.debug('Loaded profile data:', JSON.stringify(profileData.configuration, null, 2));
            
            // Update configuration using AnalysisConfigurationStorage
            const storage = AnalysisConfigurationStorage.getInstance(this.context);
            await storage.updateConfiguration(profileData.configuration);
            
            logger.debug(() => `Profile "${selectedProfile.label}" loaded successfully`);
            void vscode.window.showInformationMessage(`Configuration profile "${selectedProfile.label}" loaded successfully`);
            
        } catch (error) {
            logger.error('Error loading profile:', error);
            void vscode.window.showErrorMessage(`Failed to load profile: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Delete a saved profile
     */
    private async deleteProfile(): Promise<void> {
        logger.debug('Deleting profile');
        
        try {
            const profileItems = this.listStoredProfiles();
            if (!profileItems) {
                return;
            }

            // Show profile selection
            const selectedProfile = await vscode.window.showQuickPick(profileItems, {
                placeHolder: 'Select a configuration profile to delete',
                title: 'Delete Configuration Profile'
            });

            if (!selectedProfile) {
                logger.debug('Delete profile cancelled');
                return;
            }

            // Confirm deletion
            const shouldDelete = await vscode.window.showWarningMessage(
                `Are you sure you want to delete the profile "${selectedProfile.label}"? This action cannot be undone.`,
                'Delete Profile', 'Cancel'
            );

            if (shouldDelete !== 'Delete Profile') {
                logger.debug('Delete profile cancelled by user');
                return;
            }

            // Delete the profile
            fs.unlinkSync(selectedProfile.profilePath);
            
            logger.debug(() => `Profile "${selectedProfile.label}" deleted successfully`);
            void vscode.window.showInformationMessage(`Configuration profile "${selectedProfile.label}" deleted successfully`);
            
        } catch (error) {
            logger.error('Error deleting profile:', error);
            void vscode.window.showErrorMessage(`Failed to delete profile: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * The saved profiles as quick-pick items (a corrupt file is listed as
     * such), or undefined after telling the user there are none.
     */
    private listStoredProfiles(): StoredProfileItem[] | undefined {
        const profilesDir = path.join(this.context.globalStorageUri.fsPath, 'analysis_settings');

        // Check if profiles directory exists
        if (!fs.existsSync(profilesDir)) {
            void vscode.window.showInformationMessage('No saved profiles found');
            return undefined;
        }

        // Get list of saved profiles
        const profileFiles = fs.readdirSync(profilesDir).filter(file => file.endsWith('.json'));

        if (profileFiles.length === 0) {
            void vscode.window.showInformationMessage('No saved profiles found');
            return undefined;
        }

        // Create quick pick items
        return profileFiles.map(file => {
            const profilePath = path.join(profilesDir, file);
            try {
                const profileData = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
                const savedDate = new Date(profileData.savedAt).toLocaleString();
                return {
                    label: profileData.name || file.replace('.json', ''),
                    description: `Saved: ${savedDate}`,
                    detail: `Version: ${profileData.version || 'Unknown'}`,
                    profilePath: profilePath
                };
            } catch {
                return {
                    label: file.replace('.json', ''),
                    description: 'Invalid profile data',
                    detail: 'This profile may be corrupted',
                    profilePath: profilePath
                };
            }
        });
    }
}
