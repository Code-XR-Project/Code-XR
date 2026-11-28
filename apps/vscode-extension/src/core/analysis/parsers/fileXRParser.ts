import * as fs from 'fs';
import * as path from 'path';
import { UnifiedAnalysisSession } from '../session/analysisSession';
import { AnalysisConfigurationStorage } from '../configuration/analysisConfigurationStorage';
import { DimensionValidator } from '../../charts/processing/dimensionValidator';
import { chartTemplates } from '../../charts/templateCharts';
import { ChartMetadata, DimensionMapping } from '../../charts/chartModels';
import { TemplateProcessor } from '../../charts/processing/templateProcessor';
import { ExecutePython } from '../python/executePython';
import { XRFieldSchemaService } from '../python/xrFieldSchemaService';
import { ANALYSIS_TABLE_RUNTIME_OUTPUT_NAME, copyAnalysisTableRuntimeToOutput } from '../scene-assets/analysisTableComponentAsset';
import { ANALYSIS_MODE_RUNTIME_OUTPUT_NAME, copyAnalysisModeRuntimeToOutput } from '../scene-assets/analysisModeComponentAsset';
import { HISTORICAL_COMPARISON_RUNTIME_OUTPUT_NAME, copyHistoricalComparisonRuntimeToOutput } from '../scene-assets/historicalComparisonComponentAsset';
import { PROJECT_EVOLUTION_RUNTIME_OUTPUT_NAME, copyProjectEvolutionRuntimeToOutput } from '../scene-assets/projectEvolutionComponentAsset';
import { copyAgentFlowRuntimeToOutput } from '../scene-assets/agentFlowComponentAsset';
import { CODEXR_COMMON_RUNTIME_OUTPUT_NAME, copyCodeXrCommonRuntimeToOutput } from '../scene-assets/commonComponentAsset';
import { CODEXR_AVATAR_RUNTIME_OUTPUT_NAME, copyCodeXrAvatarRuntimeToOutput } from '../scene-assets/avatarComponentAsset';
import { copyCodeXrGitRefPickerToOutput } from '../scene-assets/commonGitRefPickerComponentAsset';
import { CODEXR_COLLABORATION_RUNTIME_OUTPUT_NAME, copyCodeXrCollaborationRuntimeToOutput } from '../scene-assets/collaborationComponentAsset';
import { copyCodeXrRoomAssetsToOutput, CODEXR_ROOM_RUNTIME_OUTPUT_NAME } from '../scene-assets/codexrRoomComponentAsset';
import { copyVirtualScreenManagerRuntimeToOutput, copyVirtualScreenRuntimeToOutput, VIRTUAL_SCREEN_MANAGER_RUNTIME_OUTPUT_NAME, VIRTUAL_SCREEN_RUNTIME_OUTPUT_NAME } from '../scene-assets/virtualScreenComponentAsset';
import { copyXrChartDebugRuntimeToOutput, XR_CHART_DEBUG_RUNTIME_OUTPUT_NAME } from '../scene-assets/xrChartDebugComponentAsset';
import { copyXrChartMappingUiRuntimeToOutput, XR_CHART_MAPPING_UI_RUNTIME_OUTPUT_NAME } from '../scene-assets/xrChartMappingUiComponentAsset';
import { copyPointerPolicyRuntimeToOutput, POINTER_POLICY_RUNTIME_OUTPUT_NAME } from '../scene-assets/pointerPolicyComponentAsset';
import { copyImmersiveRigRuntimeToOutput, IMMERSIVE_RIG_RUNTIME_OUTPUT_NAME } from '../scene-assets/immersiveRigComponentAsset';
import { copyCodeXrDebugRuntimeToOutput, CODEXR_DEBUG_RUNTIME_OUTPUT_NAME } from '../scene-assets/codexrDebugComponentAsset';
import { copyRenderBudgetRuntimeToOutput, RENDER_BUDGET_RUNTIME_OUTPUT_NAME } from '../scene-assets/renderBudgetComponentAsset';
import { copyDependencyVisualBudgetRuntimeToOutput, DEPENDENCY_VISUAL_BUDGET_RUNTIME_OUTPUT_NAME } from '../scene-assets/dependencyVisualBudgetComponentAsset';
import { copyDependencyGraphRuntimeToOutput, DEPENDENCY_GRAPH_RUNTIME_OUTPUT_NAME } from '../scene-assets/dependencyGraphComponentAsset';
import { copyGuideScreenRuntimeToOutput, copyGuidePageToOutput, GUIDE_SCREEN_RUNTIME_OUTPUT_NAME, GUIDE_PAGE_OUTPUT_NAME } from '../scene-assets/guideScreenComponentAsset';
import { copyLogoRuntimeToOutput, LOGO_RUNTIME_OUTPUT_NAME } from '../scene-assets/logoComponentAsset';
import { getLogger } from '../../../platform/logging/sink';
import { resolveTemplatePath } from '../../../platform/templatePaths';
import { getHost } from '../../host/hostRegistry';
import type { CoreContext } from '../../host/hostPaths';

