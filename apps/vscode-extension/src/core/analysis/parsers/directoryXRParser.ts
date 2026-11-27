/**
 * Directory XR Parser
 * Handles parsing of directory structure for XR visualization.
 */

import * as path from 'path';
import * as fs from 'fs';
import { UnifiedAnalysisSession } from '../session/analysisSession';
import { AnalysisConfigurationStorage } from '../configuration/analysisConfigurationStorage';
import { TemplateProcessor } from '../../charts/processing/templateProcessor';
import { ExecutePython } from '../python/executePython';
import { DimensionMapping } from '../../charts/chartModels';
import { XRFieldSchemaService } from '../python/xrFieldSchemaService';
import { SHA256Generator } from '../utils/sha256Generator';
import { buildTrackedFileSnapshot } from '../watchers/directorySnapshot';
import { resolveTrackedSystemPath } from '../watchers/directoryReanalysisData';
import { ANALYSIS_TABLE_RUNTIME_OUTPUT_NAME, readAnalysisTableRuntimeContent } from '../scene-assets/analysisTableComponentAsset';
import { ANALYSIS_MODE_RUNTIME_OUTPUT_NAME, readAnalysisModeRuntimeContent } from '../scene-assets/analysisModeComponentAsset';
import { HISTORICAL_COMPARISON_RUNTIME_OUTPUT_NAME, readHistoricalComparisonRuntimeContent } from '../scene-assets/historicalComparisonComponentAsset';
import { PROJECT_EVOLUTION_RUNTIME_OUTPUT_NAME, readProjectEvolutionRuntimeContent } from '../scene-assets/projectEvolutionComponentAsset';
import { DEPENDENCY_GRAPH_RUNTIME_OUTPUT_NAME, readDependencyGraphRuntimeContent } from '../scene-assets/dependencyGraphComponentAsset';
import { GUIDE_SCREEN_RUNTIME_OUTPUT_NAME, GUIDE_PAGE_OUTPUT_NAME, readGuideScreenRuntimeContent, readGuidePageContent } from '../scene-assets/guideScreenComponentAsset';
import { LOGO_RUNTIME_OUTPUT_NAME, readLogoRuntimeContent } from '../scene-assets/logoComponentAsset';
import { RENDER_BUDGET_RUNTIME_OUTPUT_NAME, readRenderBudgetRuntimeContent } from '../scene-assets/renderBudgetComponentAsset';
import { DEPENDENCY_VISUAL_BUDGET_RUNTIME_OUTPUT_NAME, readDependencyVisualBudgetRuntimeContent } from '../scene-assets/dependencyVisualBudgetComponentAsset';
import { CODEXR_DEBUG_RUNTIME_OUTPUT_NAME, readCodeXrDebugRuntimeContent } from '../scene-assets/codexrDebugComponentAsset';
import { CODEXR_COMMON_RUNTIME_OUTPUT_NAME, readCodeXrCommonRuntimeContent } from '../scene-assets/commonComponentAsset';
import { CODEXR_AVATAR_RUNTIME_OUTPUT_NAME, readCodeXrAvatarRuntimeContent } from '../scene-assets/avatarComponentAsset';
import { CODEXR_COLLABORATION_RUNTIME_OUTPUT_NAME, readCodeXrCollaborationRuntimeContent } from '../scene-assets/collaborationComponentAsset';
import { CODEXR_ROOM_RUNTIME_OUTPUT_NAME, readCodeXrRoomRuntimeContent, readCodeXrRoomTextureContents } from '../scene-assets/codexrRoomComponentAsset';
import { readCodeXrGitRefPickerContent, CODEXR_GIT_REF_PICKER_OUTPUT_NAME } from '../scene-assets/commonGitRefPickerComponentAsset';
import { readVirtualScreenManagerRuntimeContent, VIRTUAL_SCREEN_MANAGER_RUNTIME_OUTPUT_NAME, readVirtualScreenRuntimeContent, VIRTUAL_SCREEN_RUNTIME_OUTPUT_NAME } from '../scene-assets/virtualScreenComponentAsset';
import { readXrChartDebugRuntimeContent, XR_CHART_DEBUG_RUNTIME_OUTPUT_NAME } from '../scene-assets/xrChartDebugComponentAsset';
import { readXrChartMappingUiRuntimeContent, XR_CHART_MAPPING_UI_RUNTIME_OUTPUT_NAME } from '../scene-assets/xrChartMappingUiComponentAsset';
import { readPointerPolicyRuntimeContent, POINTER_POLICY_RUNTIME_OUTPUT_NAME } from '../scene-assets/pointerPolicyComponentAsset';
import { readImmersiveRigRuntimeContent, IMMERSIVE_RIG_RUNTIME_OUTPUT_NAME } from '../scene-assets/immersiveRigComponentAsset';
import { resolveTemplatePath } from '../../../platform/templatePaths';
import type { CoreContext } from '../../host/hostPaths';

