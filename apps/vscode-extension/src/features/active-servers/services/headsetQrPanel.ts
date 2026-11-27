import * as vscode from 'vscode';
import { NetworkUtils } from '../../../core/server/networkUtils';
import type { ActiveServer } from '../../../core/server/registry/activeServerModel';
import { headsetPageHtml, headsetTarget } from './headsetPage';

/**
 * #19: "Open on a Headset" for a server in ACTIVE SERVERS: a webview with
 * the address a standalone headset opens and its QR code, the same code the
 * Code-XR IDE shows in its scene header (core/xr/headsetQr.ts).
 */
export function showHeadsetQrPanel(server: ActiveServer): void {
    const lanUrl = NetworkUtils.getPrimaryExternalUrl(server.port, server.url.startsWith('https') ? 'https' : 'http');
    const label = server.customName || `the server on port ${server.port}`;
    const panel = vscode.window.createWebviewPanel('codexrHeadsetQr', 'Open on a Headset', vscode.ViewColumn.Active, {
        enableScripts: false,
        localResourceRoots: [],
    });
    panel.webview.html = headsetPageHtml(headsetTarget(server, lanUrl), label, panel.webview.cspSource);
}
