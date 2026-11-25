import * as vscode from 'vscode';
import { SectionProvider, ModularTreeItem } from '../platform/tree/baseInterfaces';
import { createSectionDefinitions, LazySectionDefinition } from './sectionDefinitions';
import type { SectionChild } from './common/sectionChild';
import { PythonEnvUiStateService } from '../core/python-env/pythonEnvUiState';
import { VenvManager } from '../core/python-env/venvManager';
import { CodeXRLogger } from '../platform/logging/logger';

const logger = CodeXRLogger.getLogger('MODULAR_TREE');

type SectionItemConstructor = new (...args: any[]) => SectionChild;

/** Bridge properties are read and written by name, so items are viewed as plain records. */
type BridgeView = Record<string, unknown>;

/**
 * How one section's items cross the bridge between the generic ModularTreeItem
 * the view renders and the section's own item class its provider understands.
 */
interface SectionItemAdapter {
    /**
     * Loads the section's item class. These `require()` calls are deliberately
     * lazy and must stay so: the provider is built once at activation, and a
     * static import would load every section's item module (and what each one
     * pulls in) before any section is expanded.
     */
    load: () => SectionItemConstructor;
    /**
     * Bridge properties read for the item type, in order; the first truthy one
     * wins. The first key is the section's own discriminator.
     */
    itemTypeKeys: readonly string[];
    /** Item type used when none of `itemTypeKeys` holds a value. */
    defaultItemType: string;
    /** Bridge properties passed to the item constructor after `contextValue`, in order. */
    constructorExtras: readonly string[];
    /** Properties copied from a section child onto its ModularTreeItem, after the discriminator. */
    payloadKeys: readonly string[];
}

/** One row per section, in sidebar order. */
const SECTION_ITEM_ADAPTERS: ReadonlyMap<string, SectionItemAdapter> = new Map<string, SectionItemAdapter>([
    ['SERVERS', {
        load: () => require('./servers/items/serverItems').ServerTreeItem,
        itemTypeKeys: ['serverItemType'],
        defaultItemType: 'config-option',
        constructorExtras: [],
        payloadKeys: [],
    }],
    ['activeServers', {
        load: () => require('./active_servers/items/activeServerItems').ActiveServerTreeItem,
        itemTypeKeys: ['activeServerItemType'],
        defaultItemType: 'server-item',
        // Participant rows carry their peer, which context-menu commands
        // receive instead of explicit arguments: it must survive both
        // conversions or the context menu has no target at all.
        constructorExtras: ['activeServer', 'participant'],
        payloadKeys: ['activeServer', 'participant'],
    }],
    ['babiaExamples', {
        load: () => require('./babia_examples/items/babiaExampleItems').BabiaExampleTreeItem,
        itemTypeKeys: ['babiaItemType'],
        defaultItemType: 'example-item',
        constructorExtras: ['babiaExample'],
        payloadKeys: ['babiaExample'],
    }],
    ['visualizeData', {
        load: () => require('./visualize_data/items/visualizeDataItems').VisualizeDataModularTreeItem,
        itemTypeKeys: ['visualizeDataItemType'],
        defaultItemType: 'error',
        constructorExtras: ['visualizeDataItem'],
        payloadKeys: ['visualizeDataItem'],
    }],
    ['analysis', {
        load: () => require('../code_analysis/views/items/analysisItems').CodeAnalysisTreeItem,
        itemTypeKeys: ['analysisItemType', 'type'],
        defaultItemType: 'item',
        constructorExtras: [],
        payloadKeys: ['originalAnalysisItem'],
    }],
    ['pythonEnv', {
        load: () => require('../features/python-env/views/pythonEnvItems').PythonEnvModularTreeItem,
        itemTypeKeys: ['pythonEnvItemType'],
        defaultItemType: 'info',
        constructorExtras: [],
        payloadKeys: [],
    }],
    ['visualizationSettings', {
        load: () => require('./visualization_settings/items/visualizationSettingsItems').VisualizationSettingsModularTreeItem,
        itemTypeKeys: ['visualizationSettingsItemType'],
        defaultItemType: 'error',
        constructorExtras: ['originalSettingsItem'],
        payloadKeys: ['originalSettingsItem'],
    }],
    ['learnMore', {
        load: () => require('../features/learn-more/views/learnMoreItems').LearnMoreModularTreeItem,
        itemTypeKeys: ['learnMoreItemType'],
        defaultItemType: 'action',
        constructorExtras: [],
        payloadKeys: ['originalLearnMoreItem'],
    }],
]);

/**
 * The item-type chain of a section child: every section's discriminator in
 * sidebar order, then a generic `type`. The first truthy one wins.
 */
const CHILD_ITEM_TYPE_KEYS: readonly string[] = [
    ...Array.from(SECTION_ITEM_ADAPTERS.values(), (adapter) => adapter.itemTypeKeys[0]),
    'type',
];

function labelText(label: string | vscode.TreeItemLabel | undefined): string {
    return typeof label === 'string' ? label : label?.label || 'Unknown';
}

/**
 * Main modular tree data provider that orchestrates all section providers.
 */
