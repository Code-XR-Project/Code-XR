import * as vscode from 'vscode';
import * as path from 'path';
import { TemplateHTMLProcessor, HTMLTemplateData } from '../../../babia_templates/processing/templateHTMLProcessor';
import { CODEXR_AVATAR_RUNTIME_OUTPUT_NAME, readCodeXrAvatarRuntimeContent } from '../components/customComponents/avatarComponentAsset';
import { CODEXR_COLLABORATION_RUNTIME_OUTPUT_NAME, CODEXR_DOM_SCENE_COLLAB_RUNTIME_OUTPUT_NAME, readCodeXrCollaborationRuntimeContent, readCodeXrDomSceneCollaborationRuntimeContent } from '../components/customComponents/collaborationComponentAsset';
import { readVirtualScreenManagerRuntimeContent, VIRTUAL_SCREEN_MANAGER_RUNTIME_OUTPUT_NAME, readVirtualScreenRuntimeContent, VIRTUAL_SCREEN_RUNTIME_OUTPUT_NAME } from '../components/customComponents/virtualScreenComponentAsset';
import { readPointerPolicyRuntimeContent, POINTER_POLICY_RUNTIME_OUTPUT_NAME } from '../components/customComponents/pointerPolicyComponentAsset';
import { readImmersiveRigRuntimeContent, IMMERSIVE_RIG_RUNTIME_OUTPUT_NAME } from '../components/customComponents/immersiveRigComponentAsset';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('VISUALIZE_DOM_PARSER');

/**
 * VisualizeDOM Parser - Bridge to TemplateHTMLProcessor
 * 
 * This class:
 * - Acts as a bridge between the new engine and the existing templateHTMLProcessor
 * - Processes HTML files for DOM visualization
 * - Returns processed template files ready for visualization
 */
