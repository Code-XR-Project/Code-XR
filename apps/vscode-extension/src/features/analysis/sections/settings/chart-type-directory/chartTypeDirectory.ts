/**
 * Chart Type Directory Setting Item
 * Manages the chart type configuration for directory analysis
 */

import * as vscode from 'vscode';
import { CodeAnalysisTreeItem } from '../../../views/analysisItems';
import { AnalysisConfigurationStorage } from '../../../../../core/analysis/configuration/analysisConfigurationStorage';
import type { ChartType, AnalysisDirectoryMode as AnalysisMode } from '../../../../../core/analysis/configuration/analysisConfiguration';
import { BabiaChartRegistry } from '../../../../../core/charts/chartRegistry';
import {
    ChartTypeInfo as SharedChartTypeInfo,
    createChartTypeSettingItem,
    showChartTypeSelection,
    toChartTypeInfos,
} from '../sharedChartTypeSettingCore';
import { getLogger } from '../../../../../platform/logging/sink';

const logger = getLogger('CHART_TYPE_DIRECTORY');

export type { AnalysisMode, ChartType };
export type ChartTypeInfo = SharedChartTypeInfo<AnalysisMode>;

const DIRECTORY_MODES: AnalysisMode[] = ['XR', 'XRDeep', 'LivePanel', 'LivePanelDeep'];

export class ChartTypeDirectorySetting {
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
        const currentChartType = await this.getCurrentChartType();
        const currentMode = await this.getCurrentAnalysisMode();

        // Get chart metadata
        const chartMetadata = this.chartRegistry.getChart(currentChartType);
        const chartName = chartMetadata ? chartMetadata.name : 'Unknown Chart';

        return createChartTypeSettingItem(
            {
                labelPrefix: 'Chart Type (Directory)',
                commandId: 'codeXR.analysis.selectChartTypeDirectory',
                commandTitle: 'Select Chart Type for Directory Analysis',
                contextValue: 'chartTypeDirectorySetting',
            },
            chartName,
            currentMode,
            `${currentMode} Mode`,
        );
    }

    /**
     * Get current chart type for directory analysis
     */
    async getCurrentChartType(): Promise<ChartType> {
        return await this.storage.getDirectoryChartType();
    }

    /**
     * Set chart type for current mode
     */
    async setChartType(chartType: ChartType): Promise<void> {
        await this.storage.setDirectoryChartType(chartType);
        logger.debug(() => `Set chart type: ${chartType}`);

        // Clear all dimension mappings when chart type changes
        await this.storage.setDimensionMappingDirectory({});
        logger.debug(() => `Dimension mappings cleared for new chart type: ${chartType}`);
    }

    /**
     * Get current analysis mode (directory mode)
     */
    private async getCurrentAnalysisMode(): Promise<AnalysisMode> {
        return await this.storage.getAnalysisDirectoryMode();
    }

    /**
     * Get available chart types for the given mode
     */
    async getAvailableChartTypes(mode: AnalysisMode): Promise<ChartTypeInfo[]> {
        // All charts support all modes for directories
        return toChartTypeInfos(this.chartRegistry.getAllCharts(), DIRECTORY_MODES)
            .filter(chart => chart.supportsMode.includes(mode));
    }

    /**
     * Show chart type selection dialog
     */
    async showChartTypeSelection(): Promise<void> {
        return showChartTypeSelection<AnalysisMode>({
            logPrefix: 'CHART_TYPE_DIRECTORY',
            quickPickPlaceHolder: 'Select a chart type for directory analysis visualization',
            quickPickTitle: (mode) => `Chart Type Selection for ${mode} Directory Analysis`,
            confirmation: (chartName, mode) => `Chart type set to: ${chartName} for ${mode} directory analysis`,
            getCurrentAnalysisMode: () => this.getCurrentAnalysisMode(),
            getAvailableChartTypes: (mode) => this.getAvailableChartTypes(mode),
            setChartType: (chartId) => this.setChartType(chartId as ChartType),
        });
    }
}