/**
 * The runtime assets a directory XR scene loads: [output name, reader] pairs,
 * shipped as text in this order. The file parser copies the same set
 * (test/analysis/xrRuntimeManifestAsymmetry.test.cjs pins the pairing).
 */
export const DIRECTORY_XR_RUNTIME_ASSETS: ReadonlyArray<readonly [string, (extensionPath: string) => Promise<string>]> = [
    [CODEXR_COMMON_RUNTIME_OUTPUT_NAME, readCodeXrCommonRuntimeContent],
    [CODEXR_GIT_REF_PICKER_OUTPUT_NAME, readCodeXrGitRefPickerContent],
    [CODEXR_AVATAR_RUNTIME_OUTPUT_NAME, readCodeXrAvatarRuntimeContent],
    [CODEXR_COLLABORATION_RUNTIME_OUTPUT_NAME, readCodeXrCollaborationRuntimeContent],
    [VIRTUAL_SCREEN_RUNTIME_OUTPUT_NAME, readVirtualScreenRuntimeContent],
    [VIRTUAL_SCREEN_MANAGER_RUNTIME_OUTPUT_NAME, readVirtualScreenManagerRuntimeContent],
    [CODEXR_ROOM_RUNTIME_OUTPUT_NAME, readCodeXrRoomRuntimeContent],
    [POINTER_POLICY_RUNTIME_OUTPUT_NAME, readPointerPolicyRuntimeContent],
    [IMMERSIVE_RIG_RUNTIME_OUTPUT_NAME, readImmersiveRigRuntimeContent],
    [XR_CHART_MAPPING_UI_RUNTIME_OUTPUT_NAME, readXrChartMappingUiRuntimeContent],
    [XR_CHART_DEBUG_RUNTIME_OUTPUT_NAME, readXrChartDebugRuntimeContent],
    [ANALYSIS_TABLE_RUNTIME_OUTPUT_NAME, readAnalysisTableRuntimeContent],
    [ANALYSIS_MODE_RUNTIME_OUTPUT_NAME, readAnalysisModeRuntimeContent],
    [HISTORICAL_COMPARISON_RUNTIME_OUTPUT_NAME, readHistoricalComparisonRuntimeContent],
    [PROJECT_EVOLUTION_RUNTIME_OUTPUT_NAME, readProjectEvolutionRuntimeContent],
    [RENDER_BUDGET_RUNTIME_OUTPUT_NAME, readRenderBudgetRuntimeContent],
    [DEPENDENCY_VISUAL_BUDGET_RUNTIME_OUTPUT_NAME, readDependencyVisualBudgetRuntimeContent],
    [DEPENDENCY_GRAPH_RUNTIME_OUTPUT_NAME, readDependencyGraphRuntimeContent],
    [GUIDE_SCREEN_RUNTIME_OUTPUT_NAME, readGuideScreenRuntimeContent],
    [GUIDE_PAGE_OUTPUT_NAME, readGuidePageContent],
    [LOGO_RUNTIME_OUTPUT_NAME, readLogoRuntimeContent],
    [CODEXR_DEBUG_RUNTIME_OUTPUT_NAME, readCodeXrDebugRuntimeContent],
];

export interface DirectoryXRParsingResult {
    success: boolean;
    generatedFiles?: Map<string, string>;
    error?: string;
}

interface DirectoryXRSharedBootstrap {
    payload: any[];
    trackedFiles?: { filePath: string; hash: string; size?: number; mtimeMs?: number }[];
}

