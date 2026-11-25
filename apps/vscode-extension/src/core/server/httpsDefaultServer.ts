import * as vscode from 'vscode';
import { NetworkUtils } from './networkUtils';
import { HttpServer } from './httpServer';
import { HttpsServerBase, HttpsServerBaseConfig } from './httpsServerBase';
import { isCertificateRejectedByClient } from './httpsTlsOptions';
import { getLogger } from '../../platform/logging/sink';

const logger = getLogger('SERVER');

export type HttpsDefaultServerConfig = HttpsServerBaseConfig;

export class HttpsDefaultServer extends HttpsServerBase<HttpsDefaultServerConfig> {
    constructor(config: HttpsDefaultServerConfig) {
        if (!config.extensionContext) {
            throw new Error('SERVER: Extension context is required for generated HTTPS certificates.');
        }

        super(config, (httpConfig) => new HttpServer(httpConfig));

        logger.debug('HTTPS server (generated local certificates) initialized with config:', {
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
            'SSL certificates loaded successfully',
            'SERVER: Failed to load SSL certificates',
        );
        return this.listenWithTls(loadSslOptions, (server, resolve) => {
            server.on('listening', () => {
                const address = this.server?.address();
                const port = this.config.port;
                const urls = NetworkUtils.generateServerUrls(port, 'https');
                const primaryExternalUrl = NetworkUtils.getPrimaryExternalUrl(port, 'https');

                logger.debug('HTTPS server successfully listening.');
                logger.debug('Address object:', address);
                logger.debug(() => `Config host: "${this.config.host}"`);
                logger.debug(() => `Config port: ${this.config.port}`);
                logger.debug(() => `Generated local certificates loaded from ${this.config.certPath}`);
                logger.debug('NOTE: Using self-signed certificate - browsers may show security warnings');

                NetworkUtils.displayNetworkInfo(port, 'https');
                this.showVRCertificateInstructions(primaryExternalUrl, urls.localhost);

                this.isRunning = true;
                resolve(NetworkUtils.getLocalhostUrl(port, 'https'));
            });

            server.on('tlsClientError', (err) => {
                if (isCertificateRejectedByClient(err)) {
                    logger.warn('Client rejected self-signed certificate - this is expected behavior');
                    logger.warn('VR solution: open the server URL in a browser first and accept the certificate');
                    logger.warn(`Navigate to https://${this.config.host}:${this.config.port} and proceed manually`);
                } else {
                    logger.warn('TLS client error (non-critical):', err.message);
                }
            });

            logger.debug(() => `About to call server.listen with ${this.config.host}:${this.config.port}`);
            server.listen(this.config.port, this.config.host, () => {
                logger.debug('Listen callback executed successfully');
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

        logger.debug('Validating generated local certificates...');
        logger.debug('Certificate path:', certPath);
        logger.debug('Key path:', keyPath);

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

        logger.debug('VR certificate instructions:');
        logger.debug('=====================================');
        logger.debug(() => `VR/Mobile URL: ${primaryUrl}`);
        logger.debug(() => `Local URL: ${fallbackUrl}`);
        logger.debug('1. Navigate to the VR/Mobile URL from your device');
        logger.debug('2. Accept certificate warning in browser');
        logger.debug('3. Then use VR headset to access the same URL');
        logger.debug('=====================================');

        void vscode.window.showInformationMessage(
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