const logger = getLogger('FILE_XR_PARSER');

/**
 * The runtime assets a file XR scene loads, copied in this order. The
 * required-files guard below checks a strict subset of them on purpose
 * (test/analysis/xrRuntimeManifestAsymmetry.test.cjs).
 */
const FILE_XR_COPY_STEPS: ReadonlyArray<(extensionPath: string, outputDirectory: string) => Promise<unknown>> = [
    copyVirtualScreenRuntimeToOutput,
    copyVirtualScreenManagerRuntimeToOutput,
    copyCodeXrCommonRuntimeToOutput,
    copyCodeXrGitRefPickerToOutput,
    copyCodeXrAvatarRuntimeToOutput,
    copyCodeXrCollaborationRuntimeToOutput,
    copyCodeXrRoomAssetsToOutput,
    copyPointerPolicyRuntimeToOutput,
    copyImmersiveRigRuntimeToOutput,
    copyXrChartMappingUiRuntimeToOutput,
    copyXrChartDebugRuntimeToOutput,
    copyRenderBudgetRuntimeToOutput,
    copyDependencyVisualBudgetRuntimeToOutput,
    copyDependencyGraphRuntimeToOutput,
    copyAgentFlowRuntimeToOutput,
    copyCodeXrDebugRuntimeToOutput,
    copyAnalysisTableRuntimeToOutput,
    copyAnalysisModeRuntimeToOutput,
    copyHistoricalComparisonRuntimeToOutput,
    copyProjectEvolutionRuntimeToOutput,
    copyGuideScreenRuntimeToOutput,
    copyGuidePageToOutput,
    copyLogoRuntimeToOutput,
];

/**
 * The files a file XR scene must have before it is served. Deliberately a
 * strict subset of what is written: the git ref picker is copied but never
 * verified, so a scene without it still opens (pinned by
 * test/analysis/xrRuntimeManifestAsymmetry.test.cjs).
 */
const FILE_XR_REQUIRED_OUTPUTS: readonly string[] = [
    'index.html',
    'data.json',
    CODEXR_COMMON_RUNTIME_OUTPUT_NAME,
    CODEXR_AVATAR_RUNTIME_OUTPUT_NAME,
    CODEXR_COLLABORATION_RUNTIME_OUTPUT_NAME,
    VIRTUAL_SCREEN_RUNTIME_OUTPUT_NAME,
    VIRTUAL_SCREEN_MANAGER_RUNTIME_OUTPUT_NAME,
    CODEXR_ROOM_RUNTIME_OUTPUT_NAME,
    POINTER_POLICY_RUNTIME_OUTPUT_NAME,
    IMMERSIVE_RIG_RUNTIME_OUTPUT_NAME,
    XR_CHART_MAPPING_UI_RUNTIME_OUTPUT_NAME,
    XR_CHART_DEBUG_RUNTIME_OUTPUT_NAME,
    CODEXR_DEBUG_RUNTIME_OUTPUT_NAME,
    RENDER_BUDGET_RUNTIME_OUTPUT_NAME,
    DEPENDENCY_VISUAL_BUDGET_RUNTIME_OUTPUT_NAME,
    DEPENDENCY_GRAPH_RUNTIME_OUTPUT_NAME,
    ANALYSIS_TABLE_RUNTIME_OUTPUT_NAME,
    ANALYSIS_MODE_RUNTIME_OUTPUT_NAME,
    HISTORICAL_COMPARISON_RUNTIME_OUTPUT_NAME,
    PROJECT_EVOLUTION_RUNTIME_OUTPUT_NAME,
    GUIDE_SCREEN_RUNTIME_OUTPUT_NAME,
    GUIDE_PAGE_OUTPUT_NAME,
    LOGO_RUNTIME_OUTPUT_NAME,
];

interface FileXRSharedBootstrap {
    payload: any[];
}

export interface ParsedXRFileAnalysis {
    sessionId: string;
    chartType: string;
    chartMetadata: ChartMetadata;
    dimensionMappings: DimensionMapping[];
    validationResult: any;
    loadedFiles: Map<string, string>;
}

export class FileXRParser {
    private context: CoreContext;
    private configStorage: AnalysisConfigurationStorage;

    constructor(context: CoreContext) {
        this.context = context;
        this.configStorage = AnalysisConfigurationStorage.getInstance(context);
    }

