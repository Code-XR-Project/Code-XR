import { ChartMetadata, DimensionMapping, ChartValidationResult } from '../chartModels';
import { XRFieldTypeMap } from '../xrFieldModels';

/** What every mapping rule sees. */
interface MappingRuleContext {
    chart: ChartMetadata;
    mappings: DimensionMapping[];
    mappedDimensions: Set<string>;
    fieldTypes?: XRFieldTypeMap;
}

/** Each rule appends to `errors`; only the optional-dimension rule warns. */
type MappingRule = (context: MappingRuleContext, errors: string[], warnings: string[]) => void;

function checkRequiredDimensionsMapped({ chart, mappedDimensions }: MappingRuleContext, errors: string[]): void {
    for (const requiredDim of chart.dimensions.filter((dimension) => dimension.required)) {
        if (!mappedDimensions.has(requiredDim.name)) {
            errors.push(`Required dimension '${requiredDim.name}' (${requiredDim.label}) is not mapped`);
        }
    }
}

function checkUnknownDimensions({ chart, mappings }: MappingRuleContext, errors: string[]): void {
    const validDimensionNames = new Set(chart.dimensions.map((dimension) => dimension.name));
    for (const mapping of mappings) {
        if (!validDimensionNames.has(mapping.dimension)) {
            errors.push(`Unknown dimension '${mapping.dimension}' for chart type '${chart.name}'`);
        }
    }
}

function checkDuplicateDimensions({ mappings }: MappingRuleContext, errors: string[]): void {
    const dimensionCounts = new Map<string, number>();
    for (const mapping of mappings) {
        dimensionCounts.set(mapping.dimension, (dimensionCounts.get(mapping.dimension) || 0) + 1);
    }
    for (const [dimension, count] of dimensionCounts) {
        if (count > 1) {
            errors.push(`Dimension '${dimension}' is mapped multiple times`);
        }
    }
}

/**
 * Per mapping, in order: a data field must be named; with the schema's field
 * types it must also exist, and match the dimension's type unless that is
 * 'any' ('any' skips the TYPE check but the field must still exist in the
 * schema — a typo used to sail through untouched).
 */
function checkDataFields({ chart, mappings, fieldTypes }: MappingRuleContext, errors: string[]): void {
    for (const mapping of mappings) {
        if (!mapping.dataField || mapping.dataField.trim() === '') {
            errors.push(`Dimension '${mapping.dimension}' has no data field specified`);
            continue;
        }

        const dimension = chart.dimensions.find((candidate) => candidate.name === mapping.dimension);
        if (!dimension || !fieldTypes) {
            continue;
        }

        const actualType = fieldTypes[mapping.dataField];
        if (actualType === undefined) {
            errors.push(`Data field '${mapping.dataField}' is not available for chart type '${chart.name}'`);
            continue;
        }

        if (dimension.dataType !== 'any' && actualType !== dimension.dataType) {
            errors.push(
                `Dimension '${mapping.dimension}' (${dimension.label}) requires ${dimension.dataType} data, but '${mapping.dataField}' is ${actualType}`,
            );
        }
    }
}

function warnUnmappedOptionalDimensions({ chart, mappedDimensions }: MappingRuleContext, _errors: string[], warnings: string[]): void {
    for (const optionalDim of chart.dimensions.filter((dimension) => !dimension.required)) {
        if (!mappedDimensions.has(optionalDim.name)) {
            warnings.push(`Optional dimension '${optionalDim.name}' (${optionalDim.label}) is not mapped`);
        }
    }
}

/** Run in this order: the order of the messages is part of the result. */
const MAPPING_RULES: readonly MappingRule[] = [
    checkRequiredDimensionsMapped,
    checkUnknownDimensions,
    checkDuplicateDimensions,
    checkDataFields,
    warnUnmappedOptionalDimensions,
];

/**
 * BabiaXR Dimension Validator
 * Validates dimension mappings against chart requirements.
 */
export class DimensionValidator {
    public static validateMappings(
        chart: ChartMetadata,
        mappings: DimensionMapping[],
        fieldTypes?: XRFieldTypeMap,
    ): ChartValidationResult {
        const context: MappingRuleContext = {
            chart,
            mappings,
            mappedDimensions: new Set(mappings.map((mapping) => mapping.dimension)),
            fieldTypes,
        };
        const errors: string[] = [];
        const warnings: string[] = [];
        for (const rule of MAPPING_RULES) {
            rule(context, errors, warnings);
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings,
        };
    }
}
