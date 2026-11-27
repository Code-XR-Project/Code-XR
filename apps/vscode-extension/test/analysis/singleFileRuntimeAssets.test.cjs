'use strict';

/**
 * Behavioural characterization of the eight single-file scene runtimes the
 * customComponents barrel ships (avatar, CodeXR debug, common, Git ref picker,
 * dependency visual budget, immersive rig, pointer policy, render budget):
 * for each, the exported output name, where the source lives under the
 * extension root, what copy*ToOutput writes and returns, what read*Content
 * returns, and the exact "<label> not found at <path>" refusal of every
 * exported entry point when the source is missing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const components = require('../helpers/sceneAssetModules.cjs').loadSceneAssetModules();

const ASSETS = [
    {
        outputConstant: 'CODEXR_AVATAR_RUNTIME_OUTPUT_NAME', outputName: 'codexrAvatarRuntime.js',
        folder: ['templates', 'components', 'codexr', 'avatar'], label: 'Code-XR avatar runtime',
        copy: 'copyCodeXrAvatarRuntimeToOutput', read: 'readCodeXrAvatarRuntimeContent',
        resolve: 'resolveCodeXrAvatarRuntimeSourcePath', assertExists: 'assertCodeXrAvatarRuntimeSourceExists',
    },
    {
        outputConstant: 'CODEXR_DEBUG_RUNTIME_OUTPUT_NAME', outputName: 'codexrDebugRuntime.js',
        folder: ['templates', 'components', 'codexr', 'debug'], label: 'Code-XR debug runtime',
        copy: 'copyCodeXrDebugRuntimeToOutput', read: 'readCodeXrDebugRuntimeContent',
        resolve: 'resolveCodeXrDebugRuntimeSourcePath',
    },
    {
        outputConstant: 'CODEXR_COMMON_RUNTIME_OUTPUT_NAME', outputName: 'codexrCommonRuntime.js',
        folder: ['templates', 'components', 'common'], label: 'Code-XR common runtime',
        copy: 'copyCodeXrCommonRuntimeToOutput', read: 'readCodeXrCommonRuntimeContent',
        resolve: 'resolveCodeXrCommonRuntimeSourcePath', assertExists: 'assertCodeXrCommonRuntimeSourceExists',
    },
    {
        outputConstant: 'CODEXR_GIT_REF_PICKER_OUTPUT_NAME', outputName: 'codexrGitRefPickerRuntime.js',
        folder: ['templates', 'components', 'common'], label: 'Code-XR Git ref picker runtime',
        copy: 'copyCodeXrGitRefPickerToOutput', read: 'readCodeXrGitRefPickerContent',
        resolve: 'resolveCodeXrGitRefPickerSourcePath', assertExists: 'assertCodeXrGitRefPickerSourceExists',
    },
    {
        outputConstant: 'DEPENDENCY_VISUAL_BUDGET_RUNTIME_OUTPUT_NAME', outputName: 'dependencyVisualBudgetRuntime.js',
        folder: ['templates', 'components', 'codexr', 'dependency-visual-budget'], label: 'Dependency visual budget runtime',
        copy: 'copyDependencyVisualBudgetRuntimeToOutput', read: 'readDependencyVisualBudgetRuntimeContent',
        resolve: 'resolveDependencyVisualBudgetRuntimeSourcePath',
    },
    {
        outputConstant: 'IMMERSIVE_RIG_RUNTIME_OUTPUT_NAME', outputName: 'codexrImmersiveRigRuntime.js',
        folder: ['templates', 'components', 'codexr', 'immersive-rig'], label: 'Code-XR immersive-rig runtime',
        copy: 'copyImmersiveRigRuntimeToOutput', read: 'readImmersiveRigRuntimeContent',
        resolve: 'resolveImmersiveRigRuntimeSourcePath', assertExists: 'assertImmersiveRigRuntimeSourceExists',
    },
    {
        outputConstant: 'POINTER_POLICY_RUNTIME_OUTPUT_NAME', outputName: 'codexrPointerPolicyRuntime.js',
        folder: ['templates', 'components', 'codexr', 'pointer-policy'], label: 'Code-XR pointer-policy runtime',
        copy: 'copyPointerPolicyRuntimeToOutput', read: 'readPointerPolicyRuntimeContent',
        resolve: 'resolvePointerPolicyRuntimeSourcePath', assertExists: 'assertPointerPolicyRuntimeSourceExists',
    },
    {
        outputConstant: 'RENDER_BUDGET_RUNTIME_OUTPUT_NAME', outputName: 'renderBudgetRuntime.js',
        folder: ['templates', 'components', 'codexr', 'render-budget'], label: 'Render budget runtime',
        copy: 'copyRenderBudgetRuntimeToOutput', read: 'readRenderBudgetRuntimeContent',
        resolve: 'resolveRenderBudgetRuntimeSourcePath',
    },
];

for (const asset of ASSETS) {
    test(`${asset.outputName}: copy and read ship the source from ${asset.folder.join('/')}`, async () => {
        const sourcePath = path.join(projectRoot, ...asset.folder, asset.outputName);
        const source = fs.readFileSync(sourcePath);
        assert.equal(components[asset.outputConstant], asset.outputName);
        assert.equal(components[asset.resolve](projectRoot), sourcePath);
        if (asset.assertExists) {
            assert.equal(components[asset.assertExists](projectRoot), sourcePath);
        }

        const output = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-runtime-asset-'));
        try {
            const written = await components[asset.copy](projectRoot, output);
            assert.equal(written, path.join(output, asset.outputName));
            assert.deepEqual(fs.readdirSync(output), [asset.outputName]);
            assert.ok(fs.readFileSync(written).equals(source));
        } finally {
            fs.rmSync(output, { recursive: true, force: true });
        }

        assert.equal(await components[asset.read](projectRoot), source.toString('utf8'));
    });

    test(`${asset.outputName}: every entry point refuses a missing source with the same message`, async () => {
        const missingRoot = path.join(os.tmpdir(), 'codexr-no-such-extension-root');
        const expected = { message: `${asset.label} not found at ${path.join(missingRoot, ...asset.folder, asset.outputName)}` };
        await assert.rejects(components[asset.copy](missingRoot, os.tmpdir()), expected);
        await assert.rejects(components[asset.read](missingRoot), expected);
        if (asset.assertExists) {
            assert.throws(() => components[asset.assertExists](missingRoot), expected);
        }
    });
}
