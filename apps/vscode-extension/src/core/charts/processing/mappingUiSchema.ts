/**
 * The in-scene mapping UI model: the charts, dimensions and candidate fields
 * the corner controller offers over rows of one analysis kind. The scene
 * generator embeds it (TemplateProcessor.buildBabiaUiPlaceholders) and the
 * drill-down hands it to a scene drilled into the other kind (#333).
 */
import { ChartMetadata, DimensionDataType, DimensionValueRule } from '../chartModels';
import { chartTemplates } from '../templateCharts';
import { XRFieldTypeMap, XRSchemaTargetType } from '../xrFieldModels';

/** One dimension row of the mapping UI: its candidate fields, the current one first. */
export interface MappingUiDimension {
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

// Candidates for a dimension. A numeric axis lists numeric fields only (Babia
// scales geometry by the value; text gives NaN axes), and a chart with an
// unfillable numeric axis is not offered (buildDimensionsForChart returns []),
// never published with that axis missing or texted ("invalid axis"). Text
// and `any` axes take every field: any value renders as a label.
function candidateFieldsFor(dataType: DimensionDataType, pools: SchemaFieldPools): string[] {
    const { numericFields, textFields, anyFields } = pools;
    if (dataType === 'numeric') {
        return numericFields;
    }
    return dataType === 'text' && textFields.length > 0 ? textFields : anyFields;
}

function buildDimensionsForChart(chart: ChartMetadata, selectedFields: Map<string, string>, pools: SchemaFieldPools): MappingUiDimension[] {
    const result: MappingUiDimension[] = [];
    for (const dimension of chart.dimensions) {
        const candidateFields = candidateFieldsFor(dimension.dataType, pools);
        if (candidateFields.length === 0) {
            return [];
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

/** The controller's charts and fields for one analysis kind (what the mapping UI's config carries). */
export interface MappingUiSchema {
    readonly chartId: string;
    readonly targetType: XRSchemaTargetType;
    readonly dimensions: MappingUiDimension[];
    readonly availableCharts: unknown[];
    readonly dimensionsByChart: Record<string, unknown>;
    readonly defaultMappingsByChart: Record<string, unknown>;
}

/**
 * The mapping UI schema of a chart over rows of one kind: the scene generator
 * embeds it, and the drill-down hands it to a scene drilled into another kind.
 * Null when the chart is unknown or has no field it can map.
 */
export function buildMappingUiSchema(
    chartId: string,
    selectedFields: Readonly<Record<string, string>>,
    isDirectoryAnalysis: boolean,
    fieldTypeMap: XRFieldTypeMap,
): MappingUiSchema | null {
    const chartMetadata = chartTemplates.find((chart) => chart.id === chartId);
    if (!chartMetadata) {
        return null;
    }
    const pools = buildSchemaFieldPools(fieldTypeMap);
    const selected = new Map(Object.entries(selectedFields).filter(([, field]) => !!field));
    const { availableCharts, dimensionsByChart, defaultMappingsByChart } = buildChartCatalog(chartId, selected, isDirectoryAnalysis, pools);
    const dimensions = buildDimensionsForChart(chartMetadata, selected, pools);
    if (dimensions.length === 0) {
        return null;
    }
    return {
        chartId,
        targetType: isDirectoryAnalysis ? 'directory' : 'file',
        dimensions,
        availableCharts,
        dimensionsByChart,
        defaultMappingsByChart,
    };
}
