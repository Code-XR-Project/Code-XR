import { DimensionMapping } from '../chartModels';
import { chartTemplates } from '../templateCharts';
import { getVisualizationConfiguration, TemplateVisualizationSettings } from '../getVisualizationConfiguration';
import { CreateChart } from './placeholders/createChart';
import { CreateStructure } from './placeholders/createStructure';
import { XRFieldTypeMap, XRSchemaTargetType } from '../xrFieldModels';
import { buildMappingUiSchema } from './mappingUiSchema';
import * as fs from 'fs';
import { getLogger } from '../../../platform/logging/sink';
import { resolveTemplatePath } from '../../../platform/templatePaths';
import type { CoreContext } from '../../host/hostPaths';

const logger = getLogger('TEMPLATE_PROCESSOR');

interface XRVisualizationGenerationOptions {
    babiaUiVisibleByDefault?: boolean;
    xrTargetType?: XRSchemaTargetType;
    fieldTypeMap?: XRFieldTypeMap;
}

/**
 * BabiaXR Template Processor - Modular Architecture
 * Streamlined processor using CreateChart and CreateStructure modules
 * Combines chart entities with structural elements for complete XR visualization
 */
export class TemplateProcessor {

    /**
     * Main method to generate complete XR visualization index.html
     * Uses both CreateChart and CreateStructure modules for modular processing
     */
    public static async generateXRVisualization(
        chartId: string,
        mappings: DimensionMapping[],
        title: string,
        dataSource: string,
        context: CoreContext,
        outputPath: string,
        analysisData?: any[], // Add optional analysis data to detect type
        options?: XRVisualizationGenerationOptions,
    ): Promise<{ success: boolean; error?: string }> {
        try {
            logger.debug('Starting modular XR visualization generation');
            logger.debug('Chart ID:', chartId);
            logger.debug('Mappings:', mappings);
            logger.debug('Title:', title);
            logger.debug('Data source:', dataSource);

            // Get visualization settings
            const visualizationSettings = await this.getVisualizationSettings();
            logger.debug('Using visualization settings:', visualizationSettings);

            // Detect if this is directory analysis by checking the data structure
            const isDirectoryAnalysis = this.detectDirectoryAnalysis(analysisData);
            logger.debug('Detected directory analysis:', isDirectoryAnalysis);

            // Create chart entity using CreateChart module
            const chartResult = CreateChart.createChartEntity(
                chartId,
                mappings,
                title,
                visualizationSettings.palette
            );

            if (!chartResult.success) {
                return { 
                    success: false, 
                    error: `Chart creation failed: ${chartResult.error}` 
                };
            }

            const chartEntityId = this.extractChartEntityId(chartResult.chartHtml || '');

            // Create structural placeholders using CreateStructure module
            const structureResult = CreateStructure.createStructuralPlaceholders(
                title,
                dataSource,
                visualizationSettings,
                'xr', // Analysis type for XR visualization
                context,
                chartId, // Pass chart type for tree builder decision
                isDirectoryAnalysis // Pass directory analysis flag
            );

            if (!structureResult.success) {
                return { 
                    success: false, 
                    error: `Structure creation failed: ${structureResult.error}` 
                };
            }

            const babiaUiResult = this.buildBabiaUiPlaceholders(
                chartId,
                chartEntityId,
                mappings,
                title,
                isDirectoryAnalysis,
                options,
            );
            structureResult.placeholders!.set('BABIA_UI_COMPONENT', babiaUiResult.componentHtml);
            structureResult.placeholders!.set('BABIA_UI_SCRIPT', babiaUiResult.scriptHtml);

            // Load XR base template
            const xrTemplate = await this.loadXRTemplate(context);
            if (!xrTemplate) {
                return { success: false, error: 'Failed to load XR template' };
            }

            // First, replace chart component placeholder
            let templateWithChart = xrTemplate.replace(
                /\$\{CHART_COMPONENT\}|\{\{\s*CHART_COMPONENT\s*\}\}/g,
                chartResult.chartHtml || ''
            );

            // Then replace all structural placeholders
            let finalHtml = CreateStructure.replaceStructuralPlaceholders(
                templateWithChart, 
                structureResult.placeholders!
            );

            // Special replacement for the SSE script tag in case it wasn't replaced
            const nonce = structureResult.placeholders!.get('nonce') || structureResult.placeholders!.get('NONCE');
            if (nonce) {
                finalHtml = finalHtml.replace(
                    /<script nonce="\$\{nonce\}" src="\$\{scriptUri\}"><\/script>/g,
                    `<script nonce="${nonce}" src="./main.js"></script>`
                );
            }

            // Write the final HTML file
            fs.writeFileSync(outputPath, finalHtml, 'utf8');
            logger.debug('Generated modular XR visualization HTML at:', outputPath);

            return { success: true };

        } catch (error) {
            logger.error('Error generating XR visualization:', error);
            return { 
                success: false, 
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Get visualization settings (palette, environment, colors)
     */
    private static async getVisualizationSettings(): Promise<TemplateVisualizationSettings> {
        return await getVisualizationConfiguration();
    }

    /**
     * Load XR base template from templates/xr/file/xr-visualization.html
     */
    private static async loadXRTemplate(context: CoreContext): Promise<string | null> {
        try {
            const templatePath = resolveTemplatePath(context.extensionPath, 'xr', 'file', 'xr-visualization.html');

            if (!fs.existsSync(templatePath)) {
                logger.error('XR template not found at:', templatePath);
                return null;
            }

            const template = fs.readFileSync(templatePath, 'utf8');
            logger.debug('Loaded XR template from:', templatePath);
            return template;

        } catch (error) {
            logger.error('Error loading XR template:', error);
            return null;
        }
    }

    /**
     * Get available charts (delegated to CreateChart)
     */
    public static getAvailableCharts() {
        return CreateChart.getAvailableCharts();
    }

    /**
     * Create default XR analysis mappings (delegated to CreateChart)
     */
    public static createDefaultXRMappings(): DimensionMapping[] {
        return CreateChart.createDefaultXRMappings();
    }

    /**
     * Create structural placeholders for any analysis type (delegated to CreateStructure)
     */
    public static async createStructuralPlaceholders(
        title: string,
        dataSource: string,
        analysisType: 'xr' | 'dom' | 'none',
        context: CoreContext,
        chartType?: string,
        isDirectoryAnalysis?: boolean
    ) {
        const visualizationSettings = await this.getVisualizationSettings();
        return CreateStructure.createStructuralPlaceholders(
            title,
            dataSource,
            visualizationSettings,
            analysisType,
            context,
            chartType,
            isDirectoryAnalysis
        );
    }

    /**
     * Detect if this is a directory analysis by examining the data structure
     * Directory analysis has 'fileName' field, file analysis has 'functionName' field
     */
    private static detectDirectoryAnalysis(analysisData?: any[]): boolean {
        if (!analysisData || !Array.isArray(analysisData) || analysisData.length === 0) {
            return false;
        }

        // Check the first item in the data to determine the type
        const firstItem = analysisData[0];
        if (firstItem && typeof firstItem === 'object') {
            // Directory analysis has 'fileName' field, file analysis has 'functionName' field
            const hasFileName = 'fileName' in firstItem;
            const hasFunctionName = 'functionName' in firstItem;
            
            logger.debug('Data structure detection:', {
                hasFileName,
                hasFunctionName,
                keys: Object.keys(firstItem)
            });
            
            return hasFileName && !hasFunctionName;
        }

        return false;
    }

    private static extractChartEntityId(chartHtml: string): string | undefined {
        const idMatch = chartHtml.match(/id="([^"]+)"/i);
        return idMatch?.[1];
    }

    private static buildBabiaUiPlaceholders(
        chartId: string,
        chartEntityId: string | undefined,
        mappings: DimensionMapping[],
        analysisTitle: string,
        isDirectoryAnalysis: boolean,
        options?: XRVisualizationGenerationOptions,
    ): { componentHtml: string; scriptHtml: string } {
        const chartMetadata = chartTemplates.find((chart) => chart.id === chartId);
        if (!chartMetadata || !chartEntityId || !options?.fieldTypeMap) {
            return { componentHtml: '', scriptHtml: '' };
        }

        const selectedFieldByDimension: Record<string, string> = {};
        for (const mapping of mappings) {
            if (mapping.dataField) {
                selectedFieldByDimension[mapping.dimension] = mapping.dataField;
            }
        }
        const schema = buildMappingUiSchema(chartId, selectedFieldByDimension, isDirectoryAnalysis, options.fieldTypeMap);
        if (!schema) {
            return { componentHtml: '', scriptHtml: '' };
        }
        const { availableCharts, dimensionsByChart, defaultMappingsByChart, dimensions } = schema;

        const targetType: XRSchemaTargetType = options.xrTargetType ?? (isDirectoryAnalysis ? 'directory' : 'file');
        const panelVisibleByDefault = options?.babiaUiVisibleByDefault !== false;

        const model = {
            chartId,
            chartEntityId,
            chartEntityIds: chartEntityId ? [chartEntityId] : [],
            analysisTitle,
            normalSurfaceId: 'codexrAnalysisSurface',
            normalRootId: 'codexrNormalAnalysisRoot',
            normalEntityIds: ['codexrNormalAnalysisRoot'],
            normalDataEntityIds: ['data'],
            targetType,
            panelId: 'codexrMappingUiPanel',
            toggleId: 'codexrMappingUiToggle',
            sceneSelector: '#scene',
            panelPosition: '3.35 1.24 -15.78',
            panelRotation: '-28 -138 0',
            panelScale: 0.165,
            panelVisible: panelVisibleByDefault,
            hideOnEnterAr: false,
            adaptiveCorner: MAPPING_UI_ADAPTIVE_CORNER,
            togglePosition: targetType === 'directory' ? '6.8 1.1 -5.6' : '6.2 1 -7.5',
            dimensions,
            availableCharts,
            dimensionsByChart,
            defaultMappingsByChart,
        };
        const serializedModel = JSON.stringify(model).replace(/<\//g, '<\\/');

        const scriptHtml = `<script id="codexr-tooling-config-xr-mapping-ui" type="application/json">${serializedModel}</script>`;

        return { componentHtml: '', scriptHtml };
    }
}

/** Where the mapping panel docks next to the analysis table, and how it switches corners. */
const MAPPING_UI_ADAPTIVE_CORNER = {
    table: { anchorX: 0, anchorY: 1.24, anchorZ: -18, width: 5.614, depth: 3.218 },
    marginX: 0.62,
    marginZ: 0.52,
    panelLift: 0.0,
    panelForwardOffset: 0.16,
    switchThreshold: 0.35,
    switchCooldownMs: 480,
};
