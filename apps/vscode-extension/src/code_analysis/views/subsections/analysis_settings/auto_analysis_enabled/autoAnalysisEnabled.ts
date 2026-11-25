/**
 * Auto-Analysis Enabled Setting Item
 * Manages the auto-analysis enabled/disabled configuration
 */

import * as vscode from 'vscode';
import { CodeAnalysisTreeItem } from '../../../items/analysisItems';
import { AnalysisConfigurationStorage } from '../../../../../core/analysis/configuration/analysisConfigurationStorage';
import { getLogger } from '../../../../../platform/logging/sink';

const logger = getLogger('ANALYSIS');

export class AutoAnalysisEnabledSetting {
    private currentEnabled: boolean = true; // Default enabled
    private storage: AnalysisConfigurationStorage;

    constructor(context: vscode.ExtensionContext) {
        logger.debug('Initializing Auto-Analysis Enabled setting');
        this.storage = AnalysisConfigurationStorage.getInstance(context);
        void this.loadSavedState();
    }

    /**
     * Get the tree item for this setting
     */
    async getSettingItem(): Promise<CodeAnalysisTreeItem> {
        // Always get the current value from storage to ensure it's up to date
        const currentState = await this.storage.getAutoAnalysisEnabled();
        const stateText = currentState ? 'Enabled' : 'Disabled';
        const iconPath = this.getStateIcon(currentState);

        const label = `Auto-Analysis: ${stateText}`;

        return new CodeAnalysisTreeItem(
            label,
            vscode.TreeItemCollapsibleState.None,
            'analysis-result',
            {
                command: 'codeXR.analysis.toggleAutoAnalysisEnabled',
                title: 'Toggle Auto-Analysis',
                arguments: []
            },
            iconPath,
            `Click to ${currentState ? 'disable' : 'enable'} auto-analysis (watchers and debounce time). Current: ${stateText}`,
            stateText,
            'autoAnalysisEnabledSetting'
        );
    }

    /**
     * Get appropriate icon for current state
     */
    private getStateIcon(enabled: boolean): vscode.ThemeIcon {
        if (enabled) {
            return new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green'));
        } else {
            return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.orange'));
        }
    }

    /**
     * Toggle auto-analysis enabled state
     */
    async toggleEnabled(): Promise<boolean> {
        const newState = !this.currentEnabled;
        await this.setEnabled(newState);
        return newState;
    }

    /**
     * Set specific auto-analysis enabled state
     */
    async setEnabled(enabled: boolean): Promise<void> {
        this.currentEnabled = enabled;
        await this.saveStateToSettings();
        
        const message = enabled ? 
            'Auto-Analysis enabled - watchers and debounce time are now active' : 
            'Auto-Analysis disabled - watchers and debounce time are paused';
        
        void vscode.window.showInformationMessage(message);
    }

    /**
     * Get current enabled state
     */
    getCurrentState(): boolean {
        return this.currentEnabled;
    }

    /**
     * Check if auto-analysis is enabled
     */
    async isEnabled(): Promise<boolean> {
        return await this.storage.getAutoAnalysisEnabled();
    }

    /**
     * Load saved state from storage
     */
    private async loadSavedState(): Promise<void> {
        try {
            const savedState = await this.storage.getAutoAnalysisEnabled();
            this.currentEnabled = savedState;
            logger.debug(() => `Loaded auto-analysis enabled state from storage: ${this.currentEnabled}`);
        } catch (error) {
            logger.error('Error loading saved state, using default:', error);
            this.currentEnabled = true; // Fallback to default (enabled)
        }
    }

    /**
     * Save state to storage
     */
    private async saveStateToSettings(): Promise<void> {
        try {
            await this.storage.setAutoAnalysisEnabled(this.currentEnabled);
            logger.debug(() => `Saved auto-analysis enabled state to storage: ${this.currentEnabled}`);
        } catch (error) {
            logger.error('Error saving state to storage:', error);
        }
    }
}

