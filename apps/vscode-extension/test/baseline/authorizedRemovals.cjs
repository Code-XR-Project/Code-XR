'use strict';

/**
 * The ONLY entries of the feature baseline that are allowed to disappear.
 *
 * Source: the maintainer decisions of 2026-09-18 (.claude/docs/v1.2.1/ROADMAP.md
 * section B) and the authorized-removals register of
 * docs/cleanup/feature-baseline.md (section 0.3). Each removal lands with a
 * CHANGELOG line. Anything not listed here that vanishes from the extension is
 * a lost feature, and featureBaseline.test.cjs fails on it.
 *
 * Keys are the snapshot sections of featureSurface.cjs; values are entries as
 * they appear in that section. To authorize a new removal, add it here in the
 * same commit that removes it, with the reason, and get the maintainer's ok.
 */

// R1: registered commands nothing can invoke (W2-45..W2-49).
const UNREACHABLE_COMMANDS = [
    'codeXR.analysis.setAnalysisFileModeXR',
    'codeXR.analysis.setAnalysisFileModeHivePanel',
    'codeXR.analysis.setViewThemeDark',
    'codeXR.analysis.setViewThemeLight',
    'codeXR.analysis.enableAutoAnalysis',
    'codeXR.analysis.disableAutoAnalysis',
    'codeXR.analysis.setAutoAnalysisDelayRealTime',
    'codeXR.analysis.setAutoAnalysisDelay1s',
    'codeXR.analysis.setAutoAnalysisDelay3s',
    'codeXR.analysis.setAutoAnalysisDelay5s',
    'codeXR.analysis.setAutoAnalysisDelay10s',
    'codeXR.analysis.refreshFilesByLanguage',
    'codeXR.analysis.openFileFromLanguageGroup',
    'codeXR.analysis.cleanAnalysis',
    'codeXR.visualizeData.debugState',
    'codexr.debug.themeConfiguration',
    'codexr.debug.themeWorkflow',
];

const AUTHORIZED_REMOVALS = {
    registeredCommands: [
        ...UNREACHABLE_COMMANDS,
        // R2: the Hello World scaffold (W2-50).
        'CodeXR.helloWorld',
    ],
    contributedCommands: [
        // R2
        'CodeXR.helloWorld | Hello World',
    ],
    templateFiles: [
        // R5: the abandoned visual-style feature (ROADMAP B.4, W2-55).
        'components/common/codexrVisualStyleRuntime.js',
        // R6: unreferenced live-reload client (W2-53).
        'xr/html/htmlLiveReload.js',
    ],
    pythonCli: [
        // R7: the unread --output flag and the 'project' --type alias (W2-62).
        'flag:--output',
        'type:project',
    ],
    npmScripts: [
        // R9: the empty integration-test lane (ROADMAP B.4, W2-68).
        'test:integration',
    ],
};

module.exports = { AUTHORIZED_REMOVALS, UNREACHABLE_COMMANDS };
