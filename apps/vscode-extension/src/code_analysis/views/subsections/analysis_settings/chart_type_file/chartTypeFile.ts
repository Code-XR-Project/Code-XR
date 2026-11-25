/**
 * Chart Type File Setting Item
 * Manages the chart type configuration for file analysis
 */

import * as vscode from 'vscode';
import { CodeAnalysisTreeItem } from '../../../items/analysisItems';
import { AnalysisConfigurationStorage } from '../../../../../core/analysis/configuration/analysisConfigurationStorage';
import type { ChartType, AnalysisFileMode as AnalysisMode } from '../../../../../core/analysis/configuration/analysisConfiguration';
import { BabiaChartRegistry } from '../../../../../core/charts/chartRegistry';
import {
    ChartTypeInfo as SharedChartTypeInfo,
    createChartTypeSettingItem,
    showChartTypeSelection,
    toChartTypeInfos,
} from '../chart_type_shared/sharedChartTypeSettingCore';
import { getLogger } from '../../../../../platform/logging/sink';

const logger = getLogger('CHART_TYPE_FILE');

export type { AnalysisMode, ChartType };
export type ChartTypeInfo = SharedChartTypeInfo<AnalysisMode>;

export class ChartTypeFileSetting {
    private storage: AnalysisConfigurationStorage;
    private chartRegistry: BabiaChartRegistry;

    constructor(context: vscode.ExtensionContext) {
        this.storage = AnalysisConfigurationStorage.getInstance(context);
        this.chartRegistry = BabiaChartRegistry.getInstance();
    }

    /**
     * Get the tree item for this setting
     */
    async getSettingItem(): Promise<CodeAnalysisTreeItem> {
        // Get current values from storage
        const currentMode = await this.storage.getAnalysisMode();
        const currentChartType = await this.storage.getChartTypeFile();

        // Get chart metadata for better display
        const chartMetadata = this.chartRegistry.getChart(currentChartType);
        const chartName = chartMetadata ? chartMetadata.name : currentChartType;

        return createChartTypeSettingItem(
            {
                labelPrefix: 'Chart Type (File)',
                commandId: 'codeXR.analysis.selectChartTypeFile',
                commandTitle: 'Select Chart Type for File Analysis',
                contextValue: 'chartTypeFileSetting',
            },
            chartName,
            currentMode,
            `${chartName} for XR mode`,
        );
    }

    /**
     * Get current analysis mode
     */
    async getCurrentAnalysisMode(): Promise<AnalysisMode> {
        return this.storage.getAnalysisMode();
    }

    /**
     * Get available chart types based on analysis mode
     */
    async getAvailableChartTypes(mode: AnalysisMode): Promise<ChartTypeInfo[]> {
        logger.debug(() => `Getting available charts for mode: ${mode}`);

        // All charts support both modes
        const chartTypeInfos = toChartTypeInfos<AnalysisMode>(this.chartRegistry.getAllCharts(), ['XR', 'LivePanel']);

        logger.debug(() => `Found ${chartTypeInfos.length} available charts`);
        return chartTypeInfos;
    }

    /**
     * Show chart type selection dialog
     */
    async showChartTypeSelection(): Promise<void> {
        return showChartTypeSelection<AnalysisMode>({
            logPrefix: 'CHART_TYPE_FILE',
            quickPickPlaceHolder: 'Select a chart type for file analysis visualization',
            quickPickTitle: (mode) => `Chart Type Selection for ${mode} Analysis`,
            confirmation: (chartName, mode) => `Chart type set to: ${chartName} for ${mode} mode`,
            getCurrentAnalysisMode: () => this.getCurrentAnalysisMode(),
            getAvailableChartTypes: (mode) => this.getAvailableChartTypes(mode),
            setChartType: (chartId) => this.setChartType(chartId),
        });
    }

    /**
     * Set chart type and intelligently clean dimension mappings
     */
    async setChartType(chartType: string): Promise<void> {
        logger.debug(() => `Setting chart type to: ${chartType}`);

        // Validate chart type exists
        if (!this.chartRegistry.hasChart(chartType)) {
            throw new Error(`Invalid chart type: ${chartType}`);
        }

        // Get current dimension mappings before changing chart type
        const currentMappings = await this.storage.getDimensionMappingFile();
        logger.debug(`[DIMENSION_CLEANER] Current mappings before chart change:`, currentMappings);

        // Save the new chart type
        const validChartType = chartType as ChartType;
        await this.storage.setChartTypeFile(validChartType);
        logger.debug(() => `Chart type saved successfully: ${chartType}`);

        // Clear all dimension mappings when chart type changes
        await this.storage.setDimensionMappingFile({});
        logger.debug(() => `Dimension mappings cleared for new chart type: ${chartType}`);
    }

    /**
     * Get current chart type
     */
    async getCurrentChartType(): Promise<ChartType> {
        return this.storage.getChartTypeFile();
    }
}
