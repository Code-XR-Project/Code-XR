const test = require('node:test');
const assert = require('node:assert/strict');

// Characterization of DimensionValidator.validateMappings (ROADMAP W4-T12,
// hotspots-ts/CPLX-12'): the exact errors and warnings, their ORDER (the
// rule passes run one after another and each appends), the early `continue`
// of the per-mapping pass, and isValid. The module is pure (type-only
// imports), so it loads from out/ directly.
const { DimensionValidator } = require('../../out/babia_templates/processing/dimensionValidator.js');

const CHART = {
    name: 'Bars',
    dimensions: [
        { name: 'x', label: 'X axis', required: true, dataType: 'string' },
        { name: 'height', label: 'Height', required: true, dataType: 'number' },
        { name: 'color', label: 'Colour', required: false, dataType: 'any' },
        { name: 'size', label: 'Size', required: false, dataType: 'number' },
    ],
};

const FIELD_TYPES = { fileName: 'string', lines: 'number', language: 'string', complexity: 'number' };

const map = (pairs) => pairs.map(([dimension, dataField]) => ({ dimension, dataField }));

test('a complete, well-typed mapping is valid and warns for each unmapped optional dimension', () => {
    const result = DimensionValidator.validateMappings(CHART, map([['x', 'fileName'], ['height', 'lines']]), FIELD_TYPES);
    assert.deepEqual(result, {
        isValid: true,
        errors: [],
        warnings: [
            "Optional dimension 'color' (Colour) is not mapped",
            "Optional dimension 'size' (Size) is not mapped",
        ],
    });
});

test('every rule fires, in pass order: required, unknown, duplicate, per-mapping field checks; then warnings', () => {
    const result = DimensionValidator.validateMappings(CHART, map([
        ['bogus', 'lines'],
        ['color', 'nope'],
        ['size', 'fileName'],
        ['color', 'language'],
        ['height', ''],
        ['size', '   '],
        ['bogus', undefined],
    ]), FIELD_TYPES);
    assert.deepEqual(result, {
        isValid: false,
        errors: [
            "Required dimension 'x' (X axis) is not mapped",
            "Unknown dimension 'bogus' for chart type 'Bars'",
            "Unknown dimension 'bogus' for chart type 'Bars'",
            "Dimension 'bogus' is mapped multiple times",
            "Dimension 'color' is mapped multiple times",
            "Dimension 'size' is mapped multiple times",
            // per mapping, in mapping order; an unknown dimension skips the field checks
            "Data field 'nope' is not available for chart type 'Bars'",
            "Dimension 'size' (Size) requires number data, but 'fileName' is string",
            "Dimension 'height' has no data field specified",
            "Dimension 'size' has no data field specified",
            "Dimension 'bogus' has no data field specified",
        ],
        warnings: [],
    });
});

test('without field types the existence and type checks are skipped entirely', () => {
    const result = DimensionValidator.validateMappings(CHART, map([['x', 'whatever'], ['height', 'nope'], ['size', '']]));
    assert.deepEqual(result, {
        isValid: false,
        errors: ["Dimension 'size' has no data field specified"],
        warnings: ["Optional dimension 'color' (Colour) is not mapped"],
    });
});

test("'any' skips the type check but the field must exist", () => {
    const ok = DimensionValidator.validateMappings(CHART, map([['x', 'fileName'], ['height', 'lines'], ['color', 'lines']]), FIELD_TYPES);
    assert.equal(ok.isValid, true);
    const missing = DimensionValidator.validateMappings(CHART, map([['x', 'fileName'], ['height', 'lines'], ['color', 'ghost']]), FIELD_TYPES);
    assert.deepEqual(missing.errors, ["Data field 'ghost' is not available for chart type 'Bars'"]);
    // a field typed `undefined` in the map counts as missing
    const undefinedType = DimensionValidator.validateMappings(CHART, map([['x', 'fileName'], ['height', 'gap']]), { ...FIELD_TYPES, gap: undefined });
    assert.deepEqual(undefinedType.errors, ["Data field 'gap' is not available for chart type 'Bars'"]);
});

test('a duplicated required dimension is reported once as duplicate and its fields are each checked', () => {
    const result = DimensionValidator.validateMappings(CHART, map([['x', 'fileName'], ['height', 'lines'], ['x', 'lines']]), FIELD_TYPES);
    assert.deepEqual(result.errors, [
        "Dimension 'x' is mapped multiple times",
        "Dimension 'x' (X axis) requires string data, but 'lines' is number",
    ]);
});

test('an empty mapping list on a chart with no dimensions is valid with nothing to report', () => {
    assert.deepEqual(DimensionValidator.validateMappings({ name: 'Empty', dimensions: [] }, [], FIELD_TYPES), {
        isValid: true, errors: [], warnings: [],
    });
});
