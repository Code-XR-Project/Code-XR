import * as vscode from 'vscode';
import { ExtensionCommandRegistration } from '../../../platform/commands/commandRegistry';

/** Official CodeXR site. */
const CODEXR_WEBSITE_URL = 'https://code-xr.adrianmonteslinares.com/';
/** Personal site of the extension's author. */
const AUTHOR_WEBSITE_URL = 'https://adrianmonteslinares.com/';
const SUPPORT_URL = 'https://buymeacoffee.com/adrianadyrx';

export class LearnMoreCommands {
    static getCommandRegistrations(): ExtensionCommandRegistration[] {
        return [
            {
                id: 'codeXR.learnMore',
                module: 'LEARN_MORE',
                description: 'Open Code-XR documentation',
                handler: () => {
                    LearnMoreCommands.handleLearnMore();
                },
                errorMessage: 'Failed to open Code-XR documentation'
            },
            {
                id: 'codeXR.openAuthorWebsite',
                module: 'LEARN_MORE',
                description: 'Open the author website',
                handler: async () => {
                    await vscode.env.openExternal(vscode.Uri.parse(AUTHOR_WEBSITE_URL));
                },
                errorMessage: 'Failed to open the author website'
            },
            {
                id: 'codeXR.supportDeveloper',
                module: 'LEARN_MORE',
                description: 'Support Code-XR development on Buy Me a Coffee',
                handler: () => {
                    LearnMoreCommands.handleSupportDeveloper();
                },
                errorMessage: 'Failed to open Buy Me a Coffee page'
            }
        ];
    }

    private static handleLearnMore(): void {
        const websiteUrl = CODEXR_WEBSITE_URL;

        void vscode.window.showInformationMessage(
            'Opening Code-XR Documentation Website...',
            'Open Website'
        ).then(selection => {
            if (selection === 'Open Website') {
                void vscode.env.openExternal(vscode.Uri.parse(websiteUrl));
            }
        });

        void vscode.env.openExternal(vscode.Uri.parse(websiteUrl));
    }

    private static handleSupportDeveloper(): void {
        const coffeeUrl = SUPPORT_URL;

        void vscode.window.showInformationMessage(
            'Thank you for supporting Code-XR development! Opening Buy Me a Coffee...',
            'Open Page'
        ).then(selection => {
            if (selection === 'Open Page') {
                void vscode.env.openExternal(vscode.Uri.parse(coffeeUrl));
            }
        });

        void vscode.env.openExternal(vscode.Uri.parse(coffeeUrl));
    }
}
