# `src/` layout: analysis and move plan (story #55)

> **Status:** executed by story #55 on 2026-11-25; the result is in [§7](#7-result-story-55-executed-2026-11-25). The analysis below is kept as written: analysis only, 2026-11-25, measured on `v1.2.1` at `e16b95e8` (after PRs #44–#57, #40 included). No source file is changed by this document. **Story:** [#55](https://github.com/Code-XR-Project/Code-XR/issues/55), epic [#26](https://github.com/Code-XR-Project/Code-XR/issues/26).
> **Update from #42 (layering):** three rows of the move map are already done at their destination here: `commands/shared/commandRegistry.ts` → `platform/commands/commandRegistry.ts` (the `commands/shared` barrel is deleted), `views/common/baseInterfaces.ts` → `platform/tree/baseInterfaces.ts`, and the new `platform/templatePaths.ts` (`resolveTemplatePath`; the `__dirname`-depth constraint in §3.4 is gone). Two of the five `core/` pairs of §3.5 are broken: `analysis↔charts` (the XR field types moved to `babia_templates/models/xrFieldModels.ts`) and `collaboration↔remote-access` (`CollaborationClientKind` declared in `collaboration/model/connectedParticipant.ts`). The folder matrix is data in `test/tooling/folderDependencies.json` (#42's direction test): rewrite it with each batch.
> Paths are relative to `apps/vscode-extension/` (so `src/…` is the extension source) unless stated otherwise. Every number below comes from the scripts in the [appendix](#appendix-scripts) and can be re-run.

## 0. Summary

- `src/` today: **332 files, 48,005 lines, 169 folders**, 15 top-level folders. A feature is spread over two or three layer folders (`views/<feature>/`, `commands/<feature>/`, `<feature>/views/`, `<feature>/commands/`), 56 folder names are snake_case and one is camelCase, 68 leaf folders hold a single file, and 49 `index.ts` barrels (47 pure re-exports) are 15% of all files.
- Target: **five top-level areas with one dependency direction** — `app/` → `features/` → `core/` → `platform/` → `shared/` — and one kebab-case folder per feature or subsystem inside them. 9 features, 9 core subsystems.
- Move map: **284 files move, 47 barrels are dissolved, 1 file stays** (`src/extension.ts`). Basenames are kept, except 13 files renamed to resolve a collision or to name an `index.ts` that holds code.
- After the move, the folder graph (measured with barrels resolved to the declaring file) has **one upward edge** (`core/server/multiServerLauncher.ts` → `features/active-servers/views/launchNotifications.ts`, already on #42's list), **one cross-feature pair** (`active-servers` → `collaboration`, the nested COLLABORATION group, by design) and **five two-way pairs inside `core/`** that #42 must break. Today there are 15 two-way pairs between top-level folders.
- Plan: batch 0 dissolves the barrels, then **14 move batches**, one per feature area, each one bisectable commit. **It must run after #34, #35 and #42 have merged** (#40 merged as PR #57 and is already in this map), in a window with no other open PR touching `src/`.
- Behaviour-neutrality cannot be proved with H1 (identical bundle hash), because webpack embeds module paths. The proposed proof (H3) compares every compiled module after `tsc --removeComments`, with each relative `require()` replaced by the module it resolves to. This was piloted on a scratch copy of the visualize-data and learn-more batches: 17 files moved, 19 files rewritten, 332/332 modules equivalent, and an injected one-character change was caught.

**Decisions for the maintainer** (each with the recommendation used in this document):

1. **Folder naming: kebab-case** (`active-servers/`, `python-env/`) for every folder under `src/`. Alternatives: camelCase (`activeServers/`), or keep snake_case. See §3.2.
2. **Feature names follow what the user sees, not the library**: `babia_examples` → `features/examples`, `babia_templates` → `core/charts`, `code_analysis/historical` → `core/history`. File names keep `babia` where they have it. Alternative: keep the `babia` prefix in folder names.
3. **`core/` changes meaning.** Today `src/core/` is the extension bootstrap (context, logger, startup); in the target it is the engine (analysis, charts, server, history, …), and the bootstrap moves to `platform/` and `app/`. Story #42 (item 6: "move the pure `commandRegistry` to `core/`") must use the new meaning, or land its move to `platform/commands/` instead.
4. **Barrels are dissolved, not moved** (§5.2). This follows the barrel policy already in `ARCHITECTURE.md` ("import the concrete file"). Alternative: one public `index.ts` per feature. Not recommended: it brings back the 15% of files that only re-export.

## 1. Current tree

### 1.1 Top level

| Folder | Files | Lines | What it holds |
|---|---:|---:|---|
| `code_analysis/` | 166 | 21,453 | Analysis engine, commands, sidebar section and settings, history, export, dependencies |
| `servers/` | 44 | 8,632 | HTTP/HTTPS/SSE/WebSocket runtime, collaboration room, broadcast, server commands and configuration views |
| `views/` | 32 | 3,467 | `ModularTreeDataProvider`, #40's `sectionDefinitions.ts`, and one sub-folder per sidebar section |
| `python_env/` | 7 | 2,088 | Managed venv, its commands and tree items |
| `babia_templates/` | 9 | 2,222 | Chart registry, models and HTML template processing |
| `active_servers/` | 10 | 2,049 | Running-server registry and control, plus actions |
| `visualize_data/` | 7 | 1,720 | "Visualize your own JSON" |
| `visualization_settings/` | 9 | 1,512 | Palette, environment, colours |
| `remote_access/` | 5 | 1,483 | Cloudflare tunnel, remote session authority |
| `utils/` | 12 | 1,038 | Grab-bag (see §2.6) |
| `babia_examples/` | 6 | 1,021 | Bundled BabiaXR examples |
| `commands/` | 14 | 531 | `registerAllCommands` and one registration wrapper per feature |
| `core/` | 4 | 298 | Extension context, logger, startup coordinator |
| `collaboration/` | 5 | 271 | Collaboration profiles |
| `learn_more/` | 1 | 72 | Learn-more commands |
| `extension.ts` | 1 | 148 | `activate` / `deactivate` |

<details><summary>Full current tree: folder → direct files / lines (subtree files / lines)</summary>

```text
src/  1 files 148 lines (subtree 332 / 48005)
  active_servers/  0 files 0 lines (subtree 10 / 2049)
    commands/  1 files 265 lines (subtree 1 / 265)
    model/  1 files 85 lines (subtree 1 / 85)
    registry/  1 files 307 lines (subtree 1 / 307)
    runtime/  1 files 288 lines (subtree 1 / 288)
    services/  4 files 383 lines (subtree 4 / 383)
    views/  0 files 0 lines (subtree 2 / 721)
      interactions/  2 files 721 lines (subtree 2 / 721)
  babia_examples/  0 files 0 lines (subtree 6 / 1021)
    commands/  1 files 170 lines (subtree 1 / 170)
    model/  1 files 111 lines (subtree 1 / 111)
    runtime/  1 files 279 lines (subtree 1 / 279)
    views/  1 files 146 lines (subtree 3 / 461)
      interactions/  1 files 161 lines (subtree 1 / 161)
      items/  1 files 154 lines (subtree 1 / 154)
  babia_templates/  0 files 0 lines (subtree 9 / 2222)
    charts/  2 files 656 lines (subtree 2 / 656)
    models/  1 files 84 lines (subtree 1 / 84)
    processing/  3 files 877 lines (subtree 5 / 1391)
      placeholders/  2 files 514 lines (subtree 2 / 514)
    registry/  1 files 91 lines (subtree 1 / 91)
  code_analysis/  0 files 0 lines (subtree 166 / 21453)
    commands/  1 files 81 lines (subtree 35 / 2400)
      clean_analysis/  1 files 95 lines (subtree 1 / 95)
      directory_analysis/  5 files 370 lines (subtree 5 / 370)
      dom_visualization/  2 files 59 lines (subtree 2 / 59)
      file_analysis/  4 files 134 lines (subtree 4 / 134)
      subsections/  1 files 12 lines (subtree 22 / 1661)
        active_analyses/  1 files 33 lines (subtree 1 / 33)
        analysis_settings/  2 files 334 lines (subtree 18 / 1318)
          analysis_directory_mode/  2 files 66 lines (subtree 2 / 66)
          analysis_file_mode/  2 files 60 lines (subtree 2 / 60)
          auto_analysis_delay/  2 files 180 lines (subtree 2 / 180)
          auto_analysis_enabled/  2 files 66 lines (subtree 2 / 66)
          chart_type_directory/  1 files 56 lines (subtree 1 / 56)
          chart_type_file/  1 files 56 lines (subtree 1 / 56)
          dimension_mapping_directory/  1 files 41 lines (subtree 1 / 41)
          dimension_mapping_file/  1 files 41 lines (subtree 1 / 41)
          profile_configuration/  2 files 348 lines (subtree 2 / 348)
          view_theme/  2 files 70 lines (subtree 2 / 70)
        files_by_language/  1 files 106 lines (subtree 1 / 106)
        project_by_language/  1 files 192 lines (subtree 1 / 192)
    configuration/  2 files 451 lines (subtree 4 / 654)
      models/  2 files 203 lines (subtree 2 / 203)
    dependencies/  3 files 325 lines (subtree 3 / 325)
    engine/  1 files 163 lines (subtree 56 / 6798)
      components/  0 files 0 lines (subtree 23 / 785)
        customComponents/  23 files 785 lines (subtree 23 / 785)
      core/  2 files 488 lines (subtree 2 / 488)
      launchers/  4 files 583 lines (subtree 4 / 583)
      parsers/  4 files 909 lines (subtree 4 / 909)
      processors/  2 files 301 lines (subtree 2 / 301)
      servers/  3 files 548 lines (subtree 4 / 595)
        models/  1 files 47 lines (subtree 1 / 47)
      utils/  5 files 955 lines (subtree 5 / 955)
      watchers/  11 files 2019 lines (subtree 11 / 2019)
    export/  8 files 2238 lines (subtree 8 / 2238)
    historical/  12 files 3053 lines (subtree 12 / 3053)
    refresh/  3 files 543 lines (subtree 3 / 543)
    services/  4 files 855 lines (subtree 4 / 855)
    utils/  2 files 292 lines (subtree 2 / 292)
    views/  2 files 198 lines (subtree 39 / 4295)
      interactions/  2 files 68 lines (subtree 2 / 68)
      items/  2 files 45 lines (subtree 2 / 45)
      subsections/  1 files 9 lines (subtree 33 / 3984)
        active_analyses/  0 files 0 lines (subtree 2 / 1256)
          commands/  1 files 783 lines (subtree 1 / 783)
          services/  1 files 473 lines (subtree 1 / 473)
        analysis_settings/  2 files 269 lines (subtree 26 / 2358)
          analysis_directory_mode/  2 files 187 lines (subtree 2 / 187)
          analysis_file_mode/  2 files 111 lines (subtree 2 / 111)
          auto_analysis_delay/  2 files 191 lines (subtree 2 / 191)
          auto_analysis_enabled/  2 files 127 lines (subtree 2 / 127)
          chart_type_directory/  2 files 111 lines (subtree 2 / 111)
          chart_type_file/  2 files 127 lines (subtree 2 / 127)
          chart_type_shared/  1 files 113 lines (subtree 1 / 113)
          dimension_mapping_directory/  2 files 61 lines (subtree 2 / 61)
          dimension_mapping_file/  2 files 284 lines (subtree 2 / 284)
          dimension_mapping_shared/  1 files 303 lines (subtree 1 / 303)
          files_by_language_sorting/  2 files 159 lines (subtree 2 / 159)
          profile_configuration/  2 files 191 lines (subtree 2 / 191)
          view_theme/  2 files 124 lines (subtree 2 / 124)
        files_by_language/  2 files 220 lines (subtree 2 / 220)
        project_by_language/  2 files 141 lines (subtree 2 / 141)
  collaboration/  1 files 4 lines (subtree 5 / 271)
    model/  3 files 122 lines (subtree 3 / 122)
    services/  1 files 145 lines (subtree 1 / 145)
  commands/  1 files 56 lines (subtree 14 / 531)
    active_servers/  1 files 12 lines (subtree 1 / 12)
    analysis/  2 files 84 lines (subtree 2 / 84)
    babia_examples/  1 files 11 lines (subtree 1 / 11)
    collaboration/  1 files 158 lines (subtree 1 / 158)
    common/  1 files 46 lines (subtree 1 / 46)
    learn_more/  1 files 9 lines (subtree 1 / 9)
    python_env/  1 files 24 lines (subtree 1 / 24)
    servers/  1 files 81 lines (subtree 1 / 81)
    shared/  2 files 32 lines (subtree 2 / 32)
    visualization_settings/  1 files 9 lines (subtree 1 / 9)
    visualize_data/  1 files 9 lines (subtree 1 / 9)
  core/  1 files 43 lines (subtree 4 / 298)
    logging/  2 files 151 lines (subtree 2 / 151)
    startup/  1 files 104 lines (subtree 1 / 104)
  learn_more/  0 files 0 lines (subtree 1 / 72)
    commands/  1 files 72 lines (subtree 1 / 72)
  python_env/  0 files 0 lines (subtree 7 / 2088)
    commands/  1 files 322 lines (subtree 1 / 322)
    runtime/  3 files 990 lines (subtree 3 / 990)
    storage/  1 files 229 lines (subtree 1 / 229)
    utils/  1 files 267 lines (subtree 1 / 267)
    views/  0 files 0 lines (subtree 1 / 280)
      items/  1 files 280 lines (subtree 1 / 280)
  remote_access/  1 files 4 lines (subtree 5 / 1483)
    model/  1 files 47 lines (subtree 1 / 47)
    security/  1 files 631 lines (subtree 1 / 631)
    services/  2 files 801 lines (subtree 2 / 801)
  servers/  0 files 0 lines (subtree 44 / 8632)
    commands/  1 files 377 lines (subtree 1 / 377)
    runtime/  12 files 2396 lines (subtree 38 / 7431)
      analysis/  6 files 1396 lines (subtree 6 / 1396)
      broadcast/  4 files 820 lines (subtree 4 / 820)
      collaboration/  7 files 1425 lines (subtree 7 / 1425)
      http/  2 files 274 lines (subtree 2 / 274)
      remote/  4 files 516 lines (subtree 4 / 516)
      sse/  2 files 543 lines (subtree 2 / 543)
      ws/  1 files 61 lines (subtree 1 / 61)
    storage/  1 files 360 lines (subtree 1 / 360)
    utils/  1 files 132 lines (subtree 1 / 132)
    views/  0 files 0 lines (subtree 3 / 332)
      interactions/  2 files 308 lines (subtree 2 / 308)
      items/  1 files 24 lines (subtree 1 / 24)
  utils/  12 files 1038 lines (subtree 12 / 1038)
  views/  3 files 644 lines (subtree 32 / 3467)
    active_servers/  2 files 216 lines (subtree 3 / 750)
      items/  1 files 534 lines (subtree 1 / 534)
    babia_examples/  2 files 92 lines (subtree 4 / 391)
      interactions/  1 files 155 lines (subtree 1 / 155)
      items/  1 files 144 lines (subtree 1 / 144)
    collaboration/  2 files 33 lines (subtree 3 / 112)
      items/  1 files 79 lines (subtree 1 / 79)
    common/  2 files 150 lines (subtree 2 / 150)
    learn_more/  2 files 60 lines (subtree 4 / 181)
      interactions/  1 files 23 lines (subtree 1 / 23)
      items/  1 files 98 lines (subtree 1 / 98)
    python_env/  2 files 53 lines (subtree 2 / 53)
    servers/  2 files 105 lines (subtree 3 / 255)
      items/  1 files 150 lines (subtree 1 / 150)
    visualization_settings/  2 files 128 lines (subtree 4 / 393)
      interactions/  1 files 160 lines (subtree 1 / 160)
      items/  1 files 105 lines (subtree 1 / 105)
    visualize_data/  2 files 158 lines (subtree 4 / 538)
      interactions/  1 files 188 lines (subtree 1 / 188)
      items/  1 files 192 lines (subtree 1 / 192)
  visualization_settings/  1 files 19 lines (subtree 9 / 1512)
    commands/  1 files 47 lines (subtree 1 / 47)
    model/  1 files 166 lines (subtree 1 / 166)
    storage/  1 files 212 lines (subtree 1 / 212)
    utils/  3 files 515 lines (subtree 3 / 515)
    views/  0 files 0 lines (subtree 2 / 553)
      interactions/  1 files 421 lines (subtree 1 / 421)
      items/  1 files 132 lines (subtree 1 / 132)
  visualize_data/  0 files 0 lines (subtree 7 / 1720)
    commands/  1 files 96 lines (subtree 1 / 96)
    model/  1 files 112 lines (subtree 1 / 112)
    runtime/  1 files 217 lines (subtree 1 / 217)
    state/  1 files 421 lines (subtree 1 / 421)
    views/  0 files 0 lines (subtree 3 / 874)
      interactions/  1 files 473 lines (subtree 1 / 473)
      items/  2 files 401 lines (subtree 2 / 401)
```
</details>

### 1.2 Shape metrics

| Metric | Now | Target |
|---|---:|---:|
| Files / lines | 332 / 48,005 | 285 / 47,636 (−47 barrels, −369 lines) |
| Folders (including `src/`) | 169 | 99 |
| snake_case / camelCase / kebab-case folder names | 56 / 1 / 0 | 0 / 0 / 23 (all others are single words) |
| Leaf folders that hold exactly one file | 68 | 8 (canonical names only: `commands/`, `services/`, `model/`, `startup/`, `tree/`, `webview/`, `ws/`) |
| `index.ts` barrels | 49 | 0 |
| Maximum folder depth under `src/` | 5 | 5 |
| Two-way pairs between top-level units | 15 | 6: five inside `core/`, one formed by the upward edge (§3.5) |

## 2. Problems

### 2.1 One feature, three places

Each sidebar section is split between a layer folder and a feature folder, so finding "the examples feature" means opening three trees:

| Feature | Implementation | Sidebar adapter | Command wrapper |
|---|---|---|---|
| Active servers | `active_servers/{commands,model,registry,runtime,services,views/interactions}` | `views/active_servers/{ActiveServersSectionProvider.ts,items/}` | `commands/active_servers/activeServersCommands.ts` |
| Examples | `babia_examples/{commands,model,runtime,views/{interactions,items}}` | `views/babia_examples/{…,interactions/,items/}` | `commands/babia_examples/babiaExamplesCommands.ts` |
| Visualize data | `visualize_data/{commands,model,runtime,state,views/{interactions,items}}` | `views/visualize_data/{…,interactions/,items/}` | `commands/visualize_data/visualizeDataCommands.ts` |
| Visualization settings | `visualization_settings/{commands,model,storage,utils,views/{interactions,items}}` | `views/visualization_settings/{…}` | `commands/visualization_settings/…` |
| Python env | `python_env/{commands,runtime,storage,utils,views/items}` | `views/python_env/PythonEnvSectionProvider.ts` | `commands/python_env/pythonEnvCommands.ts` |
| Servers | `servers/{commands,storage,utils,views/{interactions,items}}` | `views/servers/{…}` | `commands/servers/serverCommands.ts` |
| Learn more | `learn_more/commands/` | `views/learn_more/{…}` | `commands/learn_more/learnMoreCommands.ts` |
| Collaboration | `collaboration/{model,services}` | `views/collaboration/{…}` | `commands/collaboration/collaborationCommands.ts` (the real implementation, not a wrapper) |
| Analysis | `code_analysis/**` | `code_analysis/views/**` (its own; only `views/index.ts` re-exports it) | `commands/analysis/AnalysisCommands.ts` (holds the "run last analysis" logic) |

Inside the analysis feature the same split repeats one level down: each of the 11 analysis settings has its tree item in `code_analysis/views/subsections/analysis_settings/<setting>/` and its commands in `code_analysis/commands/subsections/analysis_settings/<setting>/`, 44 files in two mirrored trees (18 + 26), each with its own `index.ts`.

The split creates **10 pairs of files with the same basename**: `activeServersCommands.ts`, `babiaExamplesCommands.ts`, `learnMoreCommands.ts`, `pythonEnvCommands.ts`, `serverCommands.ts`, `visualizationSettingsCommands.ts`, `visualizeDataCommands.ts` (feature module + wrapper), `visualizationSettingsItems.ts` and `visualizeDataItems.ts` (feature items + sidebar adapter), and `activeAnalysesCommands.ts` (`code_analysis/commands/subsections/active_analyses/` and `code_analysis/views/subsections/active_analyses/commands/`, **two classes both named `ActiveAnalysesCommands`**). `commands/analysis/AnalysisCommands.ts` and `code_analysis/commands/analysisCommands.ts` differ only by the case of one letter. The examples feature also has two click handlers (`babia_examples/views/interactions/handleExampleClicks.ts`, `views/babia_examples/interactions/handleBabiaExampleClicks.ts`) and two item factories (`exampleItems.ts`, `babiaExampleItems.ts`). That is a duplication to record for 1.3.0, not something a move should merge.

### 2.2 Naming

- 55 snake_case folders (`active_servers`, `code_analysis`, `analysis_directory_mode`, …) beside one camelCase folder (`code_analysis/engine/components/customComponents`) and single-word ones. The backend uses snake_case because Python packages must; TypeScript has no such constraint.
- Generic folder names that say nothing about their content: `utils/` (12 files, §2.6), `code_analysis/engine/core/` (the session registry), `code_analysis/services/` (a schema client, a snapshot service and a server-watcher integration, three unrelated things), `servers/runtime/` (all of the server).
- The top-level `core/` holds the bootstrap (context, logger, startup coordinator), not domain logic. Host-boundary and #13 mean the reusable engine when they say "core".

### 2.3 Folders that hold one file

68 leaf folders hold exactly one file, and 35 more hold one file plus its `index.ts`. Examples of the first kind: `active_servers/{model,registry,runtime}/`, `babia_examples/{commands,model,runtime}/`, `babia_templates/{models,registry}/`, `learn_more/commands/`, `python_env/{commands,storage,utils,views/items}/`, `servers/{commands,storage,utils}/`, `visualize_data/{commands,model,runtime,state}/`. All but one of the per-setting folders of §2.1 are one of the two kinds. `learn_more/` is a top-level folder for one 72-line file.

### 2.4 Barrels

49 `index.ts` files. 47 only re-export, and 23 of those have exactly one importer. `code_analysis/commands/subsections/analysis_settings/analysis_file_mode/index.ts` is imported by **25 files across the analysis commands**, only to reach the `CommandRegistration` type that `analysisFileModeCommands.ts` re-exports: a reach-in through an unrelated setting's folder. The barrels `remote_access/index.ts` and `collaboration/index.ts` (12 importers each) are what makes `servers/runtime/*` look dependent on the remote-access and collaboration *services*, when the server only uses `RemoteSessionAuthority` and the profile model (#42 item 1). `views/index.ts` re-exports every section with `export *`.

### 2.5 Deep reach-ins and misplaced files

- 188 relative imports climb 3 or more levels (`../../../`). 56 climb 4 or more, and all 56 come from 27 files under `code_analysis/{views,commands}/subsections/`.
- Files whose importers all live in **one other** folder (measured by `misplaced`, appendix A.3):

| File | Only importer folder | Target |
|---|---|---|
| `utils/sha256Generator.ts` | `code_analysis` (7) | `shared/` (generic, kept shared) |
| `utils/languageMetadata.ts`, `utils/supportedLanguages.ts` | `code_analysis` | `core/analysis/languages/` |
| `utils/uriPathConverter.ts` | `code_analysis/commands/dom_visualization` | `features/analysis/commands/dom/` |
| `utils/jsonFieldAnalyzer.ts` | `visualize_data` | `features/visualize-data/services/` |
| `utils/getVisualizationConfiguration.ts` | `babia_templates` (3) | `core/charts/` |
| `utils/commandBuilder.ts` | `commands` | `platform/commands/` |
| `servers/runtime/previewRenderer.ts` | `active_servers/services` | `features/active-servers/services/` |
| `active_servers/services/serverRegistrar.ts` | `servers/runtime` | `core/server/registry/` |
| `servers/views/interactions/launchNotifications.ts` | `servers/runtime` (`multiServerLauncher`) | `features/active-servers/views/` (and the upward edge stays on #42's list) |
| `python_env/views/items/pythonEnvItems.ts` | `views` | `features/python-env/views/` |
| `visualize_data/views/items/{visualizeDataItems,visualizationItem}.ts` | `views/visualize_data` | `features/visualize-data/views/` |
| `code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.ts` | a command module under `views/` | `features/analysis/sections/active-analyses/` |
| `visualize_data/views/interactions/visualizationLauncher.ts` | a 473-line launcher filed as a click handler | `features/visualize-data/services/` |
| `code_analysis/services/xrFieldSchemaService.ts` | the Python schema client, filed beside unrelated services | `core/analysis/python/` |

### 2.6 `utils/` is a grab-bag

12 files, one consumer area each, no common theme: two hash/nonce helpers, two language tables, a URI converter, a JSON field analyzer, the file↔server map, the visualization-config reader, the command builder, the error handler, a detail dialog, and `commonCommands.ts` (which holds the tree provider so it can refresh it). In the target, each file goes to the layer that matches what it does: `shared/` (2), `platform/` (3), `core/` (4), `features/` (2), `app/` (1).

### 2.7 Folder cycles

Measured on import edges (`misplaced`, appendix A.3), there are 15 two-way pairs between top-level folders: `active_servers↔commands`, `active_servers↔remote_access`, `active_servers↔servers`, `active_servers↔code_analysis`, `babia_examples↔commands`, `babia_templates↔code_analysis`, `code_analysis↔servers`, `code_analysis↔views`, `collaboration↔remote_access`, `commands↔utils`, `commands↔{learn_more,python_env,visualization_settings,visualize_data}`, `remote_access↔servers`. `host-boundary.md` §4 counts 9, because it does not count the `commands/shared` back-edges separately. Seven of the 15 exist only because a feature folder and its `commands/<feature>` wrapper import each other through `commands/shared`, and the move removes them. The rest are #42's work (§3.5).

## 3. Target tree

### 3.1 Five areas, one direction

```text
src/
├── extension.ts      activate/deactivate (unchanged: webpack entry, 43 test files name it)
├── app/              composition root: registers every command, builds the sidebar, runs startup
├── features/         one folder per user-facing feature: its commands and its sidebar section
├── core/             the engine the features drive: analysis, charts, server, history, export, …
├── platform/         VS Code adapters with no feature knowledge (context, logger, command plumbing, tree contract, webview panels, dialogs)
└── shared/           helpers with no VS Code and no domain (nonce, sha256)
```

**Dependency rule** (what #42's direction test should pin): `app → features → core → platform → shared`, never upward. A feature never imports another feature (one allow-listed exception, §3.5). Inside `core/`, subsystems may import each other, but #42 fixes an order and removes the cycles.

**Placement rule.** It decides every row of the move map and is the rule for new code:

1. Registers a command or renders a tree item → `features/<feature>/`.
2. State or logic that a second feature, the server or the analysis engine needs (registries, settings stores, profile stores, the venv, the remote-session authority) → `core/<subsystem>/`. This is why the active-server *registry* is in `core/server/registry/` while the active-server *tree* is in `features/active-servers/`.
3. A VS Code adapter that knows no feature → `platform/`.
4. No VS Code, no domain → `shared/`.
5. Wiring that needs every feature (command aggregation, the root tree provider, startup) → `app/`.

**Why this shape, and not a flat `features/<feature>/` holding everything:** the server, the analysis engine, the chart system and git history are not sidebar features. Three or more features use each of them (`core/server` is imported by analysis, examples, visualize-data, active-servers and servers), and they are the code that `packages/core` (story #13) will take. Putting them under one feature would make every other feature import that feature, which is the cross-feature tangle the move is meant to remove. Inside each feature the tree is **feature-first**: `commands/`, `views/`, `services/`, `model/`, created only when needed. The analysis feature adds `sections/<subsection>/`, where the tree item and the commands of one subsection or setting sit together.

**`packages/core` readiness (no host ports designed here):** after the move, 54 of the 153 files in `core/` import `vscode` (35%), compared with 106 of the 113 in `features/` (94%). So `core/` is the extraction candidate, folder by folder: `core/history` (3 of 11 import vscode), `core/export` (1 of 8), `core/server` (11 of 44) and `core/charts` (5 of 13) come first. Removing the remaining `vscode` imports is #13's work.

### 3.2 Naming convention

- **Folders: kebab-case** (`active-servers`, `python-env`, `session-servers`), and single words wherever a single word is honest (`charts`, `history`, `server`). Why kebab-case:
  1. It is the convention of npm package names. The `packages/*` workspaces `core/` will feed must be lowercase, so `core/history` → `packages/core/src/history` keeps its name.
  2. It cannot differ only by letter case, so it avoids case-only renames, which fail silently on the case-insensitive file systems of macOS and Windows (CI runs both).
  3. It reads as different from the snake_case Python backend, so `backend/src/utils` and `src/core/analysis` are never mistaken for each other in grep output.
  
  camelCase would also work. snake_case is what the tree already mixes.
- **Files: unchanged** (camelCase modules; PascalCase where the file is one class: `ModularTreeDataProvider.ts`, `SSEManager.ts`). Renaming files would multiply the text pins (§5.3) for no structural gain. The 13 exceptions, all forced:

| Old | New name | Why |
|---|---|---|
| `commands/index.ts` | `app/commands/registerAllCommands.ts` | an `index.ts` that holds code |
| `servers/runtime/index.ts` | `core/server/launchServerWithFile.ts` | same (holds `launchServerWithFile`) |
| `commands/<feature>/<x>Commands.ts` (8) | `features/<feature>/commands/<x>CommandRegistrations.ts` | collides with the feature's own `<x>Commands.ts`; the wrapper exports `get<X>CommandRegistrations` |
| `code_analysis/commands/subsections/active_analyses/activeAnalysesCommands.ts` | `…/active-analyses/activeAnalysesCommandRegistrations.ts` | collides with the 783-line module of the same name |
| `views/visualization_settings/items/visualizationSettingsItems.ts` | `…/views/visualizationSettingsSectionItems.ts` | collides with the feature's item factory |
| `views/visualize_data/items/visualizeDataItems.ts` | `…/views/visualizeDataSectionItems.ts` | same |

(`commands/collaboration/collaborationCommands.ts` is the real implementation and keeps its name.)

- **No `index.ts`.** Import the concrete file (existing barrel policy).
- **Canonical sub-folders inside a feature:** `commands/` (command modules and the registration wrapper), `views/` (section provider, tree items, click handlers, view helpers), `services/` (launchers, restorers, analyzers), `model/` (types and state). No `utils/`, `runtime/`, `interactions/` or `items/` level: they were one file deep in 30 places.

### 3.3 Full target tree

Files per folder in brackets. The full list is the move map (§4).

```text
src/
├── extension.ts
├── app/
│   ├── commands/           [2]  registerAllCommands.ts, generalCommands.ts
│   ├── sidebar/            [4]  ModularTreeDataProvider.ts, sectionDefinitions.ts, sectionChild.ts, commonCommands.ts
│   └── startup/            [1]  startupCoordinator.ts
├── features/
│   ├── active-servers/
│   │   ├── commands/       [2]  activeServersCommands.ts, activeServersCommandRegistrations.ts
│   │   ├── services/       [3]  previewRenderer.ts, serverOpenActions.ts, withServer.ts
│   │   └── views/          [5]  ActiveServersSectionProvider.ts, activeServerItems.ts, handleServerActions.ts, serverDetailsFormat.ts, launchNotifications.ts
│   ├── analysis/
│   │   ├── commands/       [3]  analysisCommands.ts, analysisCommandRegistrations.ts, cleanAnalysisCommands.ts
│   │   │   ├── directory/  [4]  directory/project analysis (XR, LivePanel)
│   │   │   ├── dom/        [2]  domVisualizationCommands.ts, uriPathConverter.ts
│   │   │   └── file/       [3]  file analysis (XR, LivePanel)
│   │   ├── sections/
│   │   │   ├── active-analyses/     [3]  commands, data service, registrations
│   │   │   ├── files-by-language/   [2]  subsection provider + commands
│   │   │   ├── project-by-language/ [2]  subsection provider + commands
│   │   │   └── settings/            [4]  provider, settings commands, shared chart-type and dimension-mapping cores
│   │   │       ├── analysis-directory-mode/  analysis-file-mode/  auto-analysis-delay/  auto-analysis-enabled/
│   │   │       ├── chart-type-directory/  chart-type-file/  dimension-mapping-directory/  dimension-mapping-file/
│   │   │       └── files-by-language-sorting/  profile-configuration/  view-theme/     [2–3 each: tree item + commands]
│   │   ├── services/       [1]  serverWatcherIntegration.ts
│   │   ├── views/          [3]  AnalysisSectionProvider.ts, analysisItems.ts, handleAnalysisClicks.ts
│   │   └── workspace/      [3]  workspaceSnapshotService.ts, workspaceSnapshotModel.ts, workspaceFileScanner.ts
│   ├── collaboration/
│   │   ├── commands/       [1]  collaborationCommands.ts
│   │   └── views/          [2]  CollaborationSectionProvider.ts, collaborationItems.ts
│   ├── examples/
│   │   ├── commands/       [2]   model/ [1]   services/ [1] exampleLauncher.ts
│   │   └── views/          [6]  section provider, tree view, two item factories, two click handlers
│   ├── learn-more/         commands/ [2]  views/ [3]
│   ├── python-env/         commands/ [2]  views/ [2]
│   ├── servers/            commands/ [2]  views/ [4]
│   ├── visualization-settings/  commands/ [2]  views/ [7]
│   └── visualize-data/     commands/ [2]  model/ [2]  services/ [3]  views/ [5]
├── core/
│   ├── analysis/           [1]  analysisOrchestrator.ts
│   │   ├── configuration/  [2]   languages/ [2]   launchers/ [4]   parsers/ [4]   processors/ [2]
│   │   ├── python/         [3]  executePython.ts, backendScriptPath.ts, xrFieldSchemaService.ts
│   │   ├── refresh/        [2]   scene-assets/ [22]  (was engine/components/customComponents)
│   │   ├── session/        [2]   session-servers/ [4]   utils/ [3]   watchers/ [11]
│   ├── charts/             [5]  chartModels.ts, chartRegistry.ts, chartPresentation.ts, templateCharts.ts, getVisualizationConfiguration.ts
│   │   ├── processing/     [3]  └── placeholders/ [2]
│   │   └── settings/       [4]  settingsModel.ts, settingsStorage.ts, settingsFile.ts, settingsAccessors.ts
│   ├── collaboration/      [4]  profile model, anonymous names, participants, profile manager
│   ├── dependencies/       [2]
│   ├── export/             [8]
│   ├── history/            [11] (was code_analysis/historical)
│   ├── python-env/         [5]  venvManager.ts, pythonEnvStorage.ts, pythonEnvUtils.ts, pythonEnvUiState.ts, pythonPackageManifest.ts
│   ├── remote-access/      [4]  remoteAccessModel.ts, remoteSessionAuthority.ts, cloudflaredBinaryManager.ts, remoteAccessManager.ts
│   └── server/             [15] httpServer.ts, https*.ts, serverFactory.ts, multiServerLauncher.ts, portManager.ts, serverControl.ts, serverSettingsManager.ts, fileToServerMap.ts, networkUtils.ts, …
│       ├── analysis/       [6]   broadcast/ [4]   collaboration/ [7]   http/ [2]
│       ├── registry/       [3]  activeServerModel.ts, activeServerRegistry.ts, serverRegistrar.ts
│       └── remote/         [4]   sse/ [2]   ws/ [1]
├── platform/               [1]  extensionContext.ts
│   ├── commands/           [2]  commandRegistry.ts, commandBuilder.ts
│   ├── logging/            [3]  logger.ts, logPolicy.ts, sink.ts
│   ├── tree/               [1]  baseInterfaces.ts
│   ├── ui/                 [2]  detailDialog.ts, errorHandler.ts
│   └── webview/            [1]  panelManager.ts
└── shared/                 [1]  nonceGenerator.ts (sha256Generator.ts: core/analysis/utils, §4.1)
```

Notes on choices that are not obvious:

- **`servers/runtime/` becomes `core/server/` with its sub-folders unchanged.** The files that build a template path from `__dirname` (`httpServer.ts`, `httpsServerBase.ts`, `serverFactory.ts`: `path.join(__dirname, '../../../templates')`) stay **two levels below `src/`**, so the fallback still resolves to `<extension>/templates` from `out/`. If #42 lands `resolveTemplatePath()` first, that constraint disappears. Until then, moving any of the three files to another depth breaks the unbundled layout the tests run.
- **`active_servers/runtime/serverControl.ts` → `core/server/serverControl.ts`** and **`active_servers/services/panelManager.ts` → `platform/webview/panelManager.ts`.** `serverWatcherIntegration` (analysis) and `extension.ts` need server control, so it cannot live in a feature without a cross-feature edge. The panel manager is a plain `serverId → WebviewPanel` registry with no feature knowledge.
- **Remote access is all `core/`.** It has no sidebar section of its own: three features (servers, active servers, collaboration) and the server use it.
- **The Python venv is `core/python-env/`**, because `executePython.ts` and `gitRevisionExporter.ts` need it (host-boundary §4). `features/python-env/` keeps only its commands and tree.
- **The visualization-settings store is `core/charts/settings/`**, because `core/charts/getVisualizationConfiguration.ts` reads it. Today it does so through a lazy `require('../visualization_settings')` of the whole barrel (tree items included). After the move the `require` targets `settingsAccessors.ts` directly. Keep it lazy and keep it a `require` until #42 decides on that cycle.
- **`commands/shared/commandRegistry.ts` → `platform/commands/`** (story #42 item 6 under the new names). 18 files import it through its barrel today. Every feature can import `platform/`, so the seven `commands↔<feature>` cycles disappear.
- **The 8 lazy `require()` calls in `ModularTreeDataProvider.ts` stay lazy `require()` calls** (cleanup skill §4). Only their specifier strings change, and the codemod rewrites `require()` specifiers like imports. #40 reshaped this file (PR #57); the eight `require()` calls survived it.

### 3.4 Interplay with concurrent and later stories

| Story | What it changes in `src/` | Consequence for the move |
|---|---|---|
| #34 logging | `console.*` → logger in almost every file (1,401 calls) | Run the move **after** it merges: a move first would turn #34's hundreds of hunks into rename conflicts. |
| #35 pipeline / export / settings | `executePython.ts`, `exportManifest.ts`, settings storage | Move after it. The map rows stand, unless #35 splits files; new files go where their parent goes (§3.1 rule). |
| #40 data-driven tree + scene assets | **Merged (PR #57) while this analysis ran; the numbers here include it.** New `views/sectionDefinitions.ts`, `views/common/sectionChild.ts`, `customComponents/singleFileRuntimeAssets.ts`, `analysis_settings/chart_type_shared/sharedChartTypeSettingCore.ts` | Mapped. `sectionChild.ts` goes to `app/sidebar/`, not `platform/tree/`: it is the union of every section's item type, so it imports eight features. |
| #42 layering | barrel imports in `servers/runtime/*`, `activeServerRegistry` emitter, `resolveTemplatePath()`, `commandRegistry` move, folder-direction test | Its direction test should read the layer list of §3.1 from **one data file** (e.g. `test/tooling/layers.json`), so the move updates data instead of test code. Its cycle fixes should target the five `core/` pairs of §3.5. |
| #13 host ports (epic #11) | not started | Nothing here designs ports. `core/` is the set of folders a port would cut off. |

### 3.5 Dependency check after the move

`symedges` + `layers` (appendix A.4) apply the move map to today's import graph. Each import through a dissolved barrel is resolved to the file that declares the imported name. Result:

- **Upward edges (lower layer imports higher): 1.** `core/server/multiServerLauncher.ts` → `features/active-servers/views/launchNotifications.ts`, the post-launch toasts. It is already #42 item 5 / #39. Allow-list it with that reference.
- **Cross-feature edges: 1 pair.** `features/active-servers/views/{ActiveServersSectionProvider,activeServerItems}.ts` → `features/collaboration/views/*`. The COLLABORATION group is nested inside ACTIVE SERVERS by design (ARCHITECTURE "Activation flow" §3). Allow-list it, or move the two collaboration view files under `features/active-servers/views/collaboration/` if the maintainer prefers zero exceptions.
- **Two-way pairs inside `core/`: 5.** `analysis↔charts` (11/2), `analysis↔server` (6/11), `analysis↔history` (2/9), `collaboration↔remote-access` (1/4), `remote-access↔server` (3/10). The tool also reports `core/server↔features/active-servers` (1/17), which is the upward edge above seen from both sides. These are #42's to break. The move neither creates nor hides them: it renames them.

## 4. Move map

Every `.ts` file under `src/` (337 after the refresh of §4.1), relative to `src/`. **B0** = re-export barrel, dissolved in batch 0 (its importers are retargeted to the declaring files, the barrel is deleted). **—** = stays. The batch numbers refer to §5.

### 4.1 Refresh before the move (2026-11-25, on `v1.2.1` at `41cfc523`)

The map was re-generated on the tree as it stands after #34, #35, #42 and #56 (337 files, 49,226 lines). Rows that changed:

- **Already at their destination (#42), now `—`:** `platform/commands/commandRegistry.ts`, `platform/tree/baseInterfaces.ts`, and the new `platform/templatePaths.ts`. The `commands/shared/index.ts` barrel is already gone, so batch 0 dissolves 46 barrels, not 47.
- **New files, placed by the §3.1 rule next to the file they were split from:** `core/logging/sink.ts` → `platform/logging/` (B1, with `logger.ts`), `visualization_settings/storage/settingsFile.ts` → `core/charts/settings/` (B4, with `settingsStorage.ts`), `babia_templates/models/xrFieldModels.ts` → `core/charts/` (B7, with `chartModels.ts`), `code_analysis/engine/utils/pythonStderrStream.ts` → `core/analysis/python/` (B12, with `executePython.ts`), `…/chart_type_shared/chartTypeCommandFactory.ts` → `features/analysis/sections/settings/` (B13, with `sharedChartTypeSettingCore.ts`).
- **Changed destination:** `utils/sha256Generator.ts` → `core/analysis/utils/` (B12) instead of `shared/`. #34 gave it a logger, so in `shared/` it would import `platform/` (an upward edge); all seven importers are in the analysis engine.

Re-measured with A.4 on the refreshed map: **one upward edge** (`core/server/multiServerLauncher.ts` → `features/active-servers/views/launchNotifications.ts`), **one cross-feature pair** (`active-servers` → `collaboration`), and three two-way pairs inside `core/` (`analysis↔server` 6/12, `analysis↔history` 2/9, `remote-access↔server` 3/10; #42 broke `analysis↔charts` and `collaboration↔remote-access`). Target shape (A.7 with the map): 291 files, 99 folders, 0 snake_case, 0 barrels.

| Old (`src/…`) | New (`src/…`) | Batch |
|---|---|---|
| `active_servers/commands/activeServersCommands.ts` | `features/active-servers/commands/activeServersCommands.ts` | B10 |
| `active_servers/model/activeServerModel.ts` | `core/server/registry/activeServerModel.ts` | B9 |
| `active_servers/registry/activeServerRegistry.ts` | `core/server/registry/activeServerRegistry.ts` | B9 |
| `active_servers/runtime/serverControl.ts` | `core/server/serverControl.ts` | B9 |
| `active_servers/services/panelManager.ts` | `platform/webview/panelManager.ts` | B1 |
| `active_servers/services/serverOpenActions.ts` | `features/active-servers/services/serverOpenActions.ts` | B10 |
| `active_servers/services/serverRegistrar.ts` | `core/server/registry/serverRegistrar.ts` | B9 |
| `active_servers/services/withServer.ts` | `features/active-servers/services/withServer.ts` | B10 |
| `active_servers/views/interactions/handleServerActions.ts` | `features/active-servers/views/handleServerActions.ts` | B10 |
| `active_servers/views/interactions/serverDetailsFormat.ts` | `features/active-servers/views/serverDetailsFormat.ts` | B10 |
| `babia_examples/commands/babiaExamplesCommands.ts` | `features/examples/commands/babiaExamplesCommands.ts` | B6 |
| `babia_examples/model/babiaExampleModel.ts` | `features/examples/model/babiaExampleModel.ts` | B6 |
| `babia_examples/runtime/exampleLauncher.ts` | `features/examples/services/exampleLauncher.ts` | B6 |
| `babia_examples/views/babiaExamplesTreeView.ts` | `features/examples/views/babiaExamplesTreeView.ts` | B6 |
| `babia_examples/views/interactions/handleExampleClicks.ts` | `features/examples/views/handleExampleClicks.ts` | B6 |
| `babia_examples/views/items/exampleItems.ts` | `features/examples/views/exampleItems.ts` | B6 |
| `babia_templates/charts/chartPresentation.ts` | `core/charts/chartPresentation.ts` | B7 |
| `babia_templates/charts/templateCharts.ts` | `core/charts/templateCharts.ts` | B7 |
| `babia_templates/models/chartModels.ts` | `core/charts/chartModels.ts` | B7 |
| `babia_templates/models/xrFieldModels.ts` | `core/charts/xrFieldModels.ts` | B7 |
| `babia_templates/processing/dimensionValidator.ts` | `core/charts/processing/dimensionValidator.ts` | B7 |
| `babia_templates/processing/placeholders/createChart.ts` | `core/charts/processing/placeholders/createChart.ts` | B7 |
| `babia_templates/processing/placeholders/createStructure.ts` | `core/charts/processing/placeholders/createStructure.ts` | B7 |
| `babia_templates/processing/templateHTMLProcessor.ts` | `core/charts/processing/templateHTMLProcessor.ts` | B7 |
| `babia_templates/processing/templateProcessor.ts` | `core/charts/processing/templateProcessor.ts` | B7 |
| `babia_templates/registry/chartRegistry.ts` | `core/charts/chartRegistry.ts` | B7 |
| `code_analysis/commands/analysisCommands.ts` | `features/analysis/commands/analysisCommands.ts` | B13 |
| `code_analysis/commands/clean_analysis/cleanAnalysisCommands.ts` | `features/analysis/commands/cleanAnalysisCommands.ts` | B13 |
| `code_analysis/commands/directory_analysis/directoryAnalysisCommands.ts` | `features/analysis/commands/directory/directoryAnalysisCommands.ts` | B13 |
| `code_analysis/commands/directory_analysis/directoryAnalysisLivePanelCommands.ts` | `features/analysis/commands/directory/directoryAnalysisLivePanelCommands.ts` | B13 |
| `code_analysis/commands/directory_analysis/directoryAnalysisXRCommands.ts` | `features/analysis/commands/directory/directoryAnalysisXRCommands.ts` | B13 |
| `code_analysis/commands/directory_analysis/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/commands/directory_analysis/projectAnalysisCommands.ts` | `features/analysis/commands/directory/projectAnalysisCommands.ts` | B13 |
| `code_analysis/commands/dom_visualization/domVisualizationCommands.ts` | `features/analysis/commands/dom/domVisualizationCommands.ts` | B13 |
| `code_analysis/commands/dom_visualization/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/commands/file_analysis/fileAnalysisCommands.ts` | `features/analysis/commands/file/fileAnalysisCommands.ts` | B13 |
| `code_analysis/commands/file_analysis/fileAnalysisLivePanelCommands.ts` | `features/analysis/commands/file/fileAnalysisLivePanelCommands.ts` | B13 |
| `code_analysis/commands/file_analysis/fileAnalysisXRCommands.ts` | `features/analysis/commands/file/fileAnalysisXRCommands.ts` | B13 |
| `code_analysis/commands/file_analysis/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/commands/subsections/active_analyses/activeAnalysesCommands.ts` | `features/analysis/sections/active-analyses/activeAnalysesCommandRegistrations.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/analysis_directory_mode/analysisDirectoryModeCommands.ts` | `features/analysis/sections/settings/analysis-directory-mode/analysisDirectoryModeCommands.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/analysis_directory_mode/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/commands/subsections/analysis_settings/analysis_file_mode/analysisFileModeCommands.ts` | `features/analysis/sections/settings/analysis-file-mode/analysisFileModeCommands.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/analysis_file_mode/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/commands/subsections/analysis_settings/analysisSettingsCommands.ts` | `features/analysis/sections/settings/analysisSettingsCommands.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/auto_analysis_delay/autoAnalysisDelayCommands.ts` | `features/analysis/sections/settings/auto-analysis-delay/autoAnalysisDelayCommands.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/auto_analysis_delay/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/commands/subsections/analysis_settings/auto_analysis_enabled/autoAnalysisEnabledCommands.ts` | `features/analysis/sections/settings/auto-analysis-enabled/autoAnalysisEnabledCommands.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/auto_analysis_enabled/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/commands/subsections/analysis_settings/chart_type_directory/chartTypeDirectoryCommands.ts` | `features/analysis/sections/settings/chart-type-directory/chartTypeDirectoryCommands.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/chart_type_file/chartTypeFileCommands.ts` | `features/analysis/sections/settings/chart-type-file/chartTypeFileCommands.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/chart_type_shared/chartTypeCommandFactory.ts` | `features/analysis/sections/settings/chartTypeCommandFactory.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/dimension_mapping_directory/dimensionMappingDirectoryCommands.ts` | `features/analysis/sections/settings/dimension-mapping-directory/dimensionMappingDirectoryCommands.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/dimension_mapping_file/dimensionMappingFileCommands.ts` | `features/analysis/sections/settings/dimension-mapping-file/dimensionMappingFileCommands.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/filesByLanguageSortingCommands.ts` | `features/analysis/sections/settings/files-by-language-sorting/filesByLanguageSortingCommands.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/profile_configuration/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/commands/subsections/analysis_settings/profile_configuration/profileConfigurationCommands.ts` | `features/analysis/sections/settings/profile-configuration/profileConfigurationCommands.ts` | B13 |
| `code_analysis/commands/subsections/analysis_settings/view_theme/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/commands/subsections/analysis_settings/view_theme/viewThemeCommands.ts` | `features/analysis/sections/settings/view-theme/viewThemeCommands.ts` | B13 |
| `code_analysis/commands/subsections/files_by_language/filesByLanguageCommands.ts` | `features/analysis/sections/files-by-language/filesByLanguageCommands.ts` | B13 |
| `code_analysis/commands/subsections/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/commands/subsections/project_by_language/projectByLanguageCommands.ts` | `features/analysis/sections/project-by-language/projectByLanguageCommands.ts` | B13 |
| `code_analysis/configuration/analysisConfigurationStorage.ts` | `core/analysis/configuration/analysisConfigurationStorage.ts` | B12 |
| `code_analysis/configuration/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/configuration/models/analysisConfiguration.ts` | `core/analysis/configuration/analysisConfiguration.ts` | B12 |
| `code_analysis/configuration/models/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/dependencies/dependencyGraphModels.ts` | `core/dependencies/dependencyGraphModels.ts` | B11 |
| `code_analysis/dependencies/dependencyGraphService.ts` | `core/dependencies/dependencyGraphService.ts` | B11 |
| `code_analysis/dependencies/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/engine/analysisOrchestrator.ts` | `core/analysis/analysisOrchestrator.ts` | B12 |
| `code_analysis/engine/components/customComponents/analysisModeComponentAsset.ts` | `core/analysis/scene-assets/analysisModeComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/analysisTableComponentAsset.ts` | `core/analysis/scene-assets/analysisTableComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/avatarComponentAsset.ts` | `core/analysis/scene-assets/avatarComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/codexrDebugComponentAsset.ts` | `core/analysis/scene-assets/codexrDebugComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/codexrRoomComponentAsset.ts` | `core/analysis/scene-assets/codexrRoomComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/collaborationComponentAsset.ts` | `core/analysis/scene-assets/collaborationComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/commonComponentAsset.ts` | `core/analysis/scene-assets/commonComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/commonGitRefPickerComponentAsset.ts` | `core/analysis/scene-assets/commonGitRefPickerComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/dependencyGraphComponentAsset.ts` | `core/analysis/scene-assets/dependencyGraphComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/dependencyVisualBudgetComponentAsset.ts` | `core/analysis/scene-assets/dependencyVisualBudgetComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/guideScreenComponentAsset.ts` | `core/analysis/scene-assets/guideScreenComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/historicalComparisonComponentAsset.ts` | `core/analysis/scene-assets/historicalComparisonComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/immersiveRigComponentAsset.ts` | `core/analysis/scene-assets/immersiveRigComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/engine/components/customComponents/logoComponentAsset.ts` | `core/analysis/scene-assets/logoComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/pointerPolicyComponentAsset.ts` | `core/analysis/scene-assets/pointerPolicyComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/projectEvolutionComponentAsset.ts` | `core/analysis/scene-assets/projectEvolutionComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/renderBudgetComponentAsset.ts` | `core/analysis/scene-assets/renderBudgetComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/runtimeAssembly.ts` | `core/analysis/scene-assets/runtimeAssembly.ts` | B12 |
| `code_analysis/engine/components/customComponents/singleFileRuntimeAssets.ts` | `core/analysis/scene-assets/singleFileRuntimeAssets.ts` | B12 |
| `code_analysis/engine/components/customComponents/virtualScreenComponentAsset.ts` | `core/analysis/scene-assets/virtualScreenComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/xrChartDebugComponentAsset.ts` | `core/analysis/scene-assets/xrChartDebugComponentAsset.ts` | B12 |
| `code_analysis/engine/components/customComponents/xrChartMappingUiComponentAsset.ts` | `core/analysis/scene-assets/xrChartMappingUiComponentAsset.ts` | B12 |
| `code_analysis/engine/core/analysisSession.ts` | `core/analysis/session/analysisSession.ts` | B12 |
| `code_analysis/engine/core/sessionRegistry.ts` | `core/analysis/session/sessionRegistry.ts` | B12 |
| `code_analysis/engine/launchers/launcherLivePanel.ts` | `core/analysis/launchers/launcherLivePanel.ts` | B12 |
| `code_analysis/engine/launchers/launcherVisualizeDOM.ts` | `core/analysis/launchers/launcherVisualizeDOM.ts` | B12 |
| `code_analysis/engine/launchers/launcherXRAnalysis.ts` | `core/analysis/launchers/launcherXRAnalysis.ts` | B12 |
| `code_analysis/engine/launchers/launchPipeline.ts` | `core/analysis/launchers/launchPipeline.ts` | B12 |
| `code_analysis/engine/parsers/directoryXRParser.ts` | `core/analysis/parsers/directoryXRParser.ts` | B12 |
| `code_analysis/engine/parsers/fileXRParser.ts` | `core/analysis/parsers/fileXRParser.ts` | B12 |
| `code_analysis/engine/parsers/livePanelParser.ts` | `core/analysis/parsers/livePanelParser.ts` | B12 |
| `code_analysis/engine/parsers/visualizeDOMParser.ts` | `core/analysis/parsers/visualizeDOMParser.ts` | B12 |
| `code_analysis/engine/processors/analysisBootstrap.ts` | `core/analysis/processors/analysisBootstrap.ts` | B12 |
| `code_analysis/engine/processors/FileRequirementProcessor.ts` | `core/analysis/processors/FileRequirementProcessor.ts` | B12 |
| `code_analysis/engine/servers/models/sessionServerModels.ts` | `core/analysis/session-servers/sessionServerModels.ts` | B12 |
| `code_analysis/engine/servers/serverLaunchOrchestrator.ts` | `core/analysis/session-servers/serverLaunchOrchestrator.ts` | B12 |
| `code_analysis/engine/servers/sessionServerManager.ts` | `core/analysis/session-servers/sessionServerManager.ts` | B12 |
| `code_analysis/engine/servers/sseNotificationManager.ts` | `core/analysis/session-servers/sseNotificationManager.ts` | B12 |
| `code_analysis/engine/utils/backendScriptPath.ts` | `core/analysis/python/backendScriptPath.ts` | B12 |
| `code_analysis/engine/utils/executePython.ts` | `core/analysis/python/executePython.ts` | B12 |
| `code_analysis/engine/utils/fileHashCalculator.ts` | `core/analysis/utils/fileHashCalculator.ts` | B12 |
| `code_analysis/engine/utils/pythonStderrStream.ts` | `core/analysis/python/pythonStderrStream.ts` | B12 |
| `code_analysis/engine/utils/saveFiles.ts` | `core/analysis/utils/saveFiles.ts` | B12 |
| `code_analysis/engine/utils/themeUtils.ts` | `core/analysis/utils/themeUtils.ts` | B12 |
| `code_analysis/engine/watchers/analysisFilePolicy.ts` | `core/analysis/watchers/analysisFilePolicy.ts` | B12 |
| `code_analysis/engine/watchers/configurationConverter.ts` | `core/analysis/watchers/configurationConverter.ts` | B12 |
| `code_analysis/engine/watchers/debounceManager.ts` | `core/analysis/watchers/debounceManager.ts` | B12 |
| `code_analysis/engine/watchers/directoryReanalysisData.ts` | `core/analysis/watchers/directoryReanalysisData.ts` | B12 |
| `code_analysis/engine/watchers/directoryReAnalyzer.ts` | `core/analysis/watchers/directoryReAnalyzer.ts` | B12 |
| `code_analysis/engine/watchers/directorySnapshot.ts` | `core/analysis/watchers/directorySnapshot.ts` | B12 |
| `code_analysis/engine/watchers/directoryWatcherOrchestrator.ts` | `core/analysis/watchers/directoryWatcherOrchestrator.ts` | B12 |
| `code_analysis/engine/watchers/fileHashTracker.ts` | `core/analysis/watchers/fileHashTracker.ts` | B12 |
| `code_analysis/engine/watchers/fileWatcherOrchestrator.ts` | `core/analysis/watchers/fileWatcherOrchestrator.ts` | B12 |
| `code_analysis/engine/watchers/reAnalysisManager.ts` | `core/analysis/watchers/reAnalysisManager.ts` | B12 |
| `code_analysis/engine/watchers/sessionWatcherManager.ts` | `core/analysis/watchers/sessionWatcherManager.ts` | B12 |
| `code_analysis/export/exportManifest.ts` | `core/export/exportManifest.ts` | B11 |
| `code_analysis/export/exportModeSelection.ts` | `core/export/exportModeSelection.ts` | B11 |
| `code_analysis/export/exportPackageTransaction.ts` | `core/export/exportPackageTransaction.ts` | B11 |
| `code_analysis/export/gitExportOptions.ts` | `core/export/gitExportOptions.ts` | B11 |
| `code_analysis/export/gitExportPythonWorkerPool.ts` | `core/export/gitExportPythonWorkerPool.ts` | B11 |
| `code_analysis/export/gitRevisionExportCore.ts` | `core/export/gitRevisionExportCore.ts` | B11 |
| `code_analysis/export/gitRevisionExporter.ts` | `core/export/gitRevisionExporter.ts` | B11 |
| `code_analysis/export/gitTimelineBlobAnalyzer.ts` | `core/export/gitTimelineBlobAnalyzer.ts` | B11 |
| `code_analysis/historical/analysisUpdateEvents.ts` | `core/history/analysisUpdateEvents.ts` | B11 |
| `code_analysis/historical/gitAnalysisEligibility.ts` | `core/history/gitAnalysisEligibility.ts` | B11 |
| `code_analysis/historical/gitAnalysisSessionContext.ts` | `core/history/gitAnalysisSessionContext.ts` | B11 |
| `code_analysis/historical/gitAnalysisShared.ts` | `core/history/gitAnalysisShared.ts` | B11 |
| `code_analysis/historical/gitBatchObjectReader.ts` | `core/history/gitBatchObjectReader.ts` | B11 |
| `code_analysis/historical/gitRepositoryService.ts` | `core/history/gitRepositoryService.ts` | B11 |
| `code_analysis/historical/gitTimelineBlobIndex.ts` | `core/history/gitTimelineBlobIndex.ts` | B11 |
| `code_analysis/historical/gitTimelineSampler.ts` | `core/history/gitTimelineSampler.ts` | B11 |
| `code_analysis/historical/historicalComparisonModels.ts` | `core/history/historicalComparisonModels.ts` | B11 |
| `code_analysis/historical/historicalComparisonService.ts` | `core/history/historicalComparisonService.ts` | B11 |
| `code_analysis/historical/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/historical/projectEvolutionService.ts` | `core/history/projectEvolutionService.ts` | B11 |
| `code_analysis/refresh/analysisRefreshCoordinator.ts` | `core/analysis/refresh/analysisRefreshCoordinator.ts` | B12 |
| `code_analysis/refresh/analysisViewModes.ts` | `core/analysis/refresh/analysisViewModes.ts` | B12 |
| `code_analysis/refresh/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/services/serverWatcherIntegration.ts` | `features/analysis/services/serverWatcherIntegration.ts` | B13 |
| `code_analysis/services/workspaceSnapshotModel.ts` | `features/analysis/workspace/workspaceSnapshotModel.ts` | B13 |
| `code_analysis/services/workspaceSnapshotService.ts` | `features/analysis/workspace/workspaceSnapshotService.ts` | B13 |
| `code_analysis/services/xrFieldSchemaService.ts` | `core/analysis/python/xrFieldSchemaService.ts` | B12 |
| `code_analysis/utils/filesByLanguageSortingUtils.ts` | `features/analysis/sections/settings/files-by-language-sorting/filesByLanguageSortingUtils.ts` | B13 |
| `code_analysis/utils/workspaceFileScanner.ts` | `features/analysis/workspace/workspaceFileScanner.ts` | B13 |
| `code_analysis/views/AnalysisSectionProvider.ts` | `features/analysis/views/AnalysisSectionProvider.ts` | B13 |
| `code_analysis/views/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/interactions/handleAnalysisClicks.ts` | `features/analysis/views/handleAnalysisClicks.ts` | B13 |
| `code_analysis/views/interactions/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/items/analysisItems.ts` | `features/analysis/views/analysisItems.ts` | B13 |
| `code_analysis/views/items/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.ts` | `features/analysis/sections/active-analyses/activeAnalysesCommands.ts` | B13 |
| `code_analysis/views/subsections/active_analyses/services/activeAnalysesDataService.ts` | `features/analysis/sections/active-analyses/activeAnalysesDataService.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/analysis_directory_mode/analysisDirectoryMode.ts` | `features/analysis/sections/settings/analysis-directory-mode/analysisDirectoryMode.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/analysis_directory_mode/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/analysis_settings/analysis_file_mode/analysisFileMode.ts` | `features/analysis/sections/settings/analysis-file-mode/analysisFileMode.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/analysis_file_mode/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/analysis_settings/analysisSettingsSubsectionProvider.ts` | `features/analysis/sections/settings/analysisSettingsSubsectionProvider.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/auto_analysis_delay/autoAnalysisDelay.ts` | `features/analysis/sections/settings/auto-analysis-delay/autoAnalysisDelay.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/auto_analysis_delay/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/analysis_settings/auto_analysis_enabled/autoAnalysisEnabled.ts` | `features/analysis/sections/settings/auto-analysis-enabled/autoAnalysisEnabled.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/auto_analysis_enabled/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/analysis_settings/chart_type_directory/chartTypeDirectory.ts` | `features/analysis/sections/settings/chart-type-directory/chartTypeDirectory.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/chart_type_directory/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/analysis_settings/chart_type_file/chartTypeFile.ts` | `features/analysis/sections/settings/chart-type-file/chartTypeFile.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/chart_type_file/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/analysis_settings/chart_type_shared/sharedChartTypeSettingCore.ts` | `features/analysis/sections/settings/sharedChartTypeSettingCore.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/dimension_mapping_directory/dimensionMappingDirectory.ts` | `features/analysis/sections/settings/dimension-mapping-directory/dimensionMappingDirectory.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/dimension_mapping_directory/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/analysis_settings/dimension_mapping_file/dimensionMappingFile.ts` | `features/analysis/sections/settings/dimension-mapping-file/dimensionMappingFile.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/dimension_mapping_file/dimensionMappingValidator.ts` | `features/analysis/sections/settings/dimension-mapping-file/dimensionMappingValidator.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/dimension_mapping_shared/sharedDimensionMappingSettingCore.ts` | `features/analysis/sections/settings/sharedDimensionMappingSettingCore.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/files_by_language_sorting/filesByLanguageSorting.ts` | `features/analysis/sections/settings/files-by-language-sorting/filesByLanguageSorting.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/files_by_language_sorting/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/analysis_settings/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/analysis_settings/profile_configuration/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/analysis_settings/profile_configuration/profileConfiguration.ts` | `features/analysis/sections/settings/profile-configuration/profileConfiguration.ts` | B13 |
| `code_analysis/views/subsections/analysis_settings/view_theme/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/analysis_settings/view_theme/viewTheme.ts` | `features/analysis/sections/settings/view-theme/viewTheme.ts` | B13 |
| `code_analysis/views/subsections/files_by_language/filesByLanguageSubsectionProvider.ts` | `features/analysis/sections/files-by-language/filesByLanguageSubsectionProvider.ts` | B13 |
| `code_analysis/views/subsections/files_by_language/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/project_by_language/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `code_analysis/views/subsections/project_by_language/projectByLanguageSubsectionProvider.ts` | `features/analysis/sections/project-by-language/projectByLanguageSubsectionProvider.ts` | B13 |
| `collaboration/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `collaboration/model/anonymousName.ts` | `core/collaboration/anonymousName.ts` | B8 |
| `collaboration/model/collaborationProfile.ts` | `core/collaboration/collaborationProfile.ts` | B8 |
| `collaboration/model/connectedParticipant.ts` | `core/collaboration/connectedParticipant.ts` | B8 |
| `collaboration/services/collaborationProfileManager.ts` | `core/collaboration/collaborationProfileManager.ts` | B8 |
| `commands/active_servers/activeServersCommands.ts` | `features/active-servers/commands/activeServersCommandRegistrations.ts` | B10 |
| `commands/analysis/AnalysisCommands.ts` | `features/analysis/commands/analysisCommandRegistrations.ts` | B13 |
| `commands/analysis/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `commands/babia_examples/babiaExamplesCommands.ts` | `features/examples/commands/babiaExamplesCommandRegistrations.ts` | B6 |
| `commands/collaboration/collaborationCommands.ts` | `features/collaboration/commands/collaborationCommands.ts` | B8 |
| `commands/common/generalCommands.ts` | `app/commands/generalCommands.ts` | B14 |
| `commands/index.ts` | `app/commands/registerAllCommands.ts` | B14 |
| `commands/learn_more/learnMoreCommands.ts` | `features/learn-more/commands/learnMoreCommandRegistrations.ts` | B2 |
| `commands/python_env/pythonEnvCommands.ts` | `features/python-env/commands/pythonEnvCommandRegistrations.ts` | B3 |
| `commands/servers/serverCommands.ts` | `features/servers/commands/serverCommandRegistrations.ts` | B10 |
| `commands/visualization_settings/visualizationSettingsCommands.ts` | `features/visualization-settings/commands/visualizationSettingsCommandRegistrations.ts` | B4 |
| `commands/visualize_data/visualizeDataCommands.ts` | `features/visualize-data/commands/visualizeDataCommandRegistrations.ts` | B5 |
| `core/extensionContext.ts` | `platform/extensionContext.ts` | B1 |
| `core/logging/logger.ts` | `platform/logging/logger.ts` | B1 |
| `core/logging/logPolicy.ts` | `platform/logging/logPolicy.ts` | B1 |
| `core/logging/sink.ts` | `platform/logging/sink.ts` | B1 |
| `core/startup/startupCoordinator.ts` | `app/startup/startupCoordinator.ts` | B14 |
| `extension.ts` | `extension.ts` | — |
| `learn_more/commands/learnMoreCommands.ts` | `features/learn-more/commands/learnMoreCommands.ts` | B2 |
| `platform/commands/commandRegistry.ts` | `platform/commands/commandRegistry.ts` | — |
| `platform/templatePaths.ts` | `platform/templatePaths.ts` | — |
| `platform/tree/baseInterfaces.ts` | `platform/tree/baseInterfaces.ts` | — |
| `python_env/commands/pythonEnvCommands.ts` | `features/python-env/commands/pythonEnvCommands.ts` | B3 |
| `python_env/runtime/pythonEnvUiState.ts` | `core/python-env/pythonEnvUiState.ts` | B3 |
| `python_env/runtime/pythonPackageManifest.ts` | `core/python-env/pythonPackageManifest.ts` | B3 |
| `python_env/runtime/venvManager.ts` | `core/python-env/venvManager.ts` | B3 |
| `python_env/storage/pythonEnvStorage.ts` | `core/python-env/pythonEnvStorage.ts` | B3 |
| `python_env/utils/pythonEnvUtils.ts` | `core/python-env/pythonEnvUtils.ts` | B3 |
| `python_env/views/items/pythonEnvItems.ts` | `features/python-env/views/pythonEnvItems.ts` | B3 |
| `remote_access/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `remote_access/model/remoteAccessModel.ts` | `core/remote-access/remoteAccessModel.ts` | B8 |
| `remote_access/security/remoteSessionAuthority.ts` | `core/remote-access/remoteSessionAuthority.ts` | B8 |
| `remote_access/services/cloudflaredBinaryManager.ts` | `core/remote-access/cloudflaredBinaryManager.ts` | B8 |
| `remote_access/services/remoteAccessManager.ts` | `core/remote-access/remoteAccessManager.ts` | B8 |
| `servers/commands/serverCommands.ts` | `features/servers/commands/serverCommands.ts` | B10 |
| `servers/runtime/analysis/analysisBridgeReplies.ts` | `core/server/analysis/analysisBridgeReplies.ts` | B9 |
| `servers/runtime/analysis/analysisFeatureHost.ts` | `core/server/analysis/analysisFeatureHost.ts` | B9 |
| `servers/runtime/analysis/analysisMessageRouter.ts` | `core/server/analysis/analysisMessageRouter.ts` | B9 |
| `servers/runtime/analysis/dependencyGraphBridge.ts` | `core/server/analysis/dependencyGraphBridge.ts` | B9 |
| `servers/runtime/analysis/historicalComparisonBridge.ts` | `core/server/analysis/historicalComparisonBridge.ts` | B9 |
| `servers/runtime/analysis/projectEvolutionBridge.ts` | `core/server/analysis/projectEvolutionBridge.ts` | B9 |
| `servers/runtime/analysisServerCapabilities.ts` | `core/server/analysisServerCapabilities.ts` | B9 |
| `servers/runtime/broadcast/broadcastTypes.ts` | `core/server/broadcast/broadcastTypes.ts` | B9 |
| `servers/runtime/broadcast/mediaFrame.ts` | `core/server/broadcast/mediaFrame.ts` | B9 |
| `servers/runtime/broadcast/relayPolicy.ts` | `core/server/broadcast/relayPolicy.ts` | B9 |
| `servers/runtime/broadcast/screenBroadcastSignalingServer.ts` | `core/server/broadcast/screenBroadcastSignalingServer.ts` | B9 |
| `servers/runtime/collaboration/collaborationRoomServer.ts` | `core/server/collaboration/collaborationRoomServer.ts` | B9 |
| `servers/runtime/collaboration/collaborationSessionApi.ts` | `core/server/collaboration/collaborationSessionApi.ts` | B9 |
| `servers/runtime/collaboration/participantIdentity.ts` | `core/server/collaboration/participantIdentity.ts` | B9 |
| `servers/runtime/collaboration/roomMessageCodec.ts` | `core/server/collaboration/roomMessageCodec.ts` | B9 |
| `servers/runtime/collaboration/roomRegistry.ts` | `core/server/collaboration/roomRegistry.ts` | B9 |
| `servers/runtime/collaboration/roomSharedState.ts` | `core/server/collaboration/roomSharedState.ts` | B9 |
| `servers/runtime/collaboration/roomTypes.ts` | `core/server/collaboration/roomTypes.ts` | B9 |
| `servers/runtime/generatedHttpsCertificateManager.ts` | `core/server/generatedHttpsCertificateManager.ts` | B9 |
| `servers/runtime/http/httpRespond.ts` | `core/server/http/httpRespond.ts` | B9 |
| `servers/runtime/http/staticAssets.ts` | `core/server/http/staticAssets.ts` | B9 |
| `servers/runtime/httpsCustomServer.ts` | `core/server/httpsCustomServer.ts` | B9 |
| `servers/runtime/httpsDefaultServer.ts` | `core/server/httpsDefaultServer.ts` | B9 |
| `servers/runtime/httpServer.ts` | `core/server/httpServer.ts` | B9 |
| `servers/runtime/httpsServerBase.ts` | `core/server/httpsServerBase.ts` | B9 |
| `servers/runtime/httpsTlsOptions.ts` | `core/server/httpsTlsOptions.ts` | B9 |
| `servers/runtime/index.ts` | `core/server/launchServerWithFile.ts` | B9 |
| `servers/runtime/multiServerLauncher.ts` | `core/server/multiServerLauncher.ts` | B9 |
| `servers/runtime/portManager.ts` | `core/server/portManager.ts` | B9 |
| `servers/runtime/previewRenderer.ts` | `features/active-servers/services/previewRenderer.ts` | B10 |
| `servers/runtime/remote/brandMark.ts` | `core/server/remote/brandMark.ts` | B9 |
| `servers/runtime/remote/pairingPage.ts` | `core/server/remote/pairingPage.ts` | B9 |
| `servers/runtime/remote/remoteAccessPolicy.ts` | `core/server/remote/remoteAccessPolicy.ts` | B9 |
| `servers/runtime/remote/remotePairingApi.ts` | `core/server/remote/remotePairingApi.ts` | B9 |
| `servers/runtime/serverFactory.ts` | `core/server/serverFactory.ts` | B9 |
| `servers/runtime/sse/sseClientRegistry.ts` | `core/server/sse/sseClientRegistry.ts` | B9 |
| `servers/runtime/sse/SSEManager.ts` | `core/server/sse/SSEManager.ts` | B9 |
| `servers/runtime/ws/webSocketEndpoint.ts` | `core/server/ws/webSocketEndpoint.ts` | B9 |
| `servers/storage/serverSettingsManager.ts` | `core/server/serverSettingsManager.ts` | B9 |
| `servers/utils/networkUtils.ts` | `core/server/networkUtils.ts` | B9 |
| `servers/views/interactions/handleConfigurationClicks.ts` | `features/servers/views/handleConfigurationClicks.ts` | B10 |
| `servers/views/interactions/launchNotifications.ts` | `features/active-servers/views/launchNotifications.ts` | B10 |
| `servers/views/items/configurationItems.ts` | `features/servers/views/configurationItems.ts` | B10 |
| `utils/commandBuilder.ts` | `platform/commands/commandBuilder.ts` | B1 |
| `utils/commonCommands.ts` | `app/sidebar/commonCommands.ts` | B14 |
| `utils/detailDialog.ts` | `platform/ui/detailDialog.ts` | B1 |
| `utils/errorHandler.ts` | `platform/ui/errorHandler.ts` | B1 |
| `utils/fileToServerMap.ts` | `core/server/fileToServerMap.ts` | B9 |
| `utils/getVisualizationConfiguration.ts` | `core/charts/getVisualizationConfiguration.ts` | B7 |
| `utils/jsonFieldAnalyzer.ts` | `features/visualize-data/services/jsonFieldAnalyzer.ts` | B5 |
| `utils/languageMetadata.ts` | `core/analysis/languages/languageMetadata.ts` | B12 |
| `utils/nonceGenerator.ts` | `shared/nonceGenerator.ts` | B1 |
| `utils/sha256Generator.ts` | `core/analysis/utils/sha256Generator.ts` | B12 |
| `utils/supportedLanguages.ts` | `core/analysis/languages/supportedLanguages.ts` | B12 |
| `utils/uriPathConverter.ts` | `features/analysis/commands/dom/uriPathConverter.ts` | B13 |
| `views/active_servers/ActiveServersSectionProvider.ts` | `features/active-servers/views/ActiveServersSectionProvider.ts` | B10 |
| `views/active_servers/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `views/active_servers/items/activeServerItems.ts` | `features/active-servers/views/activeServerItems.ts` | B10 |
| `views/babia_examples/BabiaExamplesSectionProvider.ts` | `features/examples/views/BabiaExamplesSectionProvider.ts` | B6 |
| `views/babia_examples/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `views/babia_examples/interactions/handleBabiaExampleClicks.ts` | `features/examples/views/handleBabiaExampleClicks.ts` | B6 |
| `views/babia_examples/items/babiaExampleItems.ts` | `features/examples/views/babiaExampleItems.ts` | B6 |
| `views/collaboration/CollaborationSectionProvider.ts` | `features/collaboration/views/CollaborationSectionProvider.ts` | B8 |
| `views/collaboration/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `views/collaboration/items/collaborationItems.ts` | `features/collaboration/views/collaborationItems.ts` | B8 |
| `views/common/sectionChild.ts` | `app/sidebar/sectionChild.ts` | B14 |
| `views/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `views/learn_more/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `views/learn_more/interactions/handleLearnMoreClicks.ts` | `features/learn-more/views/handleLearnMoreClicks.ts` | B2 |
| `views/learn_more/items/learnMoreItems.ts` | `features/learn-more/views/learnMoreItems.ts` | B2 |
| `views/learn_more/LearnMoreSectionProvider.ts` | `features/learn-more/views/LearnMoreSectionProvider.ts` | B2 |
| `views/ModularTreeDataProvider.ts` | `app/sidebar/ModularTreeDataProvider.ts` | B14 |
| `views/python_env/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `views/python_env/PythonEnvSectionProvider.ts` | `features/python-env/views/PythonEnvSectionProvider.ts` | B3 |
| `views/sectionDefinitions.ts` | `app/sidebar/sectionDefinitions.ts` | B14 |
| `views/servers/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `views/servers/items/serverItems.ts` | `features/servers/views/serverItems.ts` | B10 |
| `views/servers/ServersSectionProvider.ts` | `features/servers/views/ServersSectionProvider.ts` | B10 |
| `views/visualization_settings/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `views/visualization_settings/interactions/handleVisualizationSettingsClicks.ts` | `features/visualization-settings/views/handleVisualizationSettingsClicks.ts` | B4 |
| `views/visualization_settings/items/visualizationSettingsItems.ts` | `features/visualization-settings/views/visualizationSettingsSectionItems.ts` | B4 |
| `views/visualization_settings/VisualizationSettingsSectionProvider.ts` | `features/visualization-settings/views/VisualizationSettingsSectionProvider.ts` | B4 |
| `views/visualize_data/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `views/visualize_data/interactions/handleVisualizeDataClicks.ts` | `features/visualize-data/views/handleVisualizeDataClicks.ts` | B5 |
| `views/visualize_data/items/visualizeDataItems.ts` | `features/visualize-data/views/visualizeDataSectionItems.ts` | B5 |
| `views/visualize_data/VisualizeDataSectionProvider.ts` | `features/visualize-data/views/VisualizeDataSectionProvider.ts` | B5 |
| `visualization_settings/commands/visualizationSettingsCommands.ts` | `features/visualization-settings/commands/visualizationSettingsCommands.ts` | B4 |
| `visualization_settings/index.ts` | *(dissolved: re-export barrel)* | B0 |
| `visualization_settings/model/settingsModel.ts` | `core/charts/settings/settingsModel.ts` | B4 |
| `visualization_settings/storage/settingsFile.ts` | `core/charts/settings/settingsFile.ts` | B4 |
| `visualization_settings/storage/settingsStorage.ts` | `core/charts/settings/settingsStorage.ts` | B4 |
| `visualization_settings/utils/colorPickerUtils.ts` | `features/visualization-settings/views/colorPickerUtils.ts` | B4 |
| `visualization_settings/utils/dynamicColorIconGenerator.ts` | `features/visualization-settings/views/dynamicColorIconGenerator.ts` | B4 |
| `visualization_settings/utils/settingsAccessors.ts` | `core/charts/settings/settingsAccessors.ts` | B4 |
| `visualization_settings/views/interactions/handleSettingsInteraction.ts` | `features/visualization-settings/views/handleSettingsInteraction.ts` | B4 |
| `visualization_settings/views/items/visualizationSettingsItems.ts` | `features/visualization-settings/views/visualizationSettingsItems.ts` | B4 |
| `visualize_data/commands/visualizeDataCommands.ts` | `features/visualize-data/commands/visualizeDataCommands.ts` | B5 |
| `visualize_data/model/visualizeDataModel.ts` | `features/visualize-data/model/visualizeDataModel.ts` | B5 |
| `visualize_data/runtime/visualizationRestorer.ts` | `features/visualize-data/services/visualizationRestorer.ts` | B5 |
| `visualize_data/state/visualizeDataState.ts` | `features/visualize-data/model/visualizeDataState.ts` | B5 |
| `visualize_data/views/interactions/visualizationLauncher.ts` | `features/visualize-data/services/visualizationLauncher.ts` | B5 |
| `visualize_data/views/items/visualizationItem.ts` | `features/visualize-data/views/visualizationItem.ts` | B5 |
| `visualize_data/views/items/visualizeDataItems.ts` | `features/visualize-data/views/visualizeDataItems.ts` | B5 |

Machine-readable form: [`src-move-map.json`](src-move-map.json) (`moves`: old → new, `null` = dissolved, key = value = stays; `batch`: the batch of each row). Keys and values use the `src/…` form that tests and docs use. It is the input of the batch codemod (A.5), of `measureGuardrails.cjs --renamed` and of the H3 check (A.6).

## 5. Move plan

### 5.1 Preconditions and sequencing

1. **#34, #35 and #42 have merged** (#40 already has). The move runs as its own wave, and no other open PR touches `src/` while it runs (a rename is cheap to replay but expensive to rebase onto).
2. **Re-generate the map on the tree as it is then.** `graph` + the map rules (A.1, A.4) flag any file the map does not cover. Every new file gets a row by the placement rule.
3. **One preparatory tooling commit.** `npm run guardrails:update` treats new `byModule` keys and new paths in `size.filesOver500` / `functions.over80Lines` as regressions, so a pure move would need `--allow-regression` and would leave a waiver behind (today `waivers` is `[]`). Teach `test/tooling/measureGuardrails.cjs` to accept `--renamed <map.json>`, which re-keys the old baseline through the map before comparing. The ratchet then stays tight, and a move reports "no change". `console.byModule` / `any.byModule` group by the first folder under `src/`. After the move that is `core`, `features`, …, which is too coarse, so group by the first **two** levels for `core/` and `features/` (same commit).
4. **`rm -rf out` before `npm run compile-tests`** in every batch. `test/runners/run-node-tests.cjs` fails on compiled files with no source left ("no source left: out/…"), and a stale `out/` keeps old paths importable, which would hide a missed specifier.

### 5.2 Batch 0: dissolve the 47 re-export barrels

One commit per area (analysis commands, analysis views, servers, views, collaboration/remote access, the rest), before any file moves, so that the move batches are pure path changes:

- Rewrite each `import { X } from '…/barrel'` to the file that declares `X` (`symedges` in A.4 computes the declaring file for every imported name, and it resolved all of them on today's tree). `export *` re-exports in `views/index.ts` go away with it. `extension.ts` imports `ModularTreeDataProvider` directly.
- **Module evaluation order can change**, because a barrel evaluates every module it re-exports on first import. Before deleting a barrel, grep the modules it re-exports for top-level side effects (top-level `new`, `getInstance()`, `registerCommand`, `setContext`). Proof per commit: H3 (§6) passes, and the feature-baseline test is green.
- The lazy `require('../visualization_settings')` in `utils/getVisualizationConfiguration.ts` is rewritten to `require('../visualization_settings/utils/settingsAccessors')`. It must stay a lazy `require` (destructured names unchanged).
- Text pins: tests that name a barrel path (`commands/shared/index`, `views/index`) are updated in the same commit.

### 5.3 Batches 1–14

Columns: files moved / their lines / **importers** (files outside the batch whose specifiers the codemod rewrites) / **test files** that name a moved path (any of `src/a/b.ts`, compiled `a/b.js`, `out/a/b.js`, or `'a', 'b', 'c.ts'` path segments; `guardrail-baseline.json` counted) / **tooling** files outside `test/` / **living docs** / **historical docs** (AUDIT, session logs, STATUS, ROADMAP/DESIGN/CRITIC, CHANGELOG, `docs/cleanup/*`, ADRs: never rewritten). Doc counts are a lower bound: they count full paths only, and prose that names a file relative to its module (the `ARCHITECTURE.md` module map does) is found by grepping the old folder name. That grep (`grep -rl <old-folder> --include=*.md`, step 4 of §5.4) finds 33 Markdown files naming `code_analysis`, 19 naming `python_env`, 17 naming `active_servers` and 14 naming `servers/runtime` (historical ones included, these two documents excluded).

| Batch | Area | Files | Lines | Importers | Test files | Tooling | Living docs | Historical docs | Risk |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| B1 | platform/ + shared/ | 11 | 762 | 42 | 8 | 0 | 0 | 11 | medium |
| B2 | learn-more | 5 | 254 | 4 | 0 | 0 | 0 | 4 | low |
| B3 | python-env (core + feature) | 9 | 2158 | 8 | 5 | 1 | 2 | 11 | low |
| B4 | visualization-settings (core/charts/settings + feature) | 12 | 1882 | 5 | 2 | 0 | 0 | 6 | low |
| B5 | visualize-data | 12 | 2478 | 4 | 2 | 0 | 0 | 4 | low |
| B6 | examples | 10 | 1410 | 4 | 2 | 0 | 0 | 5 | low |
| B7 | core/charts | 10 | 2275 | 13 | 13 | 0 | 3 | 8 | medium |
| B8 | collaboration + remote-access (core + feature) | 11 | 2014 | 11 | 7 | 0 | 0 | 6 | medium |
| B9 | core/server | 44 | 8571 | 22 | 20 | 0 | 2 | 14 | high |
| B10 | servers + active-servers features | 16 | 3177 | 6 | 4 | 0 | 1 | 11 | medium |
| B11 | core/history + core/export + core/dependencies | 21 | 5608 | 3 | 15 | 0 | 0 | 9 | medium |
| B12 | core/analysis | 62 | 8353 | 47 | 29 | 1 | 5 | 10 | high |
| B13 | features/analysis | 54 | 7659 | 31 | 12 | 0 | 0 | 9 | medium |
| B14 | app/ composition root | 7 | 887 | 2 | 8 | 0 | 4 | 13 | medium |

Totals: 284 files move. 76 distinct test files name a moved path, in 338 (file, path) pairs. Tooling outside `test/` names a moved path in exactly 2 places: `backend/scripts/run-analysis-tests.cjs` (`python_env/runtime/pythonPackageManifest`, B3) and `backend/tests/analyzers/test_analyzer_extension_coverage.py` (`code_analysis/engine/watchers/analysisFilePolicy.ts`, B12). `webpack.config.js` (entry `./src/extension.ts`), `package.json`, `eslint.config.mjs` (`src/**/*.ts`), `tsconfig*.json` and `.vscode/` name no moved path. The webpack copy `to: 'code_analysis/python'` and `backendScriptPath.ts`'s `dist/code_analysis/python` are **the shipped location of the Python backend, not a `src/` folder: they must not change** (the VSIX layout and `scripts/vsix-listing.mjs` depend on them).

Risk notes per batch:

- **B1 platform/shared (medium):** few files, but the most importers (42): `logger.ts` is imported by 15 files, `commandRegistry` by 18 via its barrel. Logging tests load `core/logging/logger.js` through `requireOut`. Do it right after #34, while the logger import lines are fresh.
- **B2–B6 small features (low):** learn-more first, as the pilot. The pilot of B2+B5 passed H3 (§0).
- **B7 core/charts (medium):** 13 test files, including `featureSurface.cjs` and `run-xr-immersive-harness.cjs`. The chart registry is a cross-module contract (ARCHITECTURE "Cross-module contracts" §2): path only, no content change.
- **B8 collaboration + remote access (medium):** follows the barrel dissolution of `remote_access/index.ts` and `collaboration/index.ts`. `remoteSessionAuthority.ts` and the room server are pinned by the server suites.
- **B9 core/server (high):** 44 files, 20 test files, the `__dirname` depth constraint (§3.3), the `HttpServer.stop()` dispose-before-close order (cleanup skill §4, untouched by a move but in these files), and `test/servers/*` reading the runtime by path. Run `npm run test:xr-harness` as well.
- **B10 servers + active-servers features (medium).**
- **B11 history/export/dependencies (medium):** 15 test files. `featureSurface.cjs` reads `gitRevisionExporter.ts`. `npm run test:analysis` as well.
- **B12 core/analysis (high):** 62 files, 47 importers, 29 test files, the Python backend coverage test, `executePython.ts` (7 test pins), `scene-assets/` read by directory in `test/helpers/runtimeAssembly.cjs`, `packagedLayout.test.cjs`, `runtimeAssemblyParity.test.cjs` and two runtime tests, plus the `runtime-component` and `add-language` skills. Gates: `npm test`, `npm run test:python`, `npm run test:analysis`, the XR harness.
- **B13 features/analysis (medium):** 54 files but mostly UI. `analysisNamespace.test.cjs` and `activeAnalysesCommands.test.cjs` pin command modules.
- **B14 app/ (medium):** `featureSurface.cjs`, `commandContributions.test.cjs` and `analysisTreeBridge.test.cjs` read `commands/index.ts` and `ModularTreeDataProvider.ts`. CLAUDE.md and the cleanup skill name both files.

### 5.4 What every batch commit contains

1. `node move-src.mjs apps/vscode-extension batch-N.json` (A.5): `git mv` plus the specifier rewrite in every importer, `require()` and `import()` included.
2. Every test, script and living doc that names a moved path, retargeted. Find them with `pins` (A.2) restricted to the batch. Pins are **G** (path only) in a move: the asserted text does not change, only the file it is read from. If an assertion's text would change, it is not a move: stop.
3. `npm run guardrails:update --renamed map.json` (precondition 3) and the baseline diff, in the same commit.
4. `ARCHITECTURE.md` module-map rows for the moved area, plus CLAUDE.md, the skills and `docs/features/*` lines that name the old path. Historical docs are not edited. The CHANGELOG gets one line for the whole story ("Changed (internal): `src/` reorganized feature-first; no behaviour change"), in the last batch.
5. If `test/baseline/featureSurface.cjs` lists source paths it reads, those change too. Its snapshot (commands, menus, views, settings, shipped files) **must not change**: a move that changes the snapshot is not a move.
6. Commit body: the batch's rows of the map, the H3 result (§6), the gates run.

## 6. Proving behaviour-neutrality (H3)

The bundle cannot be byte-identical. In `npm run compile` (webpack `mode: 'none'`) every module is keyed by its path (`"./src/…"`), and in `npm run package` (production) the numeric module ids are derived from the path. So H1 does not apply. The proof for a pure move has four parts:

1. **Compiled-module equivalence (primary).** Compile the tree before and after with `tsc --removeComments` (comments may legitimately mention paths). For every compiled module of the old tree, the new tree must have a byte-identical twin at its mapped path once each relative `require("…")` is replaced by the module it resolves to (in new-tree terms), and once tsc's import binding names, which follow the file's basename (`visualizeDataItems_1`), are canonicalized to that target. `compare-out.mjs` (A.6) does exactly this and exits 1 on any difference, missing or extra module. Piloted on B2+B5 against today's tree: 332/332 equivalent. A one-character change injected into one moved module was reported.
2. **Same bundle contents.** `npm run package` before and after: identical module **count** in webpack's stats (`--json`), and `scripts/dist-fingerprint.mjs` / `dist-diff.mjs` showing every non-bundle file in `dist/` identical (the Python copy). The bundle size may differ only by the length of path strings.
3. **Same user surface.** `test/baseline/featureBaseline.test.cjs` green, with **no** `--write`: commands, menus, views, settings, persisted keys, shipped files, chart types, in-scene modes and Python CLI are unchanged. The command set is also pinned by `assertUniqueCommandIds` at activation.
4. **All gates:** `npm test`, `npm run lint` (warning budget unchanged), `npm run typecheck`, the reachability guardrail (`unreachable = 0`), plus the batch's specialised suites (§5.3). The maintainer runs one F5 smoke after B9, B12 and B14 (open the sidebar, run one XR analysis, start and stop a server).

## 7. Result (story #55 executed, 2026-11-25)

The move ran on branch `claude/project-thread-n2s3q6-src-layout`, from `v1.2.1` at `41cfc523`: the map refresh (§4.1, `cbcd9d24`), the tooling commit (`992f84b2`: `measureGuardrails.cjs --renamed`, two-level units under `core/` and `features/`, the layer test), batch 0 in four commits, then B1–B14 in table order, one commit each, and a closing commit with the layout guard (`test/tooling/srcLayout.test.cjs`). The session log is `.claude/docs/v1.2.1/sessions/55-src-layout.md`.

**Files per batch** (moved with `git mv`; batch 0 deletes): B0 46 barrels · B1 9 · B2 5 · B3 9 · B4 13 · B5 12 · B6 10 · B7 11 · B8 11 · B9 44 · B10 16 · B11 21 · B12 64 · B13 55 · B14 7. Total: 287 moved, 46 deleted, 4 already in place (`extension.ts` and the three `platform/` files of #42).

**H3 for every batch** (§6): `compare-out.mjs` 291 of 291 compiled modules equivalent, 0 problems (batch 0: 311 → 291 modules with its barrel-aware variant, 0 problems); webpack (mode none) 512 modules / 279 `src` modules after every move batch; `featureBaseline` green without `--write`; `npm test` 1,059 of 1,059 and lint at the 158-warning budget after every commit; guardrails re-keyed with `--renamed`, ratcheted metrics unchanged, waivers still 6. B3, B11 and B12 also ran `test:python` and `test:analysis`; B7, B9 and B12 the XR harness (B7 and B12 the immersive harness too).

**Package** (`npm run package:vsix`, against the same build of `41cfc523`): the same 199 files. Every file is byte-identical except `CHANGELOG.md` (the story's line), `dist/extension.js` (1,194,937 → 1,173,899 bytes: the 46 barrel modules are gone from the bundle) and the lazy `get-port` chunk, renamed `756.extension.js` → `515.extension.js` by webpack's deterministic ids. Its contents are identical apart from the id.

**Shape** (A.7, `treestats.mjs`):

| Metric | Before (`41cfc523`) | After |
|---|---:|---:|
| `.ts` files | 337 | 291 |
| lines | 49,226 | 48,773 |
| folders | 172 | 99 |
| top-level entries of `src/` | 16 folders + `extension.ts` | 5 layers + `extension.ts` |
| snake_case / camelCase folder names | 57 / 1 | 0 / 0 |
| kebab-case folder names | 0 | 23 |
| single-file leaf folders | 70 | 9 |
| `index.ts` files (re-export barrels) | 48 (46) | 0 (0) |
| max depth below `src/` | 5 | 5 |
| folder units in `folderDependencies.json` / allowed edges | 17 / 78 | 22 / 73 |
| two-way folder pairs | 5 | 4 |

The four pairs left are all inside the server/analysis subsystems, each with its reason in `folderDependencies.json`: `core/analysis<->core/history`, `core/analysis<->core/server`, `core/remote-access<->core/server`, and `core/server<->features/active-servers`. The last one is the one upward edge (§3.5). The other `layerExceptions` entry is the cross-feature edge `features/active-servers -> features/collaboration` (the nested COLLABORATION group).

**Left as found:** `templates/components/COMPONENTS.md` still says `src/.../customComponents/runtimeAssembly.ts` (now `src/core/analysis/scene-assets/runtimeAssembly.ts`). `templates/` ships, and this story changes no shipped file. Historical docs (`V1.2.0_STATUS.md`, the session logs, `AUDIT.md`, the ROADMAP tables) keep the old paths. The bootstrap `vscodeFreeFloor` was lowered 109 → 106 in batch 0, only because three vscode-free barrels were deleted.

## Appendix: scripts

All of them are read-only measurements except A.5, which moves files. They are ES modules for Node ≥ 20 (`.mjs`). Copy them to a scratch folder, and pass the extension root (`apps/vscode-extension`) or the repo root as stated. They are kept here instead of `scripts/`: `scripts/` is linted and shipped-adjacent, and these tools are only needed while #55 runs.

### A.1 `graph.mjs`: import graph of `src/`

```js
// Import graph of apps/vscode-extension/src: node graph.mjs <extRoot>
import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(process.argv[2]); const src = path.join(root, 'src');
const files = []; (function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); e.isDirectory()?walk(p):p.endsWith('.ts')&&files.push(p);} })(src);
const rel = p => path.relative(root, p).split(path.sep).join('/');
const re = /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
function resolve(from, spec){ if(!spec.startsWith('.')) return null; const b=path.resolve(path.dirname(from),spec);
  for (const c of [b+'.ts', path.join(b,'index.ts'), b]) if (fs.existsSync(c)&&fs.statSync(c).isFile()) return c; return 'UNRESOLVED:'+spec; }
const edges = {};
for (const f of files.sort()){ const t=fs.readFileSync(f,'utf8'); const out=new Set(); let m; re.lastIndex=0; while((m=re.exec(t))){ const s=m[1]||m[2]||m[3]||m[4]; const r=resolve(f,s); if(r) out.add(r.startsWith('UNRESOLVED')?r:rel(r)); } edges[rel(f)]=[...out]; }
console.log(JSON.stringify(edges,null,1));
```

### A.2 `pins.mjs`: who names each `src/` file outside `src/`

```js
// node pins.mjs <repoRoot>  -> JSON { "src/x.ts": { tests:[...], tooling:[...], docs:[...] } }
// A pin is any mention of a src file's path in one of three spellings:
//   'src/a/b/c.ts' (source text), 'a/b/c.js' / out/a/b/c.js (compiled module),
//   'a', 'b', 'c.ts'|'c.js' (path.join segments, optionally after 'src' or 'out').
import fs from 'node:fs'; import path from 'node:path';
const repo = path.resolve(process.argv[2]); const ext = path.join(repo, 'apps/vscode-extension');
const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'output', 'artifacts', '.vscode-test', '__pycache__', 'worktrees', 'media', 'resources', 'examples', 'manual_test']);
function walk(d, acc = []) { if (!fs.existsSync(d)) return acc; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else if (/\.(c?js|mjs|ts|json|md|ya?ml|py)$/.test(e.name) && !/package-lock/.test(e.name)) acc.push(p); } return acc; }
const srcFiles = walk(path.join(ext, 'src')).map(p => path.relative(ext, p).split(path.sep).join('/'));
const srcSet = new Set(srcFiles.map(f => path.join(ext, f)));
const corpus = walk(repo).filter(p => !srcSet.has(p) && !p.startsWith(path.join(repo, 'backend', 'src')));
const kind = p => { const r = path.relative(repo, p).split(path.sep).join('/');
  if (r.endsWith('.md')) return 'docs';
  if (r.startsWith('apps/vscode-extension/templates/')) return 'shipped';
  if (r.startsWith('apps/vscode-extension/test/')) return 'tests';
  return 'tooling'; };
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const texts = corpus.map(p => ({ p: path.relative(repo, p).split(path.sep).join('/'), k: kind(p), t: fs.readFileSync(p, 'utf8') }));
const out = {};
for (const f of srcFiles) {
  const stem = f.replace(/^src\//, '').replace(/\.ts$/, ''); const segs = stem.split('/');
  const slash = new RegExp(`(^|[^A-Za-z0-9_/.-]|src/|out/)${esc(stem)}(\\.ts|\\.js|['"\`)\\s:#,])`);
  const joined = new RegExp(segs.slice(0, -1).map(s => `['"]${esc(s)}['"]\\s*,\\s*`).join('') + `['"]${esc(segs.at(-1))}\\.(ts|js)['"]`);
  const r = { tests: [], tooling: [], docs: [], shipped: [] };
  for (const { p, k, t } of texts) if (slash.test(t) || (segs.length > 1 && joined.test(t))) r[k].push(p);
  out[f] = r;
}
console.log(JSON.stringify(out, null, 1));
```

### A.3 `misplaced.mjs`: single-consumer files, folder edges, two-way pairs

```js
// node misplaced.mjs edges.json -> files whose importers all live in ONE other top-level folder
import fs from 'node:fs';
const e = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const inv = {}; for (const [f, outs] of Object.entries(e)) for (const o of outs) (inv[o] ??= []).push(f);
const top = p => { const s = p.split('/'); return s.length > 2 ? s[1] : '(root)'; };
for (const f of Object.keys(e)) {
  const imp = (inv[f] || []).map(top); const own = top(f);
  const others = new Set(imp.filter(t => t !== own));
  if (imp.length && !imp.includes(own) && others.size === 1) console.log(`${f.replace('src/','')}  <- only ${[...others][0]} (${imp.length})`);
}
// folder edge matrix
const m = {}; for (const [f, outs] of Object.entries(e)) for (const o of outs) { const a = top(f), b = top(o); if (a !== b) m[`${a} -> ${b}`] = (m[`${a} -> ${b}`] || 0) + 1; }
console.log('\nFOLDER EDGES'); for (const [k, v] of Object.entries(m).sort()) console.log(v, k);
const cyc = []; for (const k of Object.keys(m)) { const [a, b] = k.split(' -> '); if (a < b && m[`${b} -> ${a}`]) cyc.push(`${a} <-> ${b} ${m[k]}/${m[`${b} -> ${a}`]}`); }
console.log('\nTWO-WAY', cyc.length); cyc.forEach(c => console.log(c));
```

### A.4 `symedges.mjs` + `layers.mjs`: the graph after the move, barrels resolved by name

```js
// node symedges.mjs <extRoot> <edges.json> <movemap.json> > edges-sym.json
// Re-resolves every import that goes through a re-export barrel (movemap value null)
// to the file that really declares each imported name, so the layer check sees the
// edges that remain once the barrels are dissolved.
import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[2]; const e = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); const mm = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const res = (from, spec) => { const b = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)); return e[b + '.ts'] ? b + '.ts' : e[b + '/index.ts'] ? b + '/index.ts' : null; };
function declaring(barrel, name, depth = 0) {
  if (depth > 6) return [];
  const t = read(barrel); const out = [];
  for (const m of t.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[2].split(',').map(s => s.trim().replace(/^type\s+/, '')).filter(Boolean).map(s => { const [a, b] = s.split(/\s+as\s+/); return [a, b || a]; });
    const hit = names.find(([, exported]) => exported === name); if (hit) { const tgt = res(barrel, m[3]); if (tgt) out.push(...(mm[tgt] === null ? declaring(tgt, hit[0], depth + 1) : [tgt])); }
  }
  if (!out.length) for (const m of t.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g)) { const tgt = res(barrel, m[1]); if (!tgt) continue; if (mm[tgt] === null) out.push(...declaring(tgt, name, depth + 1)); else if (new RegExp(`export\\s+(declare\\s+)?(abstract\\s+)?(class|interface|type|enum|const|let|function|async function)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`).test(read(tgt))) out.push(tgt); }
  return out;
}
const ne = {};
for (const [f, outs] of Object.entries(e)) {
  const t = read(f); const set = new Set(outs.filter(o => mm[o] !== null));
  for (const m of t.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]|export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]|const\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[3] || m[6] || m[8]; const list = m[2] || m[5] || m[7]; if (!spec.startsWith('.')) continue;
    const tgt = res(f, spec); if (!tgt || mm[tgt] !== null) continue;
    for (const n of list.split(',').map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+|\s*:\s*/)[0]).filter(Boolean)) { const d = declaring(tgt, n); if (!d.length) console.error('UNRESOLVED NAME', f, n, tgt); d.forEach(x => set.add(x)); }
  }
  for (const m of t.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g)) { const tgt = res(f, m[1]); if (tgt && mm[tgt] === null) e[tgt].forEach(x => mm[x] !== null && set.add(x)); }
  ne[f] = [...set];
}
console.log(JSON.stringify(ne, null, 1));
```

```js
// node layers.mjs <edges-sym.json> <movemap.json> : layer/feature edges after the move (barrels already resolved by symedges)
import fs from 'node:fs';
const e = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); const mm = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const through = (f, seen = new Set()) => mm[f] !== null ? [f] : e[f].flatMap(x => seen.has(x) ? [] : (seen.add(x), through(x, seen)));
const ne = {}; for (const [f, outs] of Object.entries(e)) { if (mm[f] === null) continue; ne[mm[f]] = [...new Set(outs.flatMap(o => through(o)).map(o => mm[o]))].filter(o => o !== mm[f]); }
const RANK = { app: 4, features: 3, core: 2, platform: 1, shared: 0 };
const unit = p => { const s = p.replace('src/', '').split('/'); if (s.length === 1) return ['(root)', 5]; return [s[0] === 'features' || s[0] === 'core' ? `${s[0]}/${s[1]}` : s[0], RANK[s[0]]]; };
const up = {}, cross = {};
for (const [f, outs] of Object.entries(ne)) for (const o of outs) {
  const [a, ra] = unit(f), [b, rb] = unit(o); if (a === b) continue;
  if (rb > ra) (up[`${a} -> ${b}`] ??= []).push(`${f.replace('src/', '')} -> ${o.replace('src/', '')}`);
  else if (ra === rb && ra === 3) (cross[`${a} -> ${b}`] ??= []).push(`${f.replace('src/', '')} -> ${o.replace('src/', '')}`);
}
console.log('UPWARD EDGES (lower layer imports higher)'); for (const [k, v] of Object.entries(up)) { console.log(`${v.length} ${k}`); v.forEach(x => console.log('    ' + x)); }
console.log('\nCROSS-FEATURE EDGES'); for (const [k, v] of Object.entries(cross)) { console.log(`${v.length} ${k}`); v.forEach(x => console.log('    ' + x)); }
// core-internal two-way subsystem pairs
const cu = {}; for (const [f, outs] of Object.entries(ne)) for (const o of outs) { const [a] = unit(f), [b] = unit(o); if (a !== b) cu[`${a}|${b}`] = (cu[`${a}|${b}`] || 0) + 1; }
console.log('\nTWO-WAY UNIT PAIRS'); for (const k of Object.keys(cu)) { const [a, b] = k.split('|'); if (a < b && cu[`${b}|${a}`]) console.log(`${a} <-> ${b} ${cu[k]}/${cu[`${b}|${a}`]}`); }
fs.writeFileSync(process.argv[4] || '/dev/null', JSON.stringify(ne));
```

### A.5 `move-src.mjs`: the codemod for one batch

```js
// Codemod for one move batch: node move-src.mjs <extRoot> <batch.json> [--dry]
// batch.json maps "src/old.ts" -> "src/new.ts" (a subset of the full move map). Every file in src/
// gets its relative import/export/require/import() specifiers rewritten to the new locations,
// then the moved files are renamed with `git mv` (history follows). Run batch 0 first: a barrel
// left behind still resolves (its specifiers are rewritten too) but keeps the old folder alive.
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const [root, batchFile, flag] = process.argv.slice(2); const dry = flag === '--dry';
const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
const all = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : p.endsWith('.ts') && all.push(path.relative(root, p).split(path.sep).join('/')); } })(path.join(root, 'src'));
const exists = new Set(all);
const where = f => batch[f] ?? f;
const resolve = (from, spec) => { const b = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)); return exists.has(b + '.ts') ? b + '.ts' : exists.has(b + '/index.ts') ? b + '/index.ts' : null; };
const relSpec = (fromNew, toNew) => { let r = path.posix.relative(path.posix.dirname(fromNew), toNew.replace(/\.ts$/, '')); if (!r.startsWith('.')) r = './' + r; return r; };
const SPEC = /((?:import|export)\s[^'";]*?from\s*|import\(\s*|require\(\s*|^\s*import\s*)(['"])(\.{1,2}\/[^'"]*)\2/gm;
let changed = 0;
for (const f of all) {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  const next = text.replace(SPEC, (m, pre, q, spec) => {
    const target = resolve(f, spec); if (!target) throw new Error(`unresolved ${spec} in ${f}`);
    if (!batch[f] && !batch[target]) return m;
    const s = relSpec(where(f), where(target)).replace(/\/index$/, spec.endsWith('/index') ? '/index' : '');
    return `${pre}${q}${s}${q}`;
  });
  if (next !== text) { changed++; if (!dry) fs.writeFileSync(path.join(root, f), next); }
}
for (const [from, to] of Object.entries(batch)) { if (dry) { console.log(`git mv ${from} ${to}`); continue; } fs.mkdirSync(path.join(root, path.dirname(to)), { recursive: true }); if (process.env.NO_GIT) fs.renameSync(path.join(root, from), path.join(root, to)); else execFileSync('git', ['mv', from, to], { cwd: root }); }
console.error(`${Object.keys(batch).length} files moved, ${changed} files with rewritten specifiers`);
```

### A.6 `compare-out.mjs`: H3 compiled-module equivalence

```js
// Behaviour-neutrality check for a move: node compare-out.mjs <outBefore> <outAfter> <batch.json>
// Both trees are `tsc --removeComments` outputs. Every compiled module of the old tree must have a
// byte-identical twin in the new tree once each relative require() is replaced by the module it
// resolves to (expressed in new-tree paths). Prints the modules that differ; exit 1 if any.
import fs from 'node:fs'; import path from 'node:path';
const [before, after, batchFile] = process.argv.slice(2);
const batch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
const toOut = p => p.replace(/^src\//, '').replace(/\.ts$/, '.js');
const move = Object.fromEntries(Object.entries(batch).map(([a, b]) => [toOut(a), toOut(b)]));
const list = d => { const r = []; (function w(x) { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); e.isDirectory() ? w(p) : p.endsWith('.js') && r.push(path.relative(d, p).split(path.sep).join('/')); } })(d); return r; };
const norm = (root, file, mapPath) => fs.readFileSync(path.join(root, file), 'utf8').replace(/require\((["'])(\.{1,2}\/[^"']*)\1\)/g, (m, q, spec) => {
  const b = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  const target = fs.existsSync(path.join(root, b + '.js')) ? b + '.js' : b + '/index.js';
  return `require(<${mapPath(target)}>)`;
});
// tsc names each import binding after the module's basename (`visualizeDataItems_1`): a renamed
// file renames the binding. Canonicalize every binding of a relative require to its target.
const canon = text => { let t = text; for (const m of text.matchAll(/([\w$]+) = (?:__\w+\()?require\(<([^>]+)>\)/g)) t = t.replace(new RegExp(`(?<![\\w$])${m[1].replace(/\$/g, '\\$')}(?![\\w$])`, 'g'), `<${m[2]}>`); return t; };
const oldFiles = list(before); const newFiles = new Set(list(after)); const bad = [];
for (const f of oldFiles) {
  const g = move[f] ?? f; if (!newFiles.has(g)) { bad.push(`missing ${g}`); continue; } newFiles.delete(g);
  if (canon(norm(before, f, t => move[t] ?? t)) !== canon(norm(after, g, t => t))) bad.push(`differs ${f} -> ${g}`);
}
for (const g of newFiles) bad.push(`unexpected ${g}`);
console.log(`${oldFiles.length} modules compared, ${bad.length} problems`); bad.forEach(b => console.log('  ' + b));
process.exit(bad.length ? 1 : 0);
```

Usage of A.6 (from `apps/vscode-extension`): `npx tsc -p tsconfig.json --removeComments --outDir /tmp/before` on the parent commit, the same with `--outDir /tmp/after` on the batch commit, then `node compare-out.mjs /tmp/before /tmp/after batch-N.json`.

### A.7 `treestats.mjs`: the tree listing and shape metrics of §1

```js
// node treestats.mjs <extRoot> [movemap.json]   (run from anywhere; read-only)
// Prints folder -> direct files / lines / subtree files / subtree lines, then the shape metrics.
// With a move map, measures the TARGET tree (dissolved barrels dropped) instead of the current one.
import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(process.argv[2]); const map = process.argv[3] && JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(path.relative(root, p).split(path.sep).join('/')); } })(path.join(root, 'src'));
const lines = f => fs.readFileSync(path.join(root, f), 'utf8').split('\n').length - 1;
const rows = files.map(f => [map ? map[f] : f, lines(f)]).filter(([f]) => f);
const dirs = {};
for (const [f, n] of rows) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); dirs[d] ??= { files: 0, lines: 0, tf: 0, tl: 0 }; dirs[d].tf++; dirs[d].tl += n; if (i === parts.length - 1) { dirs[d].files++; dirs[d].lines += n; } } }
for (const d of Object.keys(dirs).sort()) { const x = dirs[d]; console.log(`${'  '.repeat(d.split('/').length - 1)}${d.split('/').at(-1)}/  ${x.files} files ${x.lines} lines (subtree ${x.tf} / ${x.tl})`); }
const names = Object.keys(dirs).map(d => d.split('/').at(-1));
const subdirs = d => Object.keys(dirs).filter(x => x.startsWith(d + '/') && x.split('/').length === d.split('/').length + 1).length;
console.log({
  files: rows.length, lines: rows.reduce((a, [, n]) => a + n, 0), folders: Object.keys(dirs).length,
  snake_case: names.filter(n => n.includes('_')).length, camelCase: names.filter(n => /[a-z][A-Z]/.test(n)).length, kebab: names.filter(n => n.includes('-')).length,
  singleFileLeafFolders: Object.keys(dirs).filter(d => dirs[d].files === 1 && !subdirs(d)).length,
  barrels: rows.filter(([f]) => f.endsWith('/index.ts')).length,
  maxDepth: Math.max(...rows.map(([f]) => f.split('/').length - 2)),
});
```
