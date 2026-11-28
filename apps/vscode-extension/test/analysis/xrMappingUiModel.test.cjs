'use strict';

/**
 * Characterization of the in-scene mapping UI model that
 * TemplateProcessor.buildBabiaUiPlaceholders serializes into every XR scene
 * (`<script id="codexr-tooling-config-xr-mapping-ui">`): candidate fields per
 * dimension, default mappings per chart, the charts offered by the switcher,
 * the panel placement and the early exits. Compared with a committed golden
 * (xrMappingUiModel.golden.json) for every chart x {file, directory} schema,
 * with and without user mappings, plus the edge cases.
 *
 * Regenerate (only for an intended change, and say so in the commit):
 *   CODEXR_WRITE_XR_MAPPING_UI_GOLDEN=1 node --test --test-isolation=none test/analysis/xrMappingUiModel.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createFakeVscode, withFakeVscode } = require('../helpers/fakeVscode.cjs');

const goldenPath = path.join(__dirname, 'xrMappingUiModel.golden.json');

// The two schemas of backend/src/utils/xr_field_schema.py (names and types).
const FILE_FIELDS = {
    functionName: 'text', lineStart: 'numeric', lineEnd: 'numeric', lineCount: 'numeric', spanLines: 'numeric',
    complexity: 'numeric', complexityBand: 'text', parameters: 'numeric', maxNestingDepth: 'numeric',
    cyclomaticDensity: 'numeric', cognitiveComplexity: 'numeric', halsteadVolume: 'numeric',
    halsteadDifficulty: 'numeric', halsteadEffort: 'numeric', halsteadBugs: 'numeric', maintainabilityIndex: 'numeric',
    filePath: 'text', fileName: 'text', treePath: 'text',
};
const DIRECTORY_FIELDS = {
    fileName: 'text', filePath: 'text', relativePath: 'text', language: 'text', totalLines: 'numeric',
    codeLines: 'numeric', commentLines: 'numeric', blankLines: 'numeric', commentRatio: 'numeric', codeRatio: 'numeric',
    blankRatio: 'numeric', classCount: 'numeric', functionCount: 'numeric', maxComplexity: 'numeric',
    cyclomaticComplexityNumber: 'numeric', cyclomaticComplexityDensity: 'numeric', highComplexityFunctions: 'numeric',
    criticalComplexityFunctions: 'numeric', averageFunctionParameters: 'numeric', maxFunctionParameters: 'numeric',
    averageFunctionLines: 'numeric', maxFunctionLines: 'numeric', averageFunctionNestingDepth: 'numeric',
    maxFunctionNestingDepth: 'numeric', averageCognitiveComplexity: 'numeric', maxCognitiveComplexity: 'numeric',
    averageMaintainabilityIndex: 'numeric', minMaintainabilityIndex: 'numeric', totalHalsteadVolume: 'numeric',
    totalHalsteadBugs: 'numeric', fileSizeBytes: 'numeric',
};

function buildCases(chartTemplates) {
    const cases = [];
    for (const chart of chartTemplates) {
        for (const [schema, fields, isDirectory] of [['file', FILE_FIELDS, false], ['directory', DIRECTORY_FIELDS, true]]) {
            cases.push({ name: `${chart.id}/${schema}/defaults`, chartId: chart.id, mappings: [], isDirectory, options: { fieldTypeMap: fields } });
            // A user mapping on every dimension: the LAST field of the right type,
            // so it differs from the defaults and must be moved to the front.
            const names = Object.keys(fields);
            const mappings = chart.dimensions.map((dimension) => {
                const pool = names.filter((name) => dimension.dataType === 'any' || fields[name] === dimension.dataType);
                return { dimension: dimension.name, dataField: pool[pool.length - 1] };
            });
            cases.push({
                name: `${chart.id}/${schema}/mapped-hidden`,
                chartId: chart.id,
                mappings: [...mappings, { dimension: 'unknownDimension', dataField: names[0] }, { dimension: mappings[0] ? mappings[0].dimension : 'x', dataField: '' }],
                isDirectory,
                options: { fieldTypeMap: fields, babiaUiVisibleByDefault: false, xrTargetType: isDirectory ? 'directory' : 'file' },
            });
        }
    }
    const firstChart = chartTemplates[0].id;
    cases.push({ name: 'edge/unknown-chart', chartId: 'no-such-chart', mappings: [], isDirectory: false, options: { fieldTypeMap: FILE_FIELDS } });
    cases.push({ name: 'edge/no-entity-id', chartId: firstChart, entityId: '', mappings: [], isDirectory: false, options: { fieldTypeMap: FILE_FIELDS } });
    cases.push({ name: 'edge/no-field-type-map', chartId: firstChart, mappings: [], isDirectory: false, options: {} });
    cases.push({ name: 'edge/no-options', chartId: firstChart, mappings: [], isDirectory: false, options: undefined });
    cases.push({ name: 'edge/empty-schema', chartId: firstChart, mappings: [], isDirectory: true, options: { fieldTypeMap: {} } });
    cases.push({ name: 'edge/text-only-schema', chartId: firstChart, mappings: [], isDirectory: false, options: { fieldTypeMap: { functionName: 'text', fileName: 'text' } } });
    cases.push({ name: 'edge/numeric-only-schema', chartId: firstChart, mappings: [], isDirectory: true, options: { fieldTypeMap: { totalLines: 'numeric' } } });
    cases.push({ name: 'edge/target-type-override', chartId: firstChart, mappings: [], isDirectory: true, options: { fieldTypeMap: DIRECTORY_FIELDS, xrTargetType: 'file' } });
    cases.push({ name: 'edge/closing-script-tag-in-title', chartId: firstChart, title: 'a </script> b', mappings: [], isDirectory: false, options: { fieldTypeMap: FILE_FIELDS } });
    return cases;
}

function capture() {
    const fake = createFakeVscode();
    return withFakeVscode(fake, ({ requireOut }) => {
        const { TemplateProcessor } = requireOut('core/charts/processing/templateProcessor.js');
        const { chartTemplates } = requireOut('core/charts/templateCharts.js');
        return buildCases(chartTemplates).map((entry) => {
            const result = TemplateProcessor.buildBabiaUiPlaceholders(
                entry.chartId,
                entry.entityId === undefined ? 'chartEntity' : entry.entityId,
                entry.mappings,
                entry.title || `Title ${entry.name}`,
                entry.isDirectory,
                entry.options,
            );
            // The whole script is pinned by its hash; the current chart's dimensions
            // and defaults are kept in clear so a failure says what moved.
            const json = result.scriptHtml.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
            const model = json ? JSON.parse(json) : undefined;
            return {
                case: entry.name,
                componentHtml: result.componentHtml,
                scriptSha256: crypto.createHash('sha256').update(result.scriptHtml).digest('hex'),
                scriptLength: result.scriptHtml.length,
                dimensions: model ? model.dimensions : null,
                defaults: model ? model.defaultMappingsByChart[model.chartId] : null,
            };
        });
    });
}

test('the XR mapping UI model of every chart and schema matches the committed golden', () => {
    const results = capture();
    const serialized = `[\n${results.map((entry) => JSON.stringify(entry)).join(',\n')}\n]\n`;

    if (process.env.CODEXR_WRITE_XR_MAPPING_UI_GOLDEN === '1') {
        fs.writeFileSync(goldenPath, serialized);
    }

    // Sanity: the realistic cases all produce a model, the edge cases do not all collapse.
    assert.ok(results.filter((entry) => entry.dimensions !== null).length >= 32);
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    assert.deepEqual(results, golden);
});

// Epic #219 (#223): the new metrics are offered on every numeric axis like any
// other metric, and no axis that only takes numbers ever lists a text field.
const NEW_FILE_METRICS = ['cognitiveComplexity', 'halsteadVolume', 'halsteadDifficulty', 'halsteadEffort', 'halsteadBugs', 'maintainabilityIndex'];
const NEW_DIRECTORY_METRICS = ['averageCognitiveComplexity', 'maxCognitiveComplexity', 'averageMaintainabilityIndex', 'minMaintainabilityIndex', 'totalHalsteadVolume', 'totalHalsteadBugs'];

function mappingModel(chartId, isDirectory, fieldTypeMap) {
    const fake = createFakeVscode();
    return withFakeVscode(fake, ({ requireOut }) => {
        const { TemplateProcessor } = requireOut('core/charts/processing/templateProcessor.js');
        const { chartTemplates } = requireOut('core/charts/templateCharts.js');
        const result = TemplateProcessor.buildBabiaUiPlaceholders(chartId, 'chartEntity', [], 'Title', isDirectory, { fieldTypeMap });
        const json = result.scriptHtml.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
        return { model: json ? JSON.parse(json) : null, chartTemplates };
    });
}

test('every numeric axis of every chart offers the new metrics, in both schemas', () => {
    const { chartTemplates } = mappingModel('bars', false, FILE_FIELDS);
    for (const [fields, metrics, isDirectory] of [[FILE_FIELDS, NEW_FILE_METRICS, false], [DIRECTORY_FIELDS, NEW_DIRECTORY_METRICS, true]]) {
        const { model } = mappingModel(chartTemplates[0].id, isDirectory, fields);
        for (const chart of chartTemplates) {
            const dimensions = model.dimensionsByChart[chart.id];
            assert.ok(dimensions, `${chart.id} is offered`);
            for (const dimension of dimensions) {
                if (dimension.dataType === 'numeric' || dimension.dataType === 'any') {
                    for (const metric of metrics) {
                        assert.ok(dimension.fields.includes(metric), `${chart.id}.${dimension.id} offers ${metric}`);
                    }
                }
            }
        }
    }
});

test('a numeric axis never lists a text field, even when the schema has no numeric field', () => {
    for (const [fields, isDirectory] of [[FILE_FIELDS, false], [DIRECTORY_FIELDS, true], [{ functionName: 'text', fileName: 'text' }, false]]) {
        const { model, chartTemplates } = mappingModel('bars', isDirectory, fields);
        const byChart = model ? model.dimensionsByChart : {};
        for (const chart of chartTemplates) {
            for (const dimension of byChart[chart.id] || []) {
                if (dimension.dataType === 'numeric') {
                    for (const field of dimension.fields) {
                        assert.equal(fields[field], 'numeric', `${chart.id}.${dimension.id} lists ${field}`);
                    }
                }
            }
        }
    }
    // With text fields only, no chart can draw its numeric axis: none is offered, and no panel is built.
    const { model } = mappingModel('bars', false, { functionName: 'text', fileName: 'text' });
    assert.equal(model, null);
});

// #333: the drill-down hands a scene the schema of the other analysis kind
// (the functions of one file drilled from a project). It is the same schema
// the scene generator embeds, so the controller behaves the same either way.
test('the drill-down controller schema is the schema the scene embeds, for both kinds', () => {
    const fake = createFakeVscode();
    withFakeVscode(fake, ({ requireOut }) => {
        const { TemplateProcessor } = requireOut('core/charts/processing/templateProcessor.js');
        const { buildMappingUiSchema } = requireOut('core/charts/processing/mappingUiSchema.js');
        for (const [fields, isDirectory] of [[FILE_FIELDS, false], [DIRECTORY_FIELDS, true]]) {
            const mappings = [{ dimension: 'height', dataField: isDirectory ? 'totalLines' : 'lineCount' }];
            const result = TemplateProcessor.buildBabiaUiPlaceholders('boats', 'chartEntity', mappings, 'Title', isDirectory, { fieldTypeMap: fields });
            const model = JSON.parse(result.scriptHtml.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
            // Through JSON, as the entity reaches the room.
            const schema = JSON.parse(JSON.stringify(buildMappingUiSchema('boats', { height: mappings[0].dataField }, isDirectory, fields)));
            for (const key of ['chartId', 'targetType', 'dimensions', 'availableCharts', 'dimensionsByChart', 'defaultMappingsByChart']) {
                assert.deepEqual(schema[key], model[key], `${isDirectory ? 'directory' : 'file'}.${key}`);
            }
        }
        assert.equal(buildMappingUiSchema('no-such-chart', {}, false, FILE_FIELDS), null);
        assert.equal(buildMappingUiSchema('boats', {}, false, { functionName: 'text' }), null);
    });
});
