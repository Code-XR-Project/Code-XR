import * as vscode from 'vscode';
import { BaseSectionProvider } from '../../platform/tree/baseInterfaces';
import { CollaborationProfileManager } from '../../collaboration/services/collaborationProfileManager';
import { CollaborationItemFactory, CollaborationTreeItem } from './items/collaborationItems';

export class CollaborationSectionProvider extends BaseSectionProvider<CollaborationTreeItem> {
    private readonly manager: CollaborationProfileManager;
    private readonly profileSubscription: vscode.Disposable;

    constructor(context: vscode.ExtensionContext) {
        super(context);
        this.manager = CollaborationProfileManager.initialize(context);
        this.profileSubscription = this.manager.onDidChange(() => this.refresh());
    }

    public getSectionName(): string {
        return 'collaboration';
    }

    public getSectionItem(): CollaborationTreeItem {
        return new CollaborationTreeItem('COLLABORATION', 'info');
    }

    public async getChildren(element?: CollaborationTreeItem): Promise<CollaborationTreeItem[]> {
        return element ? [] : CollaborationItemFactory.createItems(this.manager.getConfiguration());
    }

    public dispose(): void {
        this.profileSubscription.dispose();
    }
}
