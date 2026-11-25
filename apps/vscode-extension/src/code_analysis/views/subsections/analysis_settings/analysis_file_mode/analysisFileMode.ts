/**
 * Analysis File Setting Item
 * Manages the analysis file mode (XR/LivePanel) configuration
 */

import * as vscode from 'vscode';
import { CodeAnalysisTreeItem } from '../../../items/analysisItems';
import { AnalysisConfigurationStorage } from '../../../../../core/analysis/configuration/analysisConfigurationStorage';
import { AnalysisFileMode } from '../../../../../core/analysis/configuration/analysisConfiguration';
import { getLogger } from '../../../../../platform/logging/sink';

const logger = getLogger('ANALYSIS');

export { AnalysisFileMode } from '../../../../../core/analysis/configuration/analysisConfiguration';

export class AnalysisFileSetting {
    private currentMode: AnalysisFileMode = 'XR'; // Default mode (will be loaded from storage)
    private storage: AnalysisConfigurationStorage;

    constructor(context: vscode.ExtensionContext) {
        logger.debug('Initializing Analysis File setting');
        this.storage = AnalysisConfigurationStorage.getInstance(context);
        void this.loadSavedMode();
    }

    /**
     * Get the tree item for this setting
     */
    async getSettingItem(): Promise<CodeAnalysisTreeItem> {
        // Always get the current value from storage to ensure it's up to date
        const currentMode = await this.storage.getAnalysisFileMode();
        
        const modeText = currentMode === 'XR' 
            ? 'Analysis File with Immersive VR/AR'
            : 'Analysis File with Standard Experience';
        const iconPath = currentMode === 'LivePanel' 
            ? new vscode.ThemeIcon('file-code', new vscode.ThemeColor('charts.green'))
            : new vscode.ThemeIcon('vr', new vscode.ThemeColor('charts.purple'));

        return new CodeAnalysisTreeItem(
            modeText,
            vscode.TreeItemCollapsibleState.None,
            'analysis-result',
            {
                command: 'codeXR.analysis.toggleAnalysisFileMode',
                title: 'Toggle Analysis File Mode',
                arguments: []
            },
            iconPath,
            `Click to switch between analysis modes. Current: ${currentMode === 'XR' ? 'Immersive VR/AR experience for detailed analysis' : 'Standard panel for quick review'}`,
            currentMode,
            'analysisFileModeSetting'
        );
    }

    /**
     * Toggle between XR and LivePanel modes
     */
    async toggleMode(): Promise<AnalysisFileMode> {
        this.currentMode = this.currentMode === 'XR' ? 'LivePanel' : 'XR';
        logger.debug(() => `Analysis file mode switched to ${this.currentMode}`);
        
        await this.saveModeToSettings();
        
        return this.currentMode;
    }

    /**
     * Get current mode
     */
    getCurrentMode(): AnalysisFileMode {
        return this.currentMode;
    }

    /**
     * Set specific mode
     */
    async setMode(mode: AnalysisFileMode): Promise<void> {
        this.currentMode = mode;
        await this.saveModeToSettings();
    }

    /**
     * Load saved mode from globalStorage
     */
    private async loadSavedMode(): Promise<void> {
        try {
            const savedMode = await this.storage.getAnalysisFileMode();
            this.currentMode = savedMode;
            logger.debug(() => `Loaded analysis file mode from storage: ${this.currentMode}`);
        } catch (error) {
            logger.error('Error loading saved mode, using default:', error);
            this.currentMode = 'XR'; // Fallback to default
        }
    }

    /**
     * Save mode to globalStorage
     */
    private async saveModeToSettings(): Promise<void> {
        try {
            await this.storage.setAnalysisFileMode(this.currentMode);
            logger.debug(() => `Saved analysis file mode to storage: ${this.currentMode}`);
        } catch (error) {
            logger.error('Error saving mode to storage:', error);
        }
    }
}

