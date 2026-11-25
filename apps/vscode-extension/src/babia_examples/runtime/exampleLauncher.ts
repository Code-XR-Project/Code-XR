import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BabiaExample, ExampleScanResult } from '../model/babiaExampleModel';
import { MultiServerLauncher, MultiServerLaunchResult } from '../../servers/runtime/multiServerLauncher';
import { getLogger } from '../../core/logging/sink';

const logger = getLogger('EXAMPLES');

/**
 * Example Launcher
 * Responsible for launching Babia examples using the existing server infrastructure
 */
export class ExampleLauncher {
    private multiServerLauncher: MultiServerLauncher;
    private examplesCache: BabiaExample[] = [];
    private lastScanTime: number = 0;
    private readonly CACHE_DURATION = 30000; // 30 seconds

    constructor(private context: vscode.ExtensionContext) {
        this.multiServerLauncher = new MultiServerLauncher(context);
        logger.debug('Example launcher initialized');
    }

    /**
     * Scan for Babia examples in the charts directory
     * @returns Promise<ExampleScanResult>
     */
    public async scanExamples(): Promise<ExampleScanResult> {
        logger.debug('Scanning for Babia examples...');
        
        const result: ExampleScanResult = {
            examples: [],
            validCount: 0,
            invalidCount: 0,
            errors: []
        };

        try {            let workspaceRoot = this.context.extensionPath;
            let chartsPath = path.join(workspaceRoot, 'examples', 'charts');
            logger.debug(() => `Resolved extension root: ${workspaceRoot}`);
            if (!fs.existsSync(chartsPath)) {
                // Method 3: Try to find from VS Code workspace folders as fallback
                const workspaceRoots = vscode.workspace.workspaceFolders;
                if (workspaceRoots && workspaceRoots.length > 0) {
                    const potentialCodeXRRoot = workspaceRoots.find(folder => 
                        folder.name === 'CodeXR' || 
                        folder.uri.fsPath.includes('CodeXR') ||
                        fs.existsSync(path.join(folder.uri.fsPath, 'examples', 'charts'))
                    );
                    
                    if (potentialCodeXRRoot) {
                        workspaceRoot = potentialCodeXRRoot.uri.fsPath;
                        chartsPath = path.join(workspaceRoot, 'examples', 'charts');
                        logger.debug(() => `Found CodeXR from workspace folders: ${workspaceRoot}`);
                    } else {
                        result.errors.push('Could not find CodeXR directory with examples/charts');
                        return result;
                    }
                } else {
                    result.errors.push('No workspace folder open and CodeXR path not found');
                    return result;
                }
            }
            
            logger.debug(() => `Using workspace root: ${workspaceRoot}`);
            
            logger.debug(() => `Scanning charts directory: ${chartsPath}`);

            if (!fs.existsSync(chartsPath)) {
                result.errors.push(`Charts directory not found: ${chartsPath}`);
                return result;
            }

            const chartDirectories = fs.readdirSync(chartsPath)
                .filter(item => {
                    const itemPath = path.join(chartsPath, item);
                    return fs.statSync(itemPath).isDirectory();
                });

            logger.debug(() => `Found ${chartDirectories.length} chart directories`);

            for (const chartDir of chartDirectories) {
                const chartPath = path.join(chartsPath, chartDir);
                const example = await this.processExampleDirectory(chartPath, chartDir);
                
                if (example) {
                    logger.debug(() => `FOUND chart ${chartDir} example`);
                    result.examples.push(example);
                    if (example.isValid) {
                        result.validCount++;
                    } else {
                        result.invalidCount++;
                    }
                }
            }

            // Update cache
            this.examplesCache = result.examples;
            this.lastScanTime = Date.now();

            logger.debug(() => `total found ${result.examples.length}`);
            logger.debug(() => `Scan complete. Found ${result.validCount} valid and ${result.invalidCount} invalid examples`);

        } catch (error) {
            const errorMsg = `Failed to scan examples: ${error instanceof Error ? error.message : String(error)}`;
            logger.error(errorMsg);
            result.errors.push(errorMsg);
        }

        return result;
    }

    /**
     * Get cached examples or scan if cache is stale
     * @returns Promise<BabiaExample[]>
     */
    public async getExamples(): Promise<BabiaExample[]> {
        const now = Date.now();
        if (this.examplesCache.length === 0 || (now - this.lastScanTime) > this.CACHE_DURATION) {
            logger.debug('Cache is stale, rescanning...');
            const result = await this.scanExamples();
            return result.examples;
        }
        
        logger.debug(() => `Using cached examples (${this.examplesCache.length} items)`);
        return this.examplesCache;
    }

