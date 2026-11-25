import * as vscode from 'vscode';

/**
 * Base interface for all section providers in the modular tree view architecture
 */
export interface SectionProvider<T extends vscode.TreeItem> {
    /**
     * Get the section header item
     */
    getSectionItem(): T;
    
    /**
     * Get children for this section
     */
    getChildren(element?: T): Thenable<T[]>;
    
    /**
     * Refresh this section
     */
    refresh(): void;
    
    /**
     * Get the section name for identification
     */
    getSectionName(): string;
}

/**
 * Base tree item for modular sections
 */
export class ModularTreeItem extends vscode.TreeItem {
    // Server-specific properties for compatibility
    public serverItemType?: 'config-group' | 'config-option' | 'launch-option';
    
    // Active Server-specific properties for compatibility
    public activeServerItemType?:
        | 'server-item'
        | 'control-option'
        | 'no-servers'
        | 'info-item'
        | 'participants-group'
        | 'participant-item'
        | 'actions-group'
        | 'action-item'
        | 'remote-group'
        | 'collaboration-group'
        | 'collaboration-item';
    public activeServer?: any;
    
    // Babia Examples-specific properties for compatibility
    public babiaItemType?: 'example-item' | 'no-examples' | 'loading' | 'error';
    public babiaExample?: any;
    
    // Visualize Data-specific properties for compatibility
    public visualizeDataItemType?: 'chart-type' | 'select-json' | 'dimension-mapping' | 'dimension-item' | 'launch-visualization' | 'browse-visualizations' | 'stored-visualization' | 'error';
    public visualizeDataItem?: any;
    
    // Analysis-specific properties for compatibility
    public analysisItemType?: 'section' | 'subsection' | 'language-group' | 'file-item' | 'error' | 'scanning';
    public originalAnalysisItem?: any;
    
    // Visualization Settings-specific properties for compatibility
    public visualizationSettingsItemType?: 'settings-field' | 'error' | 'reset-action';
    public originalSettingsItem?: any;

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly sectionType: string,
        public readonly itemType: string,
        command?: vscode.Command,
        iconPath?: vscode.TreeItem['iconPath'],
        tooltip?: string | vscode.MarkdownString,
        description?: string | boolean,
        contextValue?: string
    ) {
        super(label, collapsibleState);
        this.command = command;
        this.iconPath = iconPath;
        this.tooltip = tooltip || label;
        this.description = description;
        this.contextValue = contextValue;
    }
}

/**
 * Event emitter type for tree data changes
 */
export type TreeDataChangeEmitter<T> = vscode.EventEmitter<T | undefined | null | void>;

/**
 * Abstract base class for section providers.
 * Eliminates the repeated emitter / refresh / getSectionName boilerplate
 * that was duplicated across all 7 section providers.
 *
 * Subclasses only need to implement:
 *   - getSectionName()
 *   - getSectionItem()
 *   - getChildren()
 */
export abstract class BaseSectionProvider<T extends vscode.TreeItem>
    implements SectionProvider<T> {

    protected _onDidChangeTreeData: TreeDataChangeEmitter<T> =
        new vscode.EventEmitter<T | undefined | null | void>();

    readonly onDidChangeTreeData: vscode.Event<T | undefined | null | void> =
        this._onDidChangeTreeData.event;

    constructor(protected context: vscode.ExtensionContext) {}

    abstract getSectionName(): string;
    abstract getSectionItem(): T;
    abstract getChildren(element?: T): Promise<T[]>;

    /** Refresh the section (fires tree data change event). */
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /** Convenience: get the tree item representation (identity). */
    getTreeItem(element: T): vscode.TreeItem {
        return element;
    }
}