export class DirectoryXRParser {
    async parseDirectoryForXR(
        session: UnifiedAnalysisSession,
        context: CoreContext,
        bootstrap?: DirectoryXRSharedBootstrap,
    ): Promise<DirectoryXRParsingResult> {
        try {
            const storage = AnalysisConfigurationStorage.getInstance(context);
            const chartType = await storage.getDirectoryChartType();
            const dimensionMappings = await storage.getDimensionMappingDirectory();
            const mappings: DimensionMapping[] = Object.entries(dimensionMappings).map(([dimension, dataField]) => ({
                dimension,
                dataField,
            }));

            const analysisData = bootstrap?.payload ?? await new ExecutePython(context).executeAnalysis({
                ...session,
                analysisMode: 'XR',
                targetType: 'directory',
            });
            const payload = Array.isArray(analysisData) ? analysisData : [];

            if (bootstrap?.trackedFiles) {
                session.filesToHash = bootstrap.trackedFiles;
            } else {
                session.filesToHash = await this.buildTrackedFiles(session, payload);
            }

            const tempOutputPath = path.join(context.storageUri?.fsPath || '/tmp', 'temp_xr_generation');
            await fs.promises.mkdir(tempOutputPath, { recursive: true });
            const tempHtmlPath = path.join(tempOutputPath, 'index.html');
            const babiaUiConfig = await storage.getXRBabiaUiConfig();
            const fieldTypeMap = await XRFieldSchemaService.getInstance(context).getFieldTypeMap('directory');

            const htmlGenerationResult = await TemplateProcessor.generateXRVisualization(
                chartType,
                mappings,
                `Directory Analysis: ${session.targetName}`,
                'data.json',
                context,
                tempHtmlPath,
                payload,
                {
                    babiaUiVisibleByDefault: babiaUiConfig.visibleByDefault,
                    xrTargetType: 'directory',
                    fieldTypeMap,
                },
            );

            if (!htmlGenerationResult.success) {
                return {
                    success: false,
                    error: `HTML generation failed: ${htmlGenerationResult.error}`,
                };
            }

            const htmlContent = await fs.promises.readFile(tempHtmlPath, 'utf8');
            await fs.promises.rm(tempOutputPath, { recursive: true, force: true });

            const jsFilePath = resolveTemplatePath(context.extensionPath, 'xr', 'sse', 'live_sse_fileXR.js');
            if (!fs.existsSync(jsFilePath)) {
                return {
                    success: false,
                    error: `live_sse_fileXR.js not found at: ${jsFilePath}`,
                };
            }

            const jsContent = await fs.promises.readFile(jsFilePath, 'utf8');

            const generatedFiles = new Map<string, string>();
            generatedFiles.set('index.html', htmlContent);
            generatedFiles.set('main.js', jsContent);
            for (const [outputName, readContent] of DIRECTORY_XR_RUNTIME_ASSETS) {
                generatedFiles.set(outputName, await readContent(context.extensionPath));
            }
            const codexrRoomTextures = await readCodeXrRoomTextureContents(context.extensionPath);
            generatedFiles.set('data.json', JSON.stringify(payload, null, 2));
            codexrRoomTextures.forEach((asset) => {
                generatedFiles.set(asset.relativeOutputPath, asset.content);
            });
            session.metadata.mainHtmlFileName = 'index.html';

            return {
                success: true,
                generatedFiles,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private async buildTrackedFiles(
        session: UnifiedAnalysisSession,
        analysisData: any[],
    ): Promise<{ filePath: string; hash: string; size?: number; mtimeMs?: number }[]> {
        const filesToHash: { filePath: string; hash: string; size?: number; mtimeMs?: number }[] = [];

        for (const fileData of analysisData) {
            const trackedPath = resolveTrackedSystemPath(session.targetPath, fileData);
            if (!trackedPath) {
                continue;
            }

            try {
                const fileHash = await SHA256Generator.generateFileHash(trackedPath);
                const trackedSnapshot = await buildTrackedFileSnapshot(trackedPath, fileHash);
                filesToHash.push(trackedSnapshot ?? {
                    filePath: trackedPath,
                    hash: fileHash,
                });
            } catch {
                filesToHash.push({
                    filePath: trackedPath,
                    hash: '',
                });
            }
        }

        return filesToHash;
    }
}

export const directoryXRParser = new DirectoryXRParser();