    /**
     * Launch a specific Babia example
     * @param example The example to launch
     * @returns Promise<MultiServerLaunchResult>
     */
    public async launchExample(example: BabiaExample): Promise<MultiServerLaunchResult> {
        logger.debug(() => `Launching example "${example.name}" from ${example.htmlFilePath}`);

        try {
            if (!example.isValid) {
                throw new Error(`Example "${example.name}" is not valid - missing HTML file`);
            }

            if (!fs.existsSync(example.htmlFilePath)) {
                throw new Error(`HTML file not found: ${example.htmlFilePath}`);
            }

            logger.debug(`Delegating launch to multi-server launcher with user configuration`);
            
            // Create custom name in format "ExampleName" (already ends with proper format from scanning)
            const customName = example.name; // e.g., "DonutExample", "BarsExample"
            logger.debug(() => `SERVER: Using custom name '${customName}' for example server`);
            
            // Delegate everything to the multi-server launcher
            // This will handle:
            // - Reading current user configuration (HTTP mode, port, auto-open, lateral panel vs browser)
            // - Launching server with correct settings
            // - Auto-opening in the configured mode (if enabled)
            // - Registering in Active Servers
            const result = await this.multiServerLauncher.launchServer(example.htmlFilePath, customName);

            if (result.success) {
                logger.debug(() => `Successfully launched example "${example.name}" on port ${result.port}`);
                logger.debug(`Server configuration and auto-opening handled by shared infrastructure`);
            } else {
                logger.error(`Failed to launch example "${example.name}":`, result.error);
                vscode.window.showErrorMessage(`Failed to launch example "${example.name}": ${result.error}`);
            }

            return result;

        } catch (error) {
            const errorMsg = `Failed to launch example "${example.name}": ${error instanceof Error ? error.message : String(error)}`;
            logger.error(errorMsg);
            
            vscode.window.showErrorMessage(errorMsg);
            
            return {
                success: false,
                error: errorMsg
            };
        }
    }

    /**
     * Process a single example directory
     * @private
     */
    private async processExampleDirectory(directoryPath: string, categoryName: string): Promise<BabiaExample | null> {
        try {
            logger.debug(() => `Processing directory: ${directoryPath}`);

            // Look for HTML files in the directory
            const files = fs.readdirSync(directoryPath);
            const htmlFiles = files.filter(file => file.toLowerCase().endsWith('.html'));

            logger.debug(() => `Found ${htmlFiles.length} HTML files in ${categoryName}: ${htmlFiles.join(', ')}`);

            if (htmlFiles.length === 0) {
                logger.debug(() => `No HTML files found in ${categoryName}`);
                return {
                    id: this.generateExampleId(categoryName, 'no-html'),
                    name: categoryName,
                    htmlFilePath: '',
                    directory: directoryPath,
                    category: categoryName,
                    description: 'No HTML files found',
                    isValid: false
                };
            }

            // Prefer index.html, then first HTML file
            let selectedFile = htmlFiles.find(file => file.toLowerCase() === 'index.html') || htmlFiles[0];
            const htmlFilePath = path.join(directoryPath, selectedFile);

            const stats = fs.statSync(htmlFilePath);
            
            const example: BabiaExample = {
                id: this.generateExampleId(categoryName, selectedFile),
                name: this.formatExampleName(categoryName),
                htmlFilePath: htmlFilePath,
                directory: directoryPath,
                category: categoryName,
                description: this.generateDescription(categoryName, selectedFile),
                isValid: true,
                lastModified: stats.mtime.getTime()
            };

            logger.debug(() => `Created example: ${example.name} (${example.id})`);
            return example;

        } catch (error) {
            logger.error(`Error processing directory ${directoryPath}:`, error);
            return null;
        }
    }

    /**
     * Generate a unique ID for an example
     * @private
     */
    private generateExampleId(category: string, filename: string): string {
        return `example_${category}_${filename}`.replace(/[^a-zA-Z0-9_]/g, '_');
    }

    /**
     * Format example name for display
     * @private
     */
    private formatExampleName(category: string): string {
        // Convert kebab-case or snake_case to Title Case
        return category
            .split(/[-_]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
    }

    /**
     * Generate description for example
     * @private
     */
    private generateDescription(category: string, filename: string): string {
        const formattedCategory = this.formatExampleName(category);
        if (filename.toLowerCase() === 'index.html') {
            return `${formattedCategory} visualization example`;
        } else {
            const formattedFilename = filename.replace('.html', '').replace(/[-_]/g, ' ');
            return `${formattedCategory} - ${formattedFilename}`;
        }
    }

    /**
     * Cleanup method
     */
    public async cleanup(): Promise<void> {
        logger.debug('Cleaning up example launcher...');
        // The MultiServerLauncher will handle its own cleanup
        this.examplesCache = [];
        this.lastScanTime = 0;
    }
}


