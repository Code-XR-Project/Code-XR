import * as vscode from 'vscode';
import { NetworkUtils } from '../utils/networkUtils';
import { HttpServer } from './httpServer';
import { HttpsServerBase, HttpsServerBaseConfig } from './httpsServerBase';
import { isCertificateRejectedByClient } from './httpsTlsOptions';

export type HttpsDefaultServerConfig = HttpsServerBaseConfig;

export class HttpsDefaultServer extends HttpsServerBase<HttpsDefaultServerConfig> {
    constructor(config: HttpsDefaultServerConfig) {
        if (!config.extensionContext) {
            throw new Error('SERVER: Extension context is required for generated HTTPS certificates.');
        }

        super(config, (httpConfig) => new HttpServer(httpConfig));

        console.log('SERVER: HTTPS server (generated local certificates) initialized with config:', {
            ...this.config,
            certPath: this.config.certPath ? '***REDACTED***' : undefined,
            keyPath: this.config.keyPath ? '***REDACTED***' : undefined,
        });
    }

    public async start(): Promise<string> {
        this.assertNotRunning();

        await this.ensureGeneratedCertificates();
        await this.validateCertificates();
        await this.resolveListeningPort();

        const loadSslOptions = () => this.loadSslOptions(
            'SERVER: SSL certificates loaded successfully',
            'SERVER: Failed to load SSL certificates',
        );
        return this.listenWithTls(loadSslOptions, (server, resolve) => {
            server.on('listening', () => {
                const address = this.server?.address();
                const port = this.config.port;
                const urls = NetworkUtils.generateServerUrls(port, 'https');
                const primaryExternalUrl = NetworkUtils.getPrimaryExternalUrl(port, 'https');

                console.log('SERVER: HTTPS server successfully listening.');
                console.log('SERVER: Address object:', address);
                console.log(`SERVER: Config host: "${this.config.host}"`);
                console.log(`SERVER: Config port: ${this.config.port}`);
                console.log(`SERVER: Generated local certificates loaded from ${this.config.certPath}`);
                console.log('SERVER: NOTE: Using self-signed certificate - browsers may show security warnings');

                NetworkUtils.displayNetworkInfo(port, 'https');
                this.showVRCertificateInstructions(primaryExternalUrl, urls.localhost);

                this.isRunning = true;
                resolve(NetworkUtils.getLocalhostUrl(port, 'https'));
            });

            server.on('tlsClientError', (err) => {
                if (isCertificateRejectedByClient(err)) {
                    console.warn('SERVER: Client rejected self-signed certificate - this is expected behavior');
                    console.warn('SERVER: VR solution: open the server URL in a browser first and accept the certificate');
                    console.warn(`SERVER: Navigate to https://${this.config.host}:${this.config.port} and proceed manually`);
                } else {
                    console.warn('SERVER: TLS client error (non-critical):', err.message);
                }
            });

            console.log(`SERVER: About to call server.listen with ${this.config.host}:${this.config.port}`);
            server.listen(this.config.port, this.config.host, () => {
                console.log('SERVER: Listen callback executed successfully');
            });
        });
    }

    public getConfig(): HttpsDefaultServerConfig {
        return { ...this.config };
    }

    private async ensureGeneratedCertificates(): Promise<void> {
        const paths = await this.certificateManager.ensureDefaultCertificatePair();
        this.config.certPath = paths.certPath;
        this.config.keyPath = paths.keyPath;
    }

    private async validateCertificates(): Promise<void> {
        const certPath = this.config.certPath;
        const keyPath = this.config.keyPath;

        if (!certPath || !keyPath) {
            throw new Error('SERVER: Generated local certificate paths are not available.');
        }

        console.log('SERVER: Validating generated local certificates...');
        console.log('SERVER: Certificate path:', certPath);
        console.log('SERVER: Key path:', keyPath);

        await this.assertCertificatePairReadable(certPath, keyPath);
    }


    private showVRCertificateInstructions(externalUrl: string, localhostUrl?: string): void {
        const primaryUrl = externalUrl;
        const fallbackUrl = localhostUrl || externalUrl;

        const message = `VR/HTTPS server ready! For VR headsets to work:\n\n` +
            `1. Primary URL (VR/Mobile): ${primaryUrl}\n` +
            `2. Local URL (Testing): ${fallbackUrl}\n\n` +
            `For VR/Mobile devices:\n` +
            `   - Open browser and go to: ${primaryUrl}\n` +
            `   - Click "Advanced" and proceed manually\n` +
            `   - Now your VR headset can access securely\n\n` +
            `This accepts the self-signed certificate for your session.`;

        console.log('SERVER: VR certificate instructions:');
        console.log('SERVER: =====================================');
        console.log(`SERVER: VR/Mobile URL: ${primaryUrl}`);
        console.log(`SERVER: Local URL: ${fallbackUrl}`);
        console.log('SERVER: 1. Navigate to the VR/Mobile URL from your device');
        console.log('SERVER: 2. Accept certificate warning in browser');
        console.log('SERVER: 3. Then use VR headset to access the same URL');
        console.log('SERVER: =====================================');

        vscode.window.showInformationMessage(
            `HTTPS server ready. VR/Mobile: ${primaryUrl}`,
            'Copy VR URL',
            'Copy Local URL',
            'Show Instructions',
        ).then((selection) => {
            if (selection === 'Copy VR URL') {
                void vscode.env.clipboard.writeText(primaryUrl);
                void vscode.window.showInformationMessage('VR/Mobile URL copied to clipboard.');
            } else if (selection === 'Copy Local URL') {
                void vscode.env.clipboard.writeText(fallbackUrl);
                void vscode.window.showInformationMessage('Local URL copied to clipboard.');
            } else if (selection === 'Show Instructions') {
                void vscode.window.showInformationMessage(message, { modal: true });
            }
        });
    }
}
