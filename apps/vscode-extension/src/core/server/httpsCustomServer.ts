import * as fs from 'fs';
import { NetworkUtils } from './networkUtils';
import { HttpServer } from './httpServer';
import { HttpsServerBase, HttpsServerBaseConfig } from './httpsServerBase';
import { isCertificateRejectedByClient } from './httpsTlsOptions';
import { getLogger } from '../../platform/logging/sink';
import { getHost } from '../host/hostRegistry';

const logger = getLogger('SERVER');

export interface HttpsCustomServerConfig extends HttpsServerBaseConfig {
    certPath: string;
    keyPath: string;
}

export class HttpsCustomServer extends HttpsServerBase<HttpsCustomServerConfig> {
    private usingFallbackCerts = false;

    constructor(config: HttpsCustomServerConfig) {
        if (!config.certPath || !config.keyPath) {
            throw new Error('SERVER: Certificate path and key path are required for custom HTTPS server');
        }

        if (!config.extensionContext) {
            throw new Error('SERVER: Extension context is required for HTTPS certificate fallback.');
        }

        super(config, (httpConfig) => new HttpServer(httpConfig));

        logger.debug('HTTPS server (custom certificates) initialized with config:', {
            ...this.config,
            certPath: '***REDACTED***',
            keyPath: '***REDACTED***',
        });
    }

    public async start(): Promise<string> {
        this.assertNotRunning();

        await this.resolveCertificatePaths();
        await this.validateCertificates();
        await this.resolveListeningPort();

        const loadSslOptions = () => this.loadSslOptions(
            'Custom SSL certificates loaded successfully',
            'SERVER: Failed to load custom SSL certificates',
        );
        return this.listenWithTls(loadSslOptions, (server, resolve) => {
            server.on('listening', () => {
                const port = this.config.port;
                const primaryExternalUrl = NetworkUtils.getPrimaryExternalUrl(port, 'https');

                logger.debug(() => `HTTPS server listening on port ${port}`);
                if (this.usingFallbackCerts) {
                    logger.warn('Using generated local certificates instead of custom certificates');
                    void getHost().notifier.notify('warning',
                        'HTTPS server started with generated local certificates because the custom certificate pair was missing or invalid.',
                        'Configure Certificates',
                    ).then((action) => {
                        if (action === 'Configure Certificates') {
                            getHost().signal({ kind: 'openServerSettings' });
                        }
                    });
                } else {
                    logger.debug('Using custom certificates');
                }

                NetworkUtils.displayNetworkInfo(port, 'https');
                logger.debug(() => `Primary external URL: ${primaryExternalUrl}`);

                this.isRunning = true;
                resolve(NetworkUtils.getLocalhostUrl(port, 'https'));
            });

            server.on('tlsClientError', (err) => {
                if (isCertificateRejectedByClient(err)) {
                    logger.warn('Client rejected the certificate - this may be expected');
                    logger.warn('Open the server URL in a browser first and accept the certificate');
                    logger.warn(`Navigate to https://${this.config.host}:${this.config.port} and proceed manually`);
                } else if (err.message.includes('certificate')) {
                    logger.warn('Certificate-related TLS error:', err.message);
                } else {
                    logger.warn('TLS client error (non-critical):', err.message);
                }
            });

            server.listen(this.config.port, this.config.host);
        });
    }

    public getConfig(): HttpsCustomServerConfig {
        return {
            ...this.config,
            certPath: '***REDACTED***',
            keyPath: '***REDACTED***',
        };
    }

    private async resolveCertificatePaths(): Promise<void> {
        const customResult = await this.tryUseCustomCertificates();
        if (customResult) {
            this.usingFallbackCerts = false;
            return;
        }

        logger.warn('Falling back to generated local certificates because the custom pair is missing or invalid');
        const generatedPaths = await this.certificateManager.ensureDefaultCertificatePair();
        this.config.certPath = generatedPaths.certPath;
        this.config.keyPath = generatedPaths.keyPath;
        this.usingFallbackCerts = true;
    }

    private async tryUseCustomCertificates(): Promise<boolean> {
        const certExists = fs.existsSync(this.config.certPath);
        const keyExists = fs.existsSync(this.config.keyPath);

        if (!certExists || !keyExists) {
            if (!certExists) {
                logger.warn(`Custom certificate file not found: ${this.config.certPath}`);
            }
            if (!keyExists) {
                logger.warn(`Custom key file not found: ${this.config.keyPath}`);
            }
            return false;
        }

        try {
            await this.validateCertificatePair(this.config.certPath, this.config.keyPath);
            return true;
        } catch (error) {
            logger.warn('Custom certificate pair failed validation and will use generated fallback:', error);
            return false;
        }
    }

    private async validateCertificates(): Promise<void> {
        await this.validateCertificatePair(this.config.certPath, this.config.keyPath);
    }

    private async validateCertificatePair(certPath: string, keyPath: string): Promise<void> {
        await this.assertCertificatePairReadable(certPath, keyPath);

        const certContent = await fs.promises.readFile(certPath, 'utf8');
        const keyContent = await fs.promises.readFile(keyPath, 'utf8');

        if (!certContent.includes('BEGIN CERTIFICATE')) {
            throw new Error('SERVER: Certificate file does not appear to be a valid certificate');
        }

        if (
            !keyContent.includes('BEGIN PRIVATE KEY') &&
            !keyContent.includes('BEGIN RSA PRIVATE KEY') &&
            !keyContent.includes('BEGIN EC PRIVATE KEY')
        ) {
            throw new Error('SERVER: Key file does not appear to be a valid private key');
        }
    }

    protected describeStartError(error: NodeJS.ErrnoException): Error | undefined {
        return error.code === 'ENOENT'
            ? new Error('SERVER: Certificate file not found. Please check your certificate paths.')
            : undefined;
    }
}
