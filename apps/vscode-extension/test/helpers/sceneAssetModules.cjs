/**
 * The compiled scene-asset modules, merged into one namespace.
 *
 * Until #55 dissolved it, a re-export barrel (`customComponents/index.ts`)
 * gave the tests this namespace; they look entry points up by name
 * (`components[token]`), so they keep one object, built here from the same
 * 20 modules the barrel re-exported. The folder is named once, in
 * SCENE_ASSETS_OUT.
 */
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const SCENE_ASSETS_OUT = path.join(projectRoot, 'out', 'code_analysis', 'engine', 'components', 'customComponents');

const SCENE_ASSET_MODULES = [
    'virtualScreenComponentAsset',
    'commonComponentAsset',
    'commonGitRefPickerComponentAsset',
    'collaborationComponentAsset',
    'avatarComponentAsset',
    'codexrRoomComponentAsset',
    'pointerPolicyComponentAsset',
    'immersiveRigComponentAsset',
    'xrChartMappingUiComponentAsset',
    'xrChartDebugComponentAsset',
    'analysisTableComponentAsset',
    'analysisModeComponentAsset',
    'historicalComparisonComponentAsset',
    'projectEvolutionComponentAsset',
    'dependencyGraphComponentAsset',
    'guideScreenComponentAsset',
    'logoComponentAsset',
    'renderBudgetComponentAsset',
    'dependencyVisualBudgetComponentAsset',
    'codexrDebugComponentAsset',
];

function loadSceneAssetModules() {
    const merged = {};
    for (const name of SCENE_ASSET_MODULES) {
        for (const [key, value] of Object.entries(require(path.join(SCENE_ASSETS_OUT, `${name}.js`)))) {
            if (!(key in merged)) {
                merged[key] = value;
            }
        }
    }
    return merged;
}

module.exports = { loadSceneAssetModules, SCENE_ASSETS_OUT, SCENE_ASSET_MODULES };