    public async parseFileAnalysis(
        session: UnifiedAnalysisSession,
        _theme?: string,
        bootstrap?: FileXRSharedBootstrap,
    ): Promise<ParsedXRFileAnalysis> {
        try {
            const chartType = await this.configStorage.getChartTypeFile();
            if (!chartType) {
                throw new Error('No chart type configured. Please select a chart type in the Analysis Settings.');
            }

            const chartMetadata = chartTemplates.find((chart) => chart.id === chartType);
            if (!chartMetadata) {
                throw new Error(`Chart type "${chartType}" not found in available charts.`);
            }

            const dimensionMappings = await this.configStorage.getDimensionMappingFile();
            const babiaFormatMappings: DimensionMapping[] = Object.entries(dimensionMappings).map(([dimension, dataField]) => ({
                dimension,
                dataField,
            }));

            // With the schema's field types the validator can also catch a
            // mapping that names a non-existent field (without them the type
            // pass is skipped entirely).
            const validationFieldTypes = await XRFieldSchemaService.getInstance(this.context)
                .getFieldTypeMap('file')
                .catch(() => undefined);
            const validationResult = DimensionValidator.validateMappings(chartMetadata, babiaFormatMappings, validationFieldTypes);
            this.displayConfigurationInfo(chartType, chartMetadata, babiaFormatMappings, validationResult);

            const analysisData = bootstrap?.payload ?? await new ExecutePython(this.context).executeAnalysis(session);
            if (!Array.isArray(analysisData) || analysisData.length === 0) {
                throw new Error('Python analysis returned no data. Cannot generate XR visualization.');
            }

            await fs.promises.mkdir(session.outputPath, { recursive: true });

            const dataJsonPath = path.join(session.outputPath, 'data.json');
            await fs.promises.writeFile(dataJsonPath, JSON.stringify(analysisData, null, 2), 'utf8');

            const liveSSEPath = resolveTemplatePath(this.context.extensionPath, 'xr', 'sse', 'live_sse_fileXR.js');
            const mainJSPath = path.join(session.outputPath, 'main.js');
            if (fs.existsSync(liveSSEPath)) {
                await fs.promises.copyFile(liveSSEPath, mainJSPath);
            }

            for (const copyToOutput of FILE_XR_COPY_STEPS) {
                await copyToOutput(this.context.extensionPath, session.outputPath);
            }

            const title = `XR Analysis: ${session.targetName || 'analysis'}`;
            const outputPath = path.join(session.outputPath, 'index.html');
            const babiaUiConfig = await this.configStorage.getXRBabiaUiConfig();
            const fieldTypeMap = await XRFieldSchemaService.getInstance(this.context).getFieldTypeMap('file');
            const templateResult = await TemplateProcessor.generateXRVisualization(
                chartType,
                babiaFormatMappings,
                title,
                'data.json',
                this.context,
                outputPath,
                analysisData,
                {
                    babiaUiVisibleByDefault: babiaUiConfig.visibleByDefault,
                    xrTargetType: 'file',
                    fieldTypeMap,
                },
            );

            if (!templateResult.success) {
                throw new Error(`Template generation failed: ${templateResult.error}`);
            }

            const loadedFiles = await this.loadGeneratedFiles(session.outputPath);
            if (FILE_XR_REQUIRED_OUTPUTS.some((name) => !loadedFiles.has(name))) {
                throw new Error('XR file bootstrap did not generate the required files.');
            }

            session.metadata.mainHtmlFileName = 'index.html';

            return {
                sessionId: session.id,
                chartType,
                chartMetadata,
                dimensionMappings: babiaFormatMappings,
                validationResult,
                loadedFiles,
            };
        } catch (error) {
            void getHost().notifier.notify('error',
                `XR Analysis Configuration Error: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
        }
    }

    private displayConfigurationInfo(
        chartType: string,
        chartMetadata: ChartMetadata,
        dimensionMappings: DimensionMapping[],
        validationResult: any,
    ): void {
        const mappingsCount = dimensionMappings.length;
        const dimensionsCount = chartMetadata.dimensions.length;
        const requiredDimensionsCount = chartMetadata.dimensions.filter((dimension) => dimension.required).length;
        const summaryMessage = `${chartType} chart with ${mappingsCount}/${dimensionsCount} dimensions mapped (${requiredDimensionsCount} required)`;

        if (validationResult.isValid) {
            void getHost().notifier.notify('info', `XR config ready: ${summaryMessage}`);
        } else {
            void getHost().notifier.notify('warning', `XR config needs attention: ${summaryMessage}`);
        }

        logger.debug('Current XR file configuration', {
            chartType,
            dimensionMappings,
            validationResult,
        });
    }

    private async loadGeneratedFiles(outputPath: string): Promise<Map<string, string>> {
        const loadedFiles = new Map<string, string>();

        if (!fs.existsSync(outputPath)) {
            return loadedFiles;
        }

        const files = await fs.promises.readdir(outputPath, { withFileTypes: true });
        for (const file of files) {
            if (!file.isFile()) {
                continue;
            }

            const filePath = path.join(outputPath, file.name);
            loadedFiles.set(file.name, await fs.promises.readFile(filePath, 'utf8'));
        }

        return loadedFiles;
    }
}

