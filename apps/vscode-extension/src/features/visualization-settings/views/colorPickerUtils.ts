import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../../platform/logging/sink';
import { resolveTemplatePath } from '../../../platform/templatePaths';

const logger = getLogger('COLOR_PICKER_UTILS');

export interface ColorPickerOptions {
    fieldName: string;
    currentColor: string;
}

export class ColorPickerUtils {
    /**
     * Load and process the color picker HTML template
     */
    public static async loadColorPickerTemplate(
        context: vscode.ExtensionContext,
        options: ColorPickerOptions
    ): Promise<string> {
        try {
            const templatePath = resolveTemplatePath(context.extensionPath, 'utils', 'color-picker.html');
            let templateContent = fs.readFileSync(templatePath, 'utf8');
            
            // Replace placeholders
            templateContent = templateContent
                .replace(/\$\{FIELD_NAME\}/g, options.fieldName)
                .replace(/\$\{CURRENT_COLOR\}/g, options.currentColor);
            
            return templateContent;
        } catch (error) {
            logger.error('[VISUALIZATION-SETTINGS] Error loading color picker template:', error);
            throw new Error(`Failed to load color picker template: ${error}`);
        }
    }
    
    /**
     * Create and configure a webview for the color picker
     */
    public static createColorPickerWebview(
        context: vscode.ExtensionContext,
        options: ColorPickerOptions
    ): vscode.WebviewPanel {
        const panel = vscode.window.createWebviewPanel(
            'colorPicker',
            `Color Picker - ${options.fieldName}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(resolveTemplatePath(context.extensionPath))
                ]
            }
        );
        
        // Set the icon for the panel
        panel.iconPath = {
            light: vscode.Uri.file(path.join(context.extensionPath, 'resources', 'icon.svg')),
            dark: vscode.Uri.file(path.join(context.extensionPath, 'resources', 'icon.svg'))
        };
        
        return panel;
    }
    
    /**
     * Validate hex color format
     */
    public static validateHexColor(color: string): boolean {
        return /^#[0-9a-fA-F]{6}$/.test(color);
    }
    
    /**
     * Normalize color to uppercase hex format
     */
    public static normalizeColor(color: string): string {
        if (this.validateHexColor(color)) {
            return color.toUpperCase();
        }
        return '#FFFFFF'; // Default fallback
    }
    
    /**
     * Get predefined colors for fallback
     */
    public static getPredefinedColors(): string[] {
        return [
            '#FFFFFF', // White
            '#000000', // Black
            '#B10DC9', // Purple
            '#FF4081', // Pink
            '#F44336', // Red
            '#FF9800', // Orange
            '#FFEB3B', // Yellow
            '#4CAF50', // Green
            '#2196F3', // Blue
            '#9C27B0', // Violet
            '#607D8B', // Blue Grey
            '#795548'  // Brown
        ];
    }
}