export class VisualizeDOMParser {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        logger.debug('Initializing VisualizeDOMParser...');
        this.context = context;
        logger.debug('VisualizeDOMParser initialized successfully');
    }

    /**
     * Process HTML templates for DOM visualization
     * This is essentially a bridge to the templateHTMLProcessor
     * 
     * @param templateData - HTML content and metadata
     * @param theme - Current user theme (optional)
     * @returns Map with fileName -> processed content
     */
    public async processHTMLTemplates(
        templateData: HTMLTemplateData, 
        theme?: string,
        _virtualScreenSessionId?: string,
    ): Promise<Map<string, string>> {
        logger.debug(`Processing HTML templates for DOM visualization`);
        logger.debug(() => `File: ${templateData.fileName}`);
        logger.debug(() => `HTML content length: ${templateData.htmlContent.length}`);
        logger.debug(() => `Theme: ${theme || 'default'}`);

        try {
            // STEP 1: Validate template data
            logger.debug(`Step 1 - Validating template data...`);
            if (!TemplateHTMLProcessor.validateTemplateData(templateData)) {
                logger.error(`Template data validation failed`);
                throw new Error('Invalid template data provided');
            }
            logger.debug(`Template data validation passed`);

            // STEP 2: Call templateHTMLProcessor to get processed HTML and JS
            logger.debug(`Step 2 - Calling TemplateHTMLProcessor...`);
            logger.debug(`Calling with templateData:`, {
                fileName: templateData.fileName,
                filePath: templateData.filePath,
                title: templateData.title,
                htmlContentLength: templateData.htmlContent.length
            });
            
            const processingResult = await TemplateHTMLProcessor.processHTMLTemplate(
                templateData,
                this.context
            );

            // DEBUG: Log detailed information about what templateHTMLProcessor returned
            logger.debug(`TemplateHTMLProcessor returned:`, {
                
                success: processingResult.success,
                hasIndexHtml: !!processingResult.indexHtml,
                hasJsContent: !!processingResult.jsContent,
                indexHtmlLength: processingResult.indexHtml?.length || 0,
                jsContentLength: processingResult.jsContent?.length || 0,
                error: processingResult.error || 'No error'
            });

            if (!processingResult.success) {
                logger.error(`TemplateHTMLProcessor failed:`, processingResult.error);
                throw new Error(`Template processing failed: ${processingResult.error}`);
            }

            if (!processingResult.indexHtml || !processingResult.jsContent) {
                logger.error(`TemplateHTMLProcessor returned incomplete data:`, {
                    hasIndexHtml: !!processingResult.indexHtml,
                    hasJsContent: !!processingResult.jsContent
                });
                throw new Error('TemplateHTMLProcessor returned incomplete data');
            }

            const { indexHtml, jsContent } = processingResult;
            logger.debug(`TemplateHTMLProcessor returned complete data`);
            logger.debug(() => `indexHtml: ${indexHtml.length} chars`);
            logger.debug(() => `jsContent: ${jsContent.length} chars`);

            // STEP 3: Create result Map with the two files from templateHTMLProcessor
            logger.debug(`Step 3 - Creating result Map...`);
            const resultFiles = new Map<string, string>();

            // Add index.html from templateHTMLProcessor
            resultFiles.set('index.html', indexHtml);
            logger.debug(() => `Added index.html (${indexHtml.length} chars)`);

            // Add main.js from templateHTMLProcessor 
            resultFiles.set('main.js', jsContent);
            logger.debug(() => `Added main.js (${jsContent.length} chars)`);
            const avatarRuntime = await readCodeXrAvatarRuntimeContent(this.context.extensionPath);
            resultFiles.set(CODEXR_AVATAR_RUNTIME_OUTPUT_NAME, avatarRuntime);
            logger.debug(() => `Added ${CODEXR_AVATAR_RUNTIME_OUTPUT_NAME} (${avatarRuntime.length} chars)`);
            const collaborationRuntime = await readCodeXrCollaborationRuntimeContent(this.context.extensionPath);
            resultFiles.set(CODEXR_COLLABORATION_RUNTIME_OUTPUT_NAME, collaborationRuntime);
            logger.debug(() => `Added ${CODEXR_COLLABORATION_RUNTIME_OUTPUT_NAME} (${collaborationRuntime.length} chars)`);
            const virtualScreenRuntime = await readVirtualScreenRuntimeContent(this.context.extensionPath);
            resultFiles.set(VIRTUAL_SCREEN_RUNTIME_OUTPUT_NAME, virtualScreenRuntime);
            logger.debug(() => `Added ${VIRTUAL_SCREEN_RUNTIME_OUTPUT_NAME} (${virtualScreenRuntime.length} chars)`);
            const virtualScreenManagerRuntime = await readVirtualScreenManagerRuntimeContent(this.context.extensionPath);
            resultFiles.set(VIRTUAL_SCREEN_MANAGER_RUNTIME_OUTPUT_NAME, virtualScreenManagerRuntime);
            logger.debug(() => `Added ${VIRTUAL_SCREEN_MANAGER_RUNTIME_OUTPUT_NAME} (${virtualScreenManagerRuntime.length} chars)`);
            const domSceneCollaborationRuntime = await readCodeXrDomSceneCollaborationRuntimeContent(this.context.extensionPath);
            resultFiles.set(CODEXR_DOM_SCENE_COLLAB_RUNTIME_OUTPUT_NAME, domSceneCollaborationRuntime);
            logger.debug(() => `Added ${CODEXR_DOM_SCENE_COLLAB_RUNTIME_OUTPUT_NAME} (${domSceneCollaborationRuntime.length} chars)`);
            const pointerPolicyRuntime = await readPointerPolicyRuntimeContent(this.context.extensionPath);
            resultFiles.set(POINTER_POLICY_RUNTIME_OUTPUT_NAME, pointerPolicyRuntime);
            logger.debug(() => `Added ${POINTER_POLICY_RUNTIME_OUTPUT_NAME} (${pointerPolicyRuntime.length} chars)`);
            const immersiveRigRuntime = await readImmersiveRigRuntimeContent(this.context.extensionPath);
            resultFiles.set(IMMERSIVE_RIG_RUNTIME_OUTPUT_NAME, immersiveRigRuntime);
            logger.debug(() => `Added ${IMMERSIVE_RIG_RUNTIME_OUTPUT_NAME} (${immersiveRigRuntime.length} chars)`);

            logger.debug(() => `Successfully created Map with ${resultFiles.size} files`);
            return resultFiles;

        } catch (error) {
            logger.error(`Error processing HTML templates:`, error);
            throw error;
        }
    }

    /**
     * Get supported file extensions for DOM visualization
     */
    public static getSupportedExtensions(): string[] {
        return TemplateHTMLProcessor.getSupportedExtensions();
    }

    /**
     * Validate if a file can be processed for DOM visualization
     */
    public static canProcessFile(filePath: string): boolean {
        const supportedExtensions = this.getSupportedExtensions();
        const fileExtension = path.extname(filePath).toLowerCase();
        
        logger.debug(() => `Checking if file can be processed: ${filePath}`);
        logger.debug(() => `File extension: ${fileExtension}`);
        
        const canProcess = supportedExtensions.includes(fileExtension);
        if (canProcess) {
            logger.debug(() => `File ${filePath} can be processed`);
        } else {
            logger.debug(() => `File ${filePath} cannot be processed. Supported: ${supportedExtensions.join(', ')}`);
        }
        
        return canProcess;
    }
}



