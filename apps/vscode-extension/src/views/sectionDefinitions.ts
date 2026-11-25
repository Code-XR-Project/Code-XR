import * as vscode from 'vscode';
import { SectionProvider, ModularTreeItem } from './common/baseInterfaces';
import { ServersSectionProvider } from './servers';
import { ActiveServersSectionProvider } from './active_servers';
import { BabiaExamplesSectionProvider } from './babia_examples';
import { VisualizeDataSectionProvider } from './visualize_data';
import { PythonEnvSectionProvider } from './python_env';
import { AnalysisSectionProvider } from '../code_analysis/views/AnalysisSectionProvider';
import { VisualizationSettingsSectionProvider } from './visualization_settings';
import { LearnMoreSectionProvider } from './learn_more';
import type { PythonEnvUiStateService } from '../python_env/runtime/pythonEnvUiState';
import type { VenvManager } from '../python_env/runtime/venvManager';
import { PythonEnvItems } from '../python_env/views/items/pythonEnvItems';
import { getActiveServerRegistry } from '../active_servers/registry/activeServerRegistry';

/**
 * One root section of the sidebar tree. The header is rebuilt on every
 * refresh; the provider is created the first time the section is needed.
 */
export interface LazySectionDefinition {
    sectionName: string;
    createHeader: () => ModularTreeItem;
    createProvider: () => SectionProvider<any>;
    /** Stays usable while the Python environment setup locks the rest of the UI. */
    interactiveWhenRestricted?: boolean;
}

/** What the section closures capture besides the extension context. */
export interface SectionDefinitionDependencies {
    pythonEnvManager: VenvManager;
    pythonEnvUiState: PythonEnvUiStateService;
}

/**
 * Builds a root section header of the sidebar tree: a ModularTreeItem that
 * carries no command (expanding it is the only interaction).
 */
export function createStaticSectionHeader(
    label: string,
    sectionType: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    itemType: string,
    iconPath?: vscode.ThemeIcon | vscode.Uri | { light: vscode.Uri; dark: vscode.Uri },
    tooltip?: string,
    description?: string,
    contextValue?: string,
): ModularTreeItem {
    return new ModularTreeItem(
        label,
        collapsibleState,
        sectionType,
        itemType,
        undefined,
        iconPath,
        tooltip,
        description,
        contextValue,
    );
}

/** The eight root sections, in sidebar order. */
export function createSectionDefinitions(
    context: vscode.ExtensionContext,
    deps: SectionDefinitionDependencies,
): LazySectionDefinition[] {
    return [
        {
            sectionName: 'SERVERS',
            createHeader: () => createStaticSectionHeader(
                'SERVERS',
                'SERVERS',
                vscode.TreeItemCollapsibleState.Expanded,
                'section',
                new vscode.ThemeIcon('server-environment'),
                'Server configuration and launch options',
            ),
            createProvider: () => new ServersSectionProvider(context),
        },
        {
            sectionName: 'activeServers',
            createHeader: () => {
                const activeServers = getActiveServerRegistry().getAllServers();
                const runningCount = activeServers.filter((server) => server.status === 'running').length;
                const title = runningCount > 0
                    ? `ACTIVE SERVERS (${runningCount} running)`
                    : 'ACTIVE SERVERS';

                return createStaticSectionHeader(
                    title,
                    'activeServers',
                    vscode.TreeItemCollapsibleState.Expanded,
                    'section',
                    new vscode.ThemeIcon('server-process'),
                    'Running servers and collaboration profile',
                    undefined,
                    'activeServersSection',
                );
            },
            createProvider: () => new ActiveServersSectionProvider(context),
        },
        {
            sectionName: 'babiaExamples',
            createHeader: () => createStaticSectionHeader(
                'BABIA EXAMPLES',
                'babiaExamples',
                vscode.TreeItemCollapsibleState.Collapsed,
                'section',
                new vscode.ThemeIcon('library'),
                'Interactive visualization examples',
                undefined,
                'babiaExamplesSection',
            ),
            createProvider: () => new BabiaExamplesSectionProvider(context),
        },
        {
            sectionName: 'visualizeData',
            createHeader: () => createStaticSectionHeader(
                'VISUALIZE DATA',
                'visualizeData',
                vscode.TreeItemCollapsibleState.Collapsed,
                'section',
                new vscode.ThemeIcon('open-preview', new vscode.ThemeColor('charts.foreground')),
                'Data visualization configuration and launch',
                undefined,
                'visualizeDataSection',
            ),
            createProvider: () => new VisualizeDataSectionProvider(context),
        },
        {
            sectionName: 'analysis',
            createHeader: () => createStaticSectionHeader(
                'ANALYSIS',
                'analysis',
                vscode.TreeItemCollapsibleState.Expanded,
                'section',
                new vscode.ThemeIcon('beaker'),
                'Analysis tools and settings',
                undefined,
                'codeXR.analysis.section.main',
            ),
            createProvider: () => new AnalysisSectionProvider(context),
        },
        {
            sectionName: 'pythonEnv',
            createHeader: () => {
                const sectionItem = PythonEnvItems.createSectionItem(
                    deps.pythonEnvManager.getEnvironmentStatus(),
                    deps.pythonEnvUiState.getState(),
                );

                return new ModularTreeItem(
                    sectionItem.label,
                    sectionItem.collapsibleState,
                    'pythonEnv',
                    'section',
                    sectionItem.command,
                    sectionItem.iconPath,
                    sectionItem.tooltip,
                    sectionItem.description,
                    sectionItem.contextValue,
                );
            },
            createProvider: () => new PythonEnvSectionProvider(context),
            interactiveWhenRestricted: true,
        },
        {
            sectionName: 'visualizationSettings',
            createHeader: () => createStaticSectionHeader(
                'VISUALIZATION SETTINGS',
                'visualizationSettings',
                vscode.TreeItemCollapsibleState.Collapsed,
                'section',
                new vscode.ThemeIcon('settings-gear'),
                'Configure visualization rendering preferences',
                undefined,
                'visualizationSettingsSection',
            ),
            createProvider: () => new VisualizationSettingsSectionProvider(context),
        },
        {
            sectionName: 'learnMore',
            createHeader: () => createStaticSectionHeader(
                'LEARN MORE & SUPPORT',
                'learnMore',
                vscode.TreeItemCollapsibleState.Expanded,
                'section',
                new vscode.ThemeIcon('book', new vscode.ThemeColor('charts.foreground')),
                'Access CodeXR documentation, tutorials, examples, and support options',
                'Docs, tutorials & support',
                'learnMoreSection',
            ),
            createProvider: () => new LearnMoreSectionProvider(context),
            interactiveWhenRestricted: true,
        },
    ];
}
