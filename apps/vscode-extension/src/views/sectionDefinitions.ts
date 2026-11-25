import * as vscode from 'vscode';
import { SectionProvider, ModularTreeItem } from '../platform/tree/baseInterfaces';
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
import type { SectionChild } from './common/sectionChild';
import { getActiveServerRegistry } from '../active_servers/registry/activeServerRegistry';

/**
 * One root section of the sidebar tree. The header is rebuilt on every
 * refresh; the provider is created the first time the section is needed.
 */
export interface LazySectionDefinition {
    sectionName: string;
    createHeader: () => ModularTreeItem;
    createProvider: () => SectionProvider<SectionChild>;
    /** Stays usable while the Python environment setup locks the rest of the UI. */
    interactiveWhenRestricted?: boolean;
}

/** What the section closures capture besides the extension context. */
export interface SectionDefinitionDependencies {
    pythonEnvManager: VenvManager;
    pythonEnvUiState: PythonEnvUiStateService;
}

/** What a root section header shows; omitted fields stay undefined. */
export interface SectionHeaderOptions {
    label: string;
    sectionType: string;
    collapsibleState: vscode.TreeItemCollapsibleState;
    iconPath?: vscode.ThemeIcon | vscode.Uri | { light: vscode.Uri; dark: vscode.Uri };
    /** Defaults to the label (ModularTreeItem's own fallback). */
    tooltip?: string;
    description?: string;
    contextValue?: string;
}

/**
 * Builds a root section header of the sidebar tree: a ModularTreeItem of item
 * type 'section' that carries no command (expanding it is the only interaction).
 */
export function createStaticSectionHeader({
    label,
    sectionType,
    collapsibleState,
    iconPath,
    tooltip,
    description,
    contextValue,
}: SectionHeaderOptions): ModularTreeItem {
    return new ModularTreeItem(
        label,
        collapsibleState,
        sectionType,
        'section',
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
            createHeader: () => createStaticSectionHeader({
                label: 'SERVERS',
                sectionType: 'SERVERS',
                collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                iconPath: new vscode.ThemeIcon('server-environment'),
                tooltip: 'Server configuration and launch options',
            }),
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

                return createStaticSectionHeader({
                    label: title,
                    sectionType: 'activeServers',
                    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                    iconPath: new vscode.ThemeIcon('server-process'),
                    tooltip: 'Running servers and collaboration profile',
                    contextValue: 'activeServersSection',
                });
            },
            createProvider: () => new ActiveServersSectionProvider(context),
        },
        {
            sectionName: 'babiaExamples',
            createHeader: () => createStaticSectionHeader({
                label: 'BABIA EXAMPLES',
                sectionType: 'babiaExamples',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                iconPath: new vscode.ThemeIcon('library'),
                tooltip: 'Interactive visualization examples',
                contextValue: 'babiaExamplesSection',
            }),
            createProvider: () => new BabiaExamplesSectionProvider(context),
        },
        {
            sectionName: 'visualizeData',
            createHeader: () => createStaticSectionHeader({
                label: 'VISUALIZE DATA',
                sectionType: 'visualizeData',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                iconPath: new vscode.ThemeIcon('open-preview', new vscode.ThemeColor('charts.foreground')),
                tooltip: 'Data visualization configuration and launch',
                contextValue: 'visualizeDataSection',
            }),
            createProvider: () => new VisualizeDataSectionProvider(context),
        },
        {
            sectionName: 'analysis',
            createHeader: () => createStaticSectionHeader({
                label: 'ANALYSIS',
                sectionType: 'analysis',
                collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                iconPath: new vscode.ThemeIcon('beaker'),
                tooltip: 'Analysis tools and settings',
                contextValue: 'codeXR.analysis.section.main',
            }),
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
            createHeader: () => createStaticSectionHeader({
                label: 'VISUALIZATION SETTINGS',
                sectionType: 'visualizationSettings',
                collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                iconPath: new vscode.ThemeIcon('settings-gear'),
                tooltip: 'Configure visualization rendering preferences',
                contextValue: 'visualizationSettingsSection',
            }),
            createProvider: () => new VisualizationSettingsSectionProvider(context),
        },
        {
            sectionName: 'learnMore',
            createHeader: () => createStaticSectionHeader({
                label: 'LEARN MORE & SUPPORT',
                sectionType: 'learnMore',
                collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                iconPath: new vscode.ThemeIcon('book', new vscode.ThemeColor('charts.foreground')),
                tooltip: 'Access CodeXR documentation, tutorials, examples, and support options',
                description: 'Docs, tutorials & support',
                contextValue: 'learnMoreSection',
            }),
            createProvider: () => new LearnMoreSectionProvider(context),
            interactiveWhenRestricted: true,
        },
    ];
}
