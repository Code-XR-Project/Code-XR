/**
 * What the file and directory chart-type settings share: the tree row and the
 * quick-pick flow. Each setting keeps its own storage reads, its chart list
 * and its save, which differ (see test/analysis/chartTypeSettings.test.cjs).
 */

import * as vscode from 'vscode';
import { CodeAnalysisTreeItem } from '../../../items/analysisItems';
import { ChartMetadata } from '../../../../../babia_templates/models/chartModels';
import { getLogger } from '../../../../../core/logging/sink';

const logger = getLogger('SHARED_CHART_TYPE_SETTING_CORE');

export interface ChartTypeInfo<Mode extends string = string> {
    id: string;
    name: string;
    description: string;
    category: string;
    supportsMode: Mode[];
}

export interface ChartTypeRowSpec {
    /** "Chart Type (File)" / "Chart Type (Directory)". */
    labelPrefix: string;
    commandId: string;
    commandTitle: string;
    contextValue: string;
}

export interface ChartTypeSelectionAdapter<Mode extends string> {
    /** Console prefix, e.g. CHART_TYPE_FILE. */
    logPrefix: string;
    quickPickPlaceHolder: string;
    quickPickTitle(mode: Mode): string;
    confirmation(chartName: string, mode: Mode): string;
    getCurrentAnalysisMode(): Promise<Mode>;
    getAvailableChartTypes(mode: Mode): Promise<ChartTypeInfo<Mode>[]>;
    setChartType(chartId: string): Promise<void>;
}

export function toChartTypeInfos<Mode extends string>(charts: ChartMetadata[], supportsMode: Mode[]): ChartTypeInfo<Mode>[] {
    return charts.map((chart) => ({
        id: chart.id,
        name: chart.name,
        description: chart.description,
        category: chart.category,
        supportsMode: [...supportsMode],
    }));
}

export function createChartTypeSettingItem(
    spec: ChartTypeRowSpec,
    chartName: string,
    mode: string,
    description: string,
): CodeAnalysisTreeItem {
    // Always use purple color for chart type icons as requested
    const iconPath = new vscode.ThemeIcon('graph', new vscode.ThemeColor('charts.purple'));

    return new CodeAnalysisTreeItem(
        `${spec.labelPrefix}: ${chartName}`,
        vscode.TreeItemCollapsibleState.None,
        'subsection',
        {
            command: spec.commandId,
            title: spec.commandTitle,
            arguments: []
        },
        iconPath,
        `Current chart type: ${chartName} for ${mode} mode. Click to change chart type.`,
        description,
        spec.contextValue
    );
}

export async function showChartTypeSelection<Mode extends string>(adapter: ChartTypeSelectionAdapter<Mode>): Promise<void> {
    const prefix = adapter.logPrefix;
    logger.debug(() => `${prefix}: Opening chart type selection dialog`);

    try {
        const currentMode = await adapter.getCurrentAnalysisMode();
        const availableCharts = await adapter.getAvailableChartTypes(currentMode);

        if (availableCharts.length === 0) {
            logger.error(`${prefix}: No chart types found`);
            void vscode.window.showErrorMessage('No chart templates available');
            return;
        }

        const quickPickItems: (vscode.QuickPickItem & { chart: ChartTypeInfo<Mode> })[] = availableCharts.map(chart => ({
            label: chart.name,
            description: chart.description,
            detail: `Category: ${chart.category} | Supports: ${chart.supportsMode.join(', ')}`,
            chart: chart
        }));

        const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
            placeHolder: adapter.quickPickPlaceHolder,
            title: adapter.quickPickTitle(currentMode),
            canPickMany: false
        });

        if (selectedItem && selectedItem.chart) {
            const selectedChart = selectedItem.chart;
            await adapter.setChartType(selectedChart.id);

            logger.debug(() => `${prefix}: Chart type selected: ${selectedChart.name} (${selectedChart.id})`);
            void vscode.window.showInformationMessage(adapter.confirmation(selectedChart.name, currentMode));
        } else {
            logger.debug(() => `${prefix}: Chart type selection cancelled`);
        }
    } catch (error) {
        logger.error(`${prefix}: Error in chart type selection:`, error);
        void vscode.window.showErrorMessage(`Failed to select chart type: ${error instanceof Error ? error.message : String(error)}`);
    }
}
