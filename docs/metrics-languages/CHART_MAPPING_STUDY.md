# Chart mapping panel and BabiaXR axis types: a study

Story #228 (epic #219). This is the context for #223, which wires the new metrics (cognitive complexity,
Halstead, maintainability index) into the charts. The question it answers: how does a metric become
an option on a chart axis? Where is "numbers only" enforced? What does a new field need so it shows
up like any other one, and never on an axis that cannot draw it?

Paths are relative to `apps/vscode-extension/` unless they start with `backend/`. Line numbers are from
the branch at the time of writing (2026-11-26).

## 1. Summary

- **Every option list comes from one schema.** It is declared in `backend/src/utils/xr_field_schema.py`
  (`XR_FILE_FIELDS` l.29, `XR_DIRECTORY_FIELDS` l.46), and each field carries a `valueType`, `numeric`
  or `text`. Nothing in TypeScript lists the fields by hand, apart from two test mirrors and the
  defaults (section 6). **A field declared there with `valueType: numeric` is offered on every numeric
  axis, in both pickers, in the extension and in the IDE, without any other code change.**
- **Chart axes declare their type** in `src/core/charts/templateCharts.ts`. The type is `dataType`
  (`numeric` | `text` | `any`), plus an optional `valueRule` (`numeric-finite` | `numeric-positive`).
  No axis today is `text`-only: category axes are `any`.
- **There are two pickers and both filter by type:** the VS Code sidebar quick pick and the in-scene
  XR panel. A validator also checks at launch. There is **one gap**: when a schema has *no* numeric
  field at all, the in-scene panel falls back to offering text fields on numeric axes (section 5, G1).
  The real schemas always have numeric fields, so the gap is not reachable today, but it breaks the
  rule Adrián set, and #223 closes it.
- **The IDE has no separate panel.** It runs the extension's core (`@codexr/core/*`,
  `apps/ide/src/main/analysis/analysisService.ts` drives `AnalysisOrchestrator`) and shows the
  same generated scene with the same in-scene runtime, so one change covers both hosts.

## 2. The flow

```
backend/src/utils/xr_field_schema.py     XR_FILE_FIELDS / XR_DIRECTORY_FIELDS  (id, label, description, valueType)
        │  main.py --mode schema
        ▼
src/core/analysis/python/xrFieldSchemaService.ts   live per activation (prefetchAll, forceRefresh),
        │                                          persisted cache only as a fallback
        ├─► getFieldsForDataType(target, dataType)  ──► sidebar quick pick (sharedDimensionMappingSettingCore.ts l.113)
        ├─► getFieldTypeMap(target)  ──► DimensionValidator / DimensionMappingValidator (launch-time + tree icons)
        └─► getFieldTypeMap(target)  ──► fileXRParser.ts l.176 / directoryXRParser.ts l.113
                                              │ options.fieldTypeMap
                                              ▼
                     src/core/charts/processing/templateProcessor.ts  buildBabiaUiPlaceholders (l.243)
                       buildSchemaFieldPools (l.383) → candidateFieldsFor (l.398) → per-dimension `fields`
                                              │ serialized as <script id="codexr-tooling-config-xr-mapping-ui">
                                              ▼
                     templates/components/codexr/xr-chart-mapping-ui/xrChartMappingUiRuntime/
                       panelUi.js renderRows: one button per candidate field, label = compactLabel(id)
                       chartDataSlice.js: drops rows whose value breaks the axis valueRule
```

The data rows themselves are produced separately, by the engines that write `data.json`:

| Rows | Built in |
|---|---|
| File analysis, one row per function | `backend/src/utils/file_analysis_engine.py`: `normalize_function_metrics` (l.63) and `build_file_payload` |
| Directory analysis, one row per file | `file_analysis_engine.py` (directory payload) and `backend/src/utils/file_metric_summary.py` (l.20–50) |
| Re-analysis defaults (watcher) | `src/core/analysis/watchers/directoryReanalysisData.ts` (l.265–295) |

All three spell the keys out one by one. A field present in the schema but absent from the rows would be
offered by the panel and then draw an empty axis.

