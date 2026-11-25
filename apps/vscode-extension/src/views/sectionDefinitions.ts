import * as vscode from 'vscode';
import { ModularTreeItem } from './common/baseInterfaces';

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
