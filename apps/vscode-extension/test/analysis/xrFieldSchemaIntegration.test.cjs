const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');

function readProjectFile(...segments) {
    return fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');
}

test('Python entry point exposes schema mode for XR file and directory mappings', () => {
    const source = readProjectFile('..', '..', 'backend', 'src', 'main.py');

    assert.match(source, /choices=\['livePanel', 'xr', 'schema', 'dependencies'\]/);
    assert.match(source, /if args\.mode == 'schema':/);
    assert.match(source, /def execute_schema_request\(target_type\):/);
});

test('XR schema registry includes the new file and directory metrics used by the UI', () => {
    const source = readProjectFile('..', '..', 'backend', 'src', 'utils', 'xr_field_schema.py');

    assert.match(source, /_numeric_field\("spanLines", "Span Lines"/);
    assert.match(source, /_text_field\("complexityBand", "Complexity Band"/);
    assert.match(source, /_numeric_field\("commentRatio", "Comment Ratio"/);
    assert.match(source, /_numeric_field\("averageFunctionLines", "Average Function Lines"/);
    assert.match(source, /_numeric_field\("maxFunctionNestingDepth", "Max Function Nesting Depth"/);
});

test('shared dimension mapping core consumes the schema service instead of hardcoded field lists', () => {
    const sharedCore = readProjectFile(
        'src',
        'features',
        'analysis',
        'sections',
        'settings',
        'sharedDimensionMappingSettingCore.ts',
    );
    const fileSetting = readProjectFile(
        'src',
        'features',
        'analysis',
        'sections',
        'settings',
        'dimension-mapping-file',
        'dimensionMappingFile.ts',
    );
    const directorySetting = readProjectFile(
        'src',
        'features',
        'analysis',
        'sections',
        'settings',
        'dimension-mapping-directory',
        'dimensionMappingDirectory.ts',
    );

    assert.match(sharedCore, /XRFieldSchemaService/);
    assert.match(sharedCore, /getFieldsForDataType\(\s*this\.adapter\.targetType,/);
    assert.equal(sharedCore.includes('getAvailableDataFields()'), false);
    assert.equal(sharedCore.includes('getNumericDataFields()'), false);

    assert.match(fileSetting, /SharedDimensionMappingSettingCore/);
    assert.match(directorySetting, /SharedDimensionMappingSettingCore/);
    assert.equal(directorySetting.includes('DIRECTORY_DATA_FIELDS'), false);
});

test('XR schema consumers support text-only dimensions for categorical chart axes', () => {
    const schemaService = readProjectFile(
        'src',
        'core',
        'analysis',
        'python',
        'xrFieldSchemaService.ts',
    );
    const templateProcessor = readProjectFile(
        'src',
        'core',
        'charts',
        'processing',
        'templateProcessor.ts',
    );
    const templateCharts = readProjectFile(
        'src',
        'core',
        'charts',
        'templateCharts.ts',
    );

    assert.match(schemaService, /if \(dataType === 'text'\)/);
    assert.match(templateProcessor, /fieldType === 'text'/);
    // Candidates are picked by data type, with every field as the fallback so a
    // declared dimension is never dropped (that published charts with a missing
    // axis, e.g. barsmap without z_axis → "invalid axis").
    assert.match(templateProcessor, /dataType === 'text' \? textFields : anyFields/);
    assert.match(templateProcessor, /return strictFields\.length > 0 \? strictFields : anyFields/);
    assert.match(templateProcessor, /valueRule: dimension\.valueRule/);
    assert.match(templateCharts, /id: 'cylsmap'[\s\S]*name: 'x_axis'[\s\S]*dataType: 'any'/);
    assert.match(templateCharts, /id: 'cylsmap'[\s\S]*name: 'z_axis'[\s\S]*dataType: 'any'/);
    assert.match(templateCharts, /id: 'pie'[\s\S]*name: 'key'[\s\S]*dataType: 'any'/);
});

test('XR launcher validates mappings with schema-provided field types before execution', () => {
    const source = readProjectFile('src', 'core', 'analysis', 'launchers', 'launcherXRAnalysis.ts');

    assert.match(source, /getFieldTypeMap\(analysisType, true\)/);
    assert.match(source, /Python field schema is not available yet/);
    assert.match(source, /DimensionValidator\.validateMappings\(chartMetadata, mappingsArray, fieldTypes\)/);
});

test('boats chart metadata keeps numeric-only area and height with any-valued color', () => {
    const templateCharts = readProjectFile('src', 'core', 'charts', 'templateCharts.ts');
    const createChart = readProjectFile('src', 'core', 'charts', 'processing', 'placeholders', 'createChart.ts');

    assert.doesNotMatch(templateCharts, /id: 'codexr-boats'/);

    assert.match(templateCharts, /id: 'boats'[\s\S]*name: 'area'[\s\S]*dataType: 'numeric'/);
    assert.match(templateCharts, /id: 'boats'[\s\S]*name: 'height'[\s\S]*dataType: 'numeric'/);
    assert.match(templateCharts, /id: 'boats'[\s\S]*name: 'color'[\s\S]*dataType: 'any'/);

    // The duplicated boats metadata is gone: createChart resolves every chart
    // from the canonical template list.
    assert.doesNotMatch(createChart, /dataType:/);
    assert.match(createChart, /chartTemplates\.find\(\(candidate\) => candidate\.id === chartId\)/);
});