export class ModularTreeDataProvider implements vscode.TreeDataProvider<ModularTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ModularTreeItem | undefined | null | void> =
        new vscode.EventEmitter<ModularTreeItem | undefined | null | void>();

    readonly onDidChangeTreeData: vscode.Event<ModularTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private readonly sectionDefinitions = new Map<string, LazySectionDefinition>();
    private readonly sectionOrder: string[] = [];
    private readonly sectionProviders = new Map<string, SectionProvider<SectionChild>>();
    private readonly sectionSubscriptions = new Map<string, vscode.Disposable>();
    private readonly sectionHeaders = new Map<string, ModularTreeItem>();
    private readonly pythonEnvUiState = PythonEnvUiStateService.getInstance();
    private readonly pythonEnvUiStateSubscription: vscode.Disposable;
    private refreshTimer: NodeJS.Timeout | undefined;
    private refreshAllRequested = false;
    private readonly pendingSectionRefreshes = new Set<string>();

    constructor(context: vscode.ExtensionContext) {
        const sectionDefinitions = createSectionDefinitions(context, {
            pythonEnvManager: new VenvManager(context),
            pythonEnvUiState: this.pythonEnvUiState,
        });
        for (const definition of sectionDefinitions) {
            this.registerSection(definition);
        }
        this.pythonEnvUiStateSubscription = this.pythonEnvUiState.onDidChangeState(() => {
            this.refreshSection('pythonEnv');
        });
    }

    getTreeItem(element: ModularTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ModularTreeItem): Promise<ModularTreeItem[]> {
        if (!element) {
            return this.getRootSections();
        }

        return this.getSectionChildren(element);
    }

    public refresh(): void {
        this.scheduleRefresh();
    }

    public refreshSection(sectionName: string): void {
        this.scheduleRefresh(sectionName);
    }

    public getSectionProvider(sectionName: string): SectionProvider<SectionChild> | undefined {
        return this.ensureSectionProvider(sectionName);
    }

    dispose(): void {
        this.pythonEnvUiStateSubscription.dispose();

        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }

        for (const subscription of this.sectionSubscriptions.values()) {
            subscription.dispose();
        }

        for (const provider of this.sectionProviders.values()) {
            if (typeof (provider as any).dispose === 'function') {
                (provider as any).dispose();
            }
        }

        this.sectionSubscriptions.clear();
        this.sectionProviders.clear();
        this.sectionHeaders.clear();
    }

    private registerSection(definition: LazySectionDefinition): void {
        this.sectionDefinitions.set(definition.sectionName, definition);
        this.sectionOrder.push(definition.sectionName);
    }

    private getRootSections(): ModularTreeItem[] {
        return this.sectionOrder.map((sectionName) => {
            const definition = this.sectionDefinitions.get(sectionName);
            if (!definition) {
                return new ModularTreeItem(
                    `${sectionName.toUpperCase()} (Error)`,
                    vscode.TreeItemCollapsibleState.None,
                    sectionName,
                    'error',
                    undefined,
                    new vscode.ThemeIcon('error'),
                    `Error loading ${sectionName} section`,
                );
            }

            const header = this.cacheSectionHeader(sectionName, definition.createHeader());
            const uiState = this.pythonEnvUiState.getState();

            if (uiState.isUiRestricted && !this.isSectionInteractive(sectionName)) {
                header.description = uiState.status === 'error'
                    ? 'Disabled until Python environment setup is retried'
                    : 'Disabled while Python environment setup is running';
                header.tooltip = uiState.detail
                    ? `${header.label}\n\n${uiState.detail}`
                    : `${header.label} is temporarily unavailable while CodeXR prepares the Python environment.`;
                header.iconPath = new vscode.ThemeIcon(
                    uiState.status === 'error' ? 'lock' : 'loading~spin',
                );
            }

            return header;
        });
    }

    private async getSectionChildren(element: ModularTreeItem): Promise<ModularTreeItem[]> {
        const sectionName = element.sectionType;
        const uiState = this.pythonEnvUiState.getState();

        if (uiState.isUiRestricted && !this.isSectionInteractive(sectionName)) {
            return [this.createRestrictedItem(sectionName, uiState)];
        }

        const provider = this.ensureSectionProvider(sectionName);
        if (!provider) {
            return [];
        }

        try {
            let sectionElement: SectionChild | undefined = undefined;
            if (element.itemType !== 'section') {
                // Only a section with an adapter has a provider (checked above), so
                // the conversion never hands back the ModularTreeItem itself here.
                sectionElement = this.convertToSectionItem(element) as SectionChild;
            }

            const sectionChildren = await provider.getChildren(sectionElement);
            return sectionChildren.map((child) => this.createModularChild(sectionName, child));
        } catch (error) {
            logger.error(() => `Error getting children for section ${sectionName}.`, error);
            return [new ModularTreeItem(
                'Error loading items',
                vscode.TreeItemCollapsibleState.None,
                sectionName,
                'error',
                undefined,
                new vscode.ThemeIcon('error'),
                `Failed to load ${sectionName} items`,
            )];
        }
    }

    private ensureSectionProvider(sectionName: string): SectionProvider<SectionChild> | undefined {
        const existingProvider = this.sectionProviders.get(sectionName);
        if (existingProvider) {
            return existingProvider;
        }

        const definition = this.sectionDefinitions.get(sectionName);
        if (!definition) {
            return undefined;
        }

        const provider = definition.createProvider();
        this.sectionProviders.set(sectionName, provider);

        if ((provider as any).onDidChangeTreeData) {
            const subscription = (provider as any).onDidChangeTreeData(() => {
                this.refreshSection(sectionName);
            });
            this.sectionSubscriptions.set(sectionName, subscription);
        }

        logger.debug(() => `Instantiated lazy section provider for ${sectionName}.`);
        return provider;
    }

    private cacheSectionHeader(sectionName: string, nextItem: ModularTreeItem): ModularTreeItem {
        const cachedItem = this.sectionHeaders.get(sectionName);
        if (!cachedItem) {
            this.sectionHeaders.set(sectionName, nextItem);
            return nextItem;
        }

        cachedItem.label = nextItem.label;
        cachedItem.collapsibleState = nextItem.collapsibleState;
        cachedItem.command = nextItem.command;
        cachedItem.iconPath = nextItem.iconPath;
        cachedItem.tooltip = nextItem.tooltip;
        cachedItem.description = nextItem.description;
        cachedItem.contextValue = nextItem.contextValue;
        return cachedItem;
    }

    private createModularChild(sectionName: string, child: SectionChild): ModularTreeItem {
        const modularItem = new ModularTreeItem(
            labelText(child.label),
            child.collapsibleState || vscode.TreeItemCollapsibleState.None,
            sectionName,
            (CHILD_ITEM_TYPE_KEYS.map((key) => (child as unknown as BridgeView)[key]).find(Boolean) as string | undefined) || 'item',
            child.command,
            child.iconPath,
            child.tooltip,
            child.description,
            child.contextValue,
        );

        // Every discriminator the child carries is copied with its payload, so
        // the item can be rebuilt by convertToSectionItem when it is expanded
        // or handed to a context-menu command.
        const bridge = modularItem as unknown as BridgeView;
        for (const adapter of SECTION_ITEM_ADAPTERS.values()) {
            const discriminator = adapter.itemTypeKeys[0];
            if ((child as unknown as BridgeView)[discriminator]) {
                bridge[discriminator] = (child as unknown as BridgeView)[discriminator];
                for (const key of adapter.payloadKeys) {
                    bridge[key] = (child as unknown as BridgeView)[key];
                }
            }
        }

        return modularItem;
    }

    private convertToSectionItem(element: ModularTreeItem): SectionChild | ModularTreeItem {
        const adapter = SECTION_ITEM_ADAPTERS.get(element.sectionType);
        if (!adapter) {
            return element;
        }

        const bridge = element as unknown as BridgeView;
        const itemType = adapter.itemTypeKeys.map((key) => bridge[key]).find(Boolean) || adapter.defaultItemType;
        const SectionItem = adapter.load();
        return new SectionItem(
            labelText(element.label),
            element.collapsibleState || vscode.TreeItemCollapsibleState.None,
            itemType,
            element.command,
            element.iconPath,
            element.tooltip,
            element.description,
            element.contextValue,
            ...adapter.constructorExtras.map((key) => bridge[key]),
        );
    }

    private scheduleRefresh(sectionName?: string): void {
        if (sectionName) {
            this.pendingSectionRefreshes.add(sectionName);
        } else {
            this.refreshAllRequested = true;
        }

        if (this.refreshTimer) {
            return;
        }

        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.flushRefreshes();
        }, 40);
    }

    private flushRefreshes(): void {
        const shouldRefreshAll = this.refreshAllRequested || this.pendingSectionRefreshes.size === 0;
        const sectionsToRefresh = Array.from(this.pendingSectionRefreshes);

        this.refreshAllRequested = false;
        this.pendingSectionRefreshes.clear();

        if (shouldRefreshAll) {
            this._onDidChangeTreeData.fire(undefined);
            return;
        }

        for (const sectionName of sectionsToRefresh) {
            this._onDidChangeTreeData.fire(this.sectionHeaders.get(sectionName));
        }
    }

    private isSectionInteractive(sectionName: string): boolean {
        return this.sectionDefinitions.get(sectionName)?.interactiveWhenRestricted === true;
    }

    private createRestrictedItem(sectionName: string, uiState: ReturnType<PythonEnvUiStateService['getState']>): ModularTreeItem {
        const message = uiState.status === 'error'
            ? 'Disabled until Python environment setup is retried'
            : 'Disabled while Python environment setup is running';

        return new ModularTreeItem(
            message,
            vscode.TreeItemCollapsibleState.None,
            sectionName,
            'info',
            undefined,
            new vscode.ThemeIcon(uiState.status === 'error' ? 'lock' : 'loading~spin'),
            uiState.detail ?? uiState.message,
            uiState.message,
            'pythonEnv.uiRestricted',
        );
    }
}

