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
    cyclomaticDensity: 'numeric', filePath: 'text', fileName: 'text', treePath: 'text',
};
const DIRECTORY_FIELDS = {
    fileName: 'text', filePath: 'text', relativePath: 'text', language: 'text', totalLines: 'numeric',
    codeLines: 'numeric', commentLines: 'numeric', blankLines: 'numeric', commentRatio: 'numeric', codeRatio: 'numeric',
    blankRatio: 'numeric', classCount: 'numeric', functionCount: 'numeric', maxComplexity: 'numeric',
    cyclomaticComplexityNumber: 'numeric', cyclomaticComplexityDensity: 'numeric', highComplexityFunctions: 'numeric',
    criticalComplexityFunctions: 'numeric', averageFunctionParameters: 'numeric', maxFunctionParameters: 'numeric',
    averageFunctionLines: 'numeric', maxFunctionLines: 'numeric', averageFunctionNestingDepth: 'numeric',
    maxFunctionNestingDepth: 'numeric', fileSizeBytes: 'numeric',
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
        const { TemplateProcessor } = requireOut('babia_templates/processing/templateProcessor.js');
        const { chartTemplates } = requireOut('babia_templates/charts/templateCharts.js');
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
