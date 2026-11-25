/**
 * The shape of the XR field schema (the analysis fields a chart dimension can
 * be mapped to), as Python's `main.py --mode schema` reports it. The values
 * and their order are the Python contract (`utils/xr_field_schema.py`); these
 * are only the TypeScript types, kept beside the chart models that consume
 * them. `code_analysis/services/xrFieldSchemaService.ts` loads the schema and
 * re-exports these types.
 */

export type XRSchemaTargetType = 'file' | 'directory';
export type XRFieldValueType = 'numeric' | 'text';

export interface XRFieldDefinition {
    id: string;
    label: string;
    description: string;
    valueType: XRFieldValueType;
}

export interface XRFieldSchema {
    schemaVersion: number;
    analysisMode: 'xr';
    targetType: XRSchemaTargetType;
    fields: XRFieldDefinition[];
}

export type XRFieldTypeMap = Record<string, XRFieldValueType>;
