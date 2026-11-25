import { ChartMetadata, DimensionDataType, DimensionMapping, DimensionValueRule } from '../models/chartModels';
import { chartTemplates } from '../charts/templateCharts';
import { getVisualizationConfiguration, VisualizationSettings } from '../../utils/getVisualizationConfiguration';
import { CreateChart } from './placeholders/createChart';
import { CreateStructure } from './placeholders/createStructure';
import { XRFieldTypeMap, XRSchemaTargetType } from '../../code_analysis/services/xrFieldSchemaService';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { getLogger } from '../../core/logging/sink';
import { resolveTemplatePath } from '../../platform/templatePaths';

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
        context: vscode.ExtensionContext,
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
    private static async getVisualizationSettings(): Promise<VisualizationSettings> {
        return await getVisualizationConfiguration();
    }

    /**
     * Load XR base template from templates/xr/file/xr-visualization.html
     */
    private static async loadXRTemplate(context: vscode.ExtensionContext): Promise<string | null> {
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
        context: vscode.ExtensionContext,
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

        const pools = buildSchemaFieldPools(options.fieldTypeMap);

        const selectedFieldByDimension = new Map<string, string>();
        for (const mapping of mappings) {
            if (mapping.dataField) {
                selectedFieldByDimension.set(mapping.dimension, mapping.dataField);
            }
        }

        const { availableCharts, dimensionsByChart, defaultMappingsByChart } = buildChartCatalog(chartId, selectedFieldByDimension, isDirectoryAnalysis, pools);
        const dimensions = buildDimensionsForChart(chartMetadata, selectedFieldByDimension, pools);

        if (dimensions.length === 0) {
            return { componentHtml: '', scriptHtml: '' };
        }

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

// ---- The in-scene mapping UI model: pure helpers behind buildBabiaUiPlaceholders.

/** One dimension row of the mapping UI: its candidate fields, the current one first. */
interface MappingUiDimension {
    id: string;
    label: string;
    dataType: DimensionDataType;
    valueRule?: DimensionValueRule;
    currentField: string;
    fields: string[];
    hidden: boolean;
}

/** The analysis schema's field names, grouped by the dimension data type they can fill. */
interface SchemaFieldPools {
    numericFields: string[];
    textFields: string[];
    anyFields: string[];
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

/** Preferred default fields per dimension, directory-analysis schema (XR_DIRECTORY_FIELDS). */
const DIRECTORY_PREFERRED_FIELDS: Record<string, string[]> = {
    area: ['functionCount', 'totalFunctions', 'fileCount', 'codeLines', 'totalLines'],
    height: ['totalLines', 'codeLines', 'functionCount', 'cyclomaticComplexityNumber'],
    color: ['cyclomaticComplexityNumber', 'language', 'fileName', 'relativePath'],
    x_axis: ['fileName', 'relativePath', 'language'],
    y_axis: ['totalLines', 'codeLines', 'functionCount'],
    // z prefers a LOW-cardinality category: babia allots every
    // distinct z label its own grid row, and 40+ rows of
    // near-empty depth shrank the map charts to nothing.
    z_axis: ['language', 'cyclomaticComplexityNumber', 'functionCount'],
    // Radius prefers average complexity: per-file counts are
    // Zipf-distributed (one vendored file dwarfs the rest) and
    // babia maps radius linearly, so count-based radii render
    // every typical file as an invisible speck.
    radius: ['cyclomaticComplexityNumber', 'functionCount', 'totalLines'],
    size: ['functionCount', 'totalLines', 'fileSizeBytes'],
    heightmap: ['totalLines', 'codeLines', 'functionCount'],
    key: ['fileName', 'relativePath', 'language'],
    value: ['totalLines', 'functionCount', 'codeLines'],
};

/**
 * Preferred default fields per dimension, field-analysis schema
 * (XR_FILE_FIELDS): text fields are functionName/complexityBand/filePath/
 * fileName/treePath and numerics lineCount/complexity/parameters/… — the old
 * list named fields that do not exist there (`name`, `longName`,
 * `codeLines`), so defaults silently fell back to whatever came first in the
 * pool.
 */
const FILE_PREFERRED_FIELDS: Record<string, string[]> = {
    area: ['parameters', 'lineCount', 'complexity'],
    height: ['lineCount', 'spanLines', 'complexity'],
    color: ['complexity', 'complexityBand', 'functionName'],
    x_axis: ['functionName', 'fileName', 'complexityBand'],
    y_axis: ['lineCount', 'spanLines', 'complexity'],
    z_axis: ['complexityBand', 'complexity', 'parameters'],
    radius: ['parameters', 'lineCount', 'complexity'],
    size: ['lineCount', 'parameters', 'complexity'],
    heightmap: ['lineCount', 'spanLines', 'complexity'],
    key: ['functionName', 'fileName'],
    value: ['lineCount', 'complexity', 'parameters'],
};

function buildSchemaFieldPools(fieldTypeMap: XRFieldTypeMap): SchemaFieldPools {
    const schemaFieldEntries = Object.entries(fieldTypeMap);
    return {
        numericFields: schemaFieldEntries.filter(([, fieldType]) => fieldType === 'numeric').map(([fieldName]) => fieldName),
        textFields: schemaFieldEntries.filter(([, fieldType]) => fieldType === 'text').map(([fieldName]) => fieldName),
        anyFields: schemaFieldEntries.map(([fieldName]) => fieldName),
    };
}

// Candidates for a dimension: its own data type first, every field as the
// fallback. Dropping a dimension when its strict pool is empty published
// an INCOMPLETE contract (e.g. barsmap without z_axis) while still
// offering the chart — Babia then built axes with non-finite lengths and
// the table reported "invalid axis". Every declared dimension always gets
// a candidate list now; the best available field beats no field at all.
function candidateFieldsFor(dataType: DimensionDataType, pools: SchemaFieldPools): string[] {
    const { numericFields, textFields, anyFields } = pools;
    const strictFields = dataType === 'numeric'
        ? numericFields
        : (dataType === 'text' ? textFields : anyFields);
    return strictFields.length > 0 ? strictFields : anyFields;
}

function buildDimensionsForChart(chart: ChartMetadata, selectedFields: Map<string, string>, pools: SchemaFieldPools): MappingUiDimension[] {
    const result: MappingUiDimension[] = [];
    for (const dimension of chart.dimensions) {
        const candidateFields = candidateFieldsFor(dimension.dataType, pools);
        if (candidateFields.length === 0) {
            continue;
        }

        const selectedField = selectedFields.get(dimension.name);
        const orderedFields = selectedField && candidateFields.includes(selectedField)
            ? [selectedField, ...candidateFields.filter((fieldName) => fieldName !== selectedField)]
            : candidateFields;

        result.push({
            id: dimension.name,
            label: dimension.label,
            dataType: dimension.dataType,
            valueRule: dimension.valueRule,
            currentField: orderedFields[0],
            fields: orderedFields,
            hidden: false,
        });
    }
    return result;
}

function pickDefaultField(dimensionName: string, dimensionDataType: DimensionDataType, preferredFields: string[], pools: SchemaFieldPools): string {
    const candidateFields = candidateFieldsFor(dimensionDataType, pools);
    for (const preferredField of preferredFields) {
        if (candidateFields.includes(preferredField)) {
            return preferredField;
        }
    }
    if (candidateFields.includes(dimensionName)) {
        return dimensionName;
    }
    return candidateFields[0] ?? '';
}

function getDefaultMappingsForChart(chart: ChartMetadata, isDirectoryAnalysis: boolean, pools: SchemaFieldPools): Record<string, string> {
    const preferredByDimension = isDirectoryAnalysis ? DIRECTORY_PREFERRED_FIELDS : FILE_PREFERRED_FIELDS;
    const defaults: Record<string, string> = {};
    for (const dimension of chart.dimensions) {
        const field = pickDefaultField(
            dimension.name,
            dimension.dataType,
            preferredByDimension[dimension.name] ?? [dimension.name],
            pools,
        );
        // Every declared dimension gets a key: an omitted one reached
        // Babia as a missing axis, which is the "invalid axis" failure.
        // `field` is only empty when the analysis has no fields at all.
        if (field) {
            defaults[dimension.name] = field;
        }
    }
    return defaults;
}

/**
 * The chart switcher's catalogue: every chart that can be filled from this
 * schema, with its dimensions and default mappings. The current chart's
 * defaults are overlaid with the user's own mappings.
 */
function buildChartCatalog(chartId: string, selectedFieldByDimension: Map<string, string>, isDirectoryAnalysis: boolean, pools: SchemaFieldPools) {
    const dimensionsByChart: Record<string, MappingUiDimension[]> = {};
    const defaultMappingsByChart: Record<string, Record<string, string>> = {};
    const availableCharts = chartTemplates.map((chart) => {
        const defaults = chart.id === chartId
            ? Object.assign(getDefaultMappingsForChart(chart, isDirectoryAnalysis, pools), Object.fromEntries(selectedFieldByDimension))
            : getDefaultMappingsForChart(chart, isDirectoryAnalysis, pools);
        const selectedFields = new Map<string, string>(Object.entries(defaults));
        const chartDimensions = buildDimensionsForChart(chart, selectedFields, pools);
        dimensionsByChart[chart.id] = chartDimensions;
        defaultMappingsByChart[chart.id] = defaults;
        return {
            id: chart.id,
            name: chart.name,
            category: chart.category,
            dimensions: chart.dimensions.map((dimension) => ({
                id: dimension.name,
                label: dimension.label,
                dataType: dimension.dataType,
                valueRule: dimension.valueRule,
                required: dimension.required,
            })),
        };
    }).filter((chart) => (dimensionsByChart[chart.id] ?? []).length > 0);

    return { availableCharts, dimensionsByChart, defaultMappingsByChart };
}