## 3. Chart axes and what they accept

From `templateCharts.ts`. Every dimension is `required: true`.

| Chart | Axis | `dataType` | `valueRule` | BabiaXR use |
|---|---|---|---|---|
| bars | x_axis | any | | category label of each bar |
| | height | **numeric** | numeric-finite | bar height |
| barsmap | x_axis, z_axis | any | | grid row/column labels |
| | height | **numeric** | numeric-finite | bar height |
| cyls | x_axis | any | | category label |
| | height | **numeric** | numeric-finite | cylinder height |
| | radius | **numeric** | numeric-positive | cylinder radius |
| cylsmap | x_axis, z_axis | any | | grid labels |
| | height | **numeric** | numeric-finite | height |
| | radius | **numeric** | numeric-positive | radius |
| bubbles | x_axis, z_axis | any | | grid labels |
| | height | **numeric** | numeric-finite | height |
| | radius | **numeric** | numeric-positive | bubble radius |
| pie, donut | key | any | | slice label |
| | size | **numeric** | numeric-positive | slice angle |
| boats | area | **numeric** | numeric-positive | building footprint |
| | height | **numeric** | numeric-finite | building height |
| | color | any | | colour of each building (accepts any field) |

What these types mean in practice:

- **`any` is a label axis.** BabiaXR turns the value into a string label, so a numeric field is valid
  there too: it becomes one category per distinct value. Offering every field on `any` axes is correct.
  The one caveat is the comment beside `DIRECTORY_PREFERRED_FIELDS`: a high-cardinality field on
  `z_axis` gives one grid row per value and squashes the map charts. This is a *default* concern, not a
  type one.
- **`numeric` is a magnitude axis.** BabiaXR scales geometry by the value. A text value gives NaN
  geometry, and the analysis table then reports "invalid axis".
- **`valueRule` is enforced per row, not per field.** `chartDataSlice.js` (`computeChartDataSlice`,
  l.65) drops rows whose value is not finite (`numeric-finite`) or not > 0 (`numeric-positive`)
  before Babia sees them. The reason is that babia-cylsmap's radius maths yields −Infinity axes when a
  radius is 0.

## 4. Where the type is enforced today

1. **Sidebar quick pick** (`src/features/analysis/sections/settings/sharedDimensionMappingSettingCore.ts`
   l.113). It calls `getFieldsForDataType`: `numeric` axes list only numeric fields, `text` axes only
   text fields, and `any` lists all. This is strict, with no fallback. The tooltip says "(numerical
   only)", and each option's detail line says "Numeric" or "Text".
2. **Launch-time validation** (`src/core/charts/processing/dimensionValidator.ts`, `checkDataFields`
   l.50). It runs with the field-type map, rejects a mapping whose field type differs from a non-`any`
   axis, and rejects a field that is not in the schema at all. The sidebar's
   `DimensionMappingValidator` uses the same rules to paint the warning icon.
3. **In-scene panel model** (`templateProcessor.ts`, `candidateFieldsFor` l.398). The strict pool for
   the axis type is used, **but an empty strict pool falls back to every field**: see G1.
4. **In-scene runtime.**
   - `panelUi.js` marks numeric axes with `[N]`.
   - A field that already produced an invalid chart is disabled, through `invalidOptionsByDimension`
     and `getInvalidOptionReason` (`statusAndSharedState.js` l.63).
   - The row slice applies `valueRule`.

## 5. Gaps found

- **G1: text on a numeric axis, in-scene only.** `candidateFieldsFor` returns `anyFields` when there is no
  numeric field. The comment there explains why: dropping the dimension published an incomplete chart
  contract, which Babia rendered with non-finite axes. The right fix is to keep the dimension strict and
  **leave out the chart** whose numeric axis has no numeric candidate. `buildChartCatalog` already
  filters out charts with no dimensions, so a chart with an unfillable axis is dropped the same way. The
  current chart then has no panel rows, and `buildBabiaUiPlaceholders` already returns an empty panel
  when `dimensions` is empty. The golden case `edge/text-only-schema` in
  `test/analysis/xrMappingUiModel.golden.json` pins today's fallback and has to be regenerated, as an
  intended change.
- **G2: values of 0 on `numeric-positive` axes.** This matters for the new metrics. Cognitive complexity
  is 0 for any function without control flow, and the maintainability index can be 0. On
  radius/size/area those rows are dropped by `chartDataSlice.js`, exactly as already happens for
  `parameters = 0`. This is correct for Babia, and it is not a type problem. It should be stated in the
  metric descriptions so the user knows why straight-line functions vanish from a pie.
- **G3: the runtime's fallback rules** (`DIMENSION_VALUE_RULES_FALLBACK`, `chartDataSlice.js` l.42) mirror
  `valueRule` for scenes whose config predates it. They key on axes, not fields, so the new fields need
  nothing there.
- **G4: button labels.** `compactLabel` (`configAndLabels.js` l.215) humanises the field id and truncates
  it beyond 18 characters:
  - `halsteadDifficulty` becomes "Halstead Diffic...";
  - `averageMaintainabilityIndex` becomes "Average Maintai...".

  Adding `Halstead → Hal`, `Difficulty → Diff`, `Maintainability → Maint`, `Index → Idx`,
  `Cognitive → Cog` and `Volume → Vol` to its abbreviation map keeps them readable. The labels and
  descriptions in the schema (sidebar) are not truncated.
- **G5: hand-written key lists.** The row builders listed in section 2 spell out every key, and so does
  the LivePanel:
  - `templates/analysis_livePanel/file/fileAnalysismain.js`: row normaliser l.40–50, columns l.300+;
  - `templates/analysis_livePanel/directory/directoryAnalysismain.js`: summary l.85–135, columns l.620+.

  A new metric must be added to each, or it is in the schema but missing from the data or the table.
  #223 should define the new keys once in `xr_field_schema.py` and loop over them in the Python
  builders.
- **G6: test mirrors.** `test/analysis/xrMappingUiModel.test.cjs` (l.28–40) copies both schemas
  (`FILE_FIELDS`, `DIRECTORY_FIELDS`). `backend/tests/xr_schema/test_xr_schema.py` pins the field
  lists. Both must grow with the schema, and the golden must be regenerated.
- **G7: defaults.** `FILE_PREFERRED_FIELDS` and `DIRECTORY_PREFERRED_FIELDS` (`templateProcessor.ts`
  l.340/369) choose what a fresh scene maps. New fields are appended to the schema, so they never
  displace a default. Whether a new metric should *become* a default (for example, colour by
  maintainability) is a product choice, outside this epic unless Adrián asks.

## 6. What #223 has to do

1. Add the per-function fields (`cognitiveComplexity`, `halsteadVolume`, `halsteadDifficulty`,
   `halsteadEffort`, `halsteadBugs`, `maintainabilityIndex`) to `XR_FILE_FIELDS` as `numeric`. Add the
   file aggregates to `XR_DIRECTORY_FIELDS` as `numeric`:
   - `averageCognitiveComplexity`, `maxCognitiveComplexity`;
   - `averageMaintainabilityIndex`, `minMaintainabilityIndex`;
   - `totalHalsteadVolume`, `totalHalsteadBugs`.

   Each gets a label and a description that says what it shows.
2. Carry them in every row builder (G5): Python engines, re-analysis defaults, and the LivePanel
   tables.
3. Close G1: numeric axes never fall back to text, and a chart that cannot fill a numeric axis is not
   offered. Add a unit test that feeds a schema with text fields only and asserts no numeric
   dimension lists a text field.
4. Add a test that every numeric axis of every chart offers each new metric (in-scene model) and that
   `getFieldsForDataType('numeric')` returns them (sidebar).
5. Extend the abbreviations (G4) and regenerate the goldens (G6).
6. Back-compat: the runtime and the validators only look up fields that the schema lists, so old exports
   without the new keys keep loading. A saved mapping to a new field on an old export would read
   `undefined` → NaN, and the slice drops such rows, as it does today for a missing value.
