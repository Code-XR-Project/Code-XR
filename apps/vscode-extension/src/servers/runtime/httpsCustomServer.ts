import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HttpServer, HttpServerConfig, ParticipantRemovalOutcome } from './httpServer';
import { ConnectedParticipantSummary } from '../../collaboration';
import { NetworkUtils } from '../utils/networkUtils';
import { PortManager } from './portManager';
import { GeneratedHttpsCertificateManager } from './generatedHttpsCertificateManager';
import { RemoteSessionAuthority } from '../../remote_access';

export interface HttpsCustomServerConfig extends Omit<HttpServerConfig, 'port'> {
    port: number;
    certPath: string;
    keyPath: string;
    extensionContext?: vscode.ExtensionContext;
}

export class HttpsCustomServer {
    private server: https.Server | null = null;
    private config: HttpsCustomServerConfig;
    private isRunning = false;
    private httpHandler: HttpServer;
    private usingFallbackCerts = false;
    private readonly certificateManager: GeneratedHttpsCertificateManager;

    constructor(config: HttpsCustomServerConfig) {
        if (!config.certPath || !config.keyPath) {
            throw new Error('SERVER: Certificate path and key path are required for custom HTTPS server');
        }

        if (!config.extensionContext) {
            throw new Error('SERVER: Extension context is required for HTTPS certificate fallback.');
        }

        this.certificateManager = new GeneratedHttpsCertificateManager(config.extensionContext);
        this.config = {
            host: '0.0.0.0',
            staticRoot: path.join(__dirname, '../../../templates'),
            enableCors: true,
            allowedOrigins: ['*'],
            ...config,
        };

        this.httpHandler = new HttpServer({
            port: this.config.port,
            host: this.config.host,
            staticRoot: this.config.staticRoot,
            enableCors: this.config.enableCors,
            allowedOrigins: this.config.allowedOrigins,
            mainFile: this.config.mainFile,
            extensionContext: this.config.extensionContext,
            analysisSessionId: this.config.analysisSessionId,
        });

        console.log('SERVER: HTTPS server (custom certificates) initialized with config:', {
            ...this.config,
            certPath: '***REDACTED***',
            keyPath: '***REDACTED***',
        });
    }

    public async start(): Promise<string> {
        if (this.isRunning) {
            throw new Error('SERVER: HTTPS server is already running');
        }

        await this.resolveCertificatePaths();
        await this.validateCertificates();

        console.log(`SERVER: Looking for available port starting from ${this.config.port} on host ${this.config.host}...`);
        const availablePort = await PortManager.findAvailablePort(this.config.port, this.config.port + 100, this.config.host);

        if (availablePort !== this.config.port) {
            console.log(`SERVER: Port ${this.config.port} was busy, using ${availablePort} instead on host ${this.config.host}`);
            this.config.port = availablePort;
        } else {
            console.log(`SERVER: Port ${this.config.port} is available on host ${this.config.host}`);
        }

        return new Promise((resolve, reject) => {
            try {
                const sslOptions = this.loadSslOptions();

                this.server = https.createServer(sslOptions, (req, res) => {
                    this.httpHandler.handleRequest(req, res);
                });
                this.httpHandler.attachToNodeServer(this.server);

                this.server.on('error', (error: NodeJS.ErrnoException) => {
                    console.error('SERVER: HTTPS server error:', error);
                    this.isRunning = false;

                    if (error.code === 'EADDRINUSE') {
                        reject(new Error(`SERVER: Port ${this.config.port} is already in use`));
                    } else if (error.code === 'EACCES') {
                        reject(new Error(`SERVER: Permission denied. May need to run as administrator for port ${this.config.port}`));
                    } else if (error.code === 'ENOENT') {
                        reject(new Error('SERVER: Certificate file not found. Please check your certificate paths.'));
                    } else {
                        reject(new Error(`SERVER: Failed to start HTTPS server: ${error.message}`));
                    }
                });

                this.server.on('listening', () => {
                    const port = this.config.port;
                    NetworkUtils.generateServerUrls(port, 'https');
                    const primaryExternalUrl = NetworkUtils.getPrimaryExternalUrl(port, 'https');

                    console.log(`SERVER: HTTPS server listening on port ${port}`);
                    if (this.usingFallbackCerts) {
                        console.warn('SERVER: Using generated local certificates instead of custom certificates');
                        void vscode.window.showWarningMessage(
                            'HTTPS server started with generated local certificates because the custom certificate pair was missing or invalid.',
                            'Configure Certificates',
                        ).then((action) => {
                            if (action === 'Configure Certificates') {
                                void vscode.commands.executeCommand('codexr.server.configure');
                            }
                        });
                    } else {
                        console.log('SERVER: Using custom certificates');
                    }

                    NetworkUtils.displayNetworkInfo(port, 'https');
                    console.log(`SERVER: Primary external URL: ${primaryExternalUrl}`);

                    this.isRunning = true;
                    resolve(NetworkUtils.getLocalhostUrl(port, 'https'));
                });

                this.server.on('close', () => {
                    console.log('SERVER: HTTPS server closed');
                    this.isRunning = false;
                });

                this.server.on('tlsClientError', (err) => {
                    if (
                        err.message.includes('SSLV3_ALERT_CERTIFICATE_UNKNOWN') ||
                        err.message.includes('certificate unknown') ||
                        err.message.includes('SSL alert number 46')
                    ) {
                        console.warn('SERVER: Client rejected the certificate - this may be expected');
                        console.warn('SERVER: Open the server URL in a browser first and accept the certificate');
                        console.warn(`SERVER: Navigate to https://${this.config.host}:${this.config.port} and proceed manually`);
                    } else if (err.message.includes('certificate')) {
                        console.warn('SERVER: Certificate-related TLS error:', err.message);
                    } else {
                        console.warn('SERVER: TLS client error (non-critical):', err.message);
                    }
                });

                this.server.listen(this.config.port, this.config.host);
            } catch (error) {
                console.error('SERVER: Error starting HTTPS server:', error);
                reject(error);
            }
        });
    }

    public async stop(): Promise<void> {
        if (!this.server || !this.isRunning) {
            console.log('SERVER: HTTPS server is not running');
            return;
        }

        // See HTTPServer.stop(): the runtime features own the sockets that
        // would otherwise keep close() pending forever.
        this.httpHandler.disposeRuntimeFeatures();
        this.server.closeAllConnections();

        return new Promise((resolve, reject) => {
            this.server!.close((error) => {
                if (error) {
                    console.error('SERVER: Error stopping HTTPS server:', error);
                    reject(error);
                } else {
                    console.log('SERVER: HTTPS server stopped successfully');
                    this.isRunning = false;
                    this.server = null;
                    resolve();
                }
            });
        });
    }

    /**
     * Drop every open socket without waiting for a graceful close.
     */
    public forceStop(): void {
        this.httpHandler.disposeRuntimeFeatures();
        this.server?.closeAllConnections();
        this.isRunning = false;
    }

    public getIsRunning(): boolean {
        return this.isRunning;
    }

    public getConfig(): HttpsCustomServerConfig {
        return {
            ...this.config,
            certPath: '***REDACTED***',
            keyPath: '***REDACTED***',
        };
    }

    public getServerUrl(): string | null {
        if (!this.isRunning) {
            return null;
        }
        return `https://${this.config.host}:${this.config.port}`;
    }

    public createAuthenticatedBrowserUrl(baseUrl: string): string {
        return this.httpHandler.createAuthenticatedBrowserUrl(baseUrl);
    }

    public createInvitation(): string {
        return this.httpHandler.createInvitation();
    }

    public setRemotePublicUrl(publicUrl: string | null): void {
        this.httpHandler.setRemotePublicUrl(publicUrl);
    }

    public getRemoteSessionAuthority(): RemoteSessionAuthority {
        return this.httpHandler.getRemoteSessionAuthority();
    }

    public getConnectedParticipants(): ConnectedParticipantSummary[] {
        return this.httpHandler.getConnectedParticipants();
    }

    public removeParticipant(peerId: string): ParticipantRemovalOutcome {
        return this.httpHandler.removeParticipant(peerId);
    }

    public onConnectedParticipantsChanged(
        listener: (participants: ConnectedParticipantSummary[]) => void,
    ): () => void {
        return this.httpHandler.onConnectedParticipantsChanged(listener);
    }

    private async resolveCertificatePaths(): Promise<void> {
        const customResult = await this.tryUseCustomCertificates();
        if (customResult) {
            this.usingFallbackCerts = false;
            return;
        }

        console.warn('SERVER: Falling back to generated local certificates because the custom pair is missing or invalid');
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
                console.warn(`SERVER: Custom certificate file not found: ${this.config.certPath}`);
            }
            if (!keyExists) {
                console.warn(`SERVER: Custom key file not found: ${this.config.keyPath}`);
            }
            return false;
        }

        try {
            await this.validateCertificatePair(this.config.certPath, this.config.keyPath);
            return true;
        } catch (error) {
            console.warn('SERVER: Custom certificate pair failed validation and will use generated fallback:', error);
            return false;
        }
    }

    private async validateCertificates(): Promise<void> {
        await this.validateCertificatePair(this.config.certPath, this.config.keyPath);
    }

    private async validateCertificatePair(certPath: string, keyPath: string): Promise<void> {
        if (!fs.existsSync(certPath)) {
            throw new Error(`SERVER: Certificate file not found: ${certPath}`);
        }

        if (!fs.existsSync(keyPath)) {
            throw new Error(`SERVER: Private key file not found: ${keyPath}`);
        }

        await fs.promises.access(certPath, fs.constants.R_OK);
        await fs.promises.access(keyPath, fs.constants.R_OK);

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

    private loadSslOptions(): https.ServerOptions {
        try {
            const cert = fs.readFileSync(this.config.certPath, 'utf8');
            const key = fs.readFileSync(this.config.keyPath, 'utf8');

            console.log('SERVER: Custom SSL certificates loaded successfully');

            return {
                cert,
                key,
                rejectUnauthorized: false,
                requestCert: false,
                secureProtocol: 'TLS_method',
                honorCipherOrder: false,
                ciphers: [
                    'ECDHE-RSA-AES128-GCM-SHA256',
                    'ECDHE-RSA-AES256-GCM-SHA384',
                    'ECDHE-RSA-AES128-SHA256',
                    'ECDHE-RSA-AES256-SHA384',
                    'DHE-RSA-AES128-GCM-SHA256',
                    'DHE-RSA-AES256-GCM-SHA384',
                    'AES128-GCM-SHA256',
                    'AES256-GCM-SHA384',
                ].join(':'),
                secureOptions: 0,
                SNICallback: (_servername: string, callback: (err: Error | null, ctx?: any) => void) => {
                    callback(null);
                },
            };
        } catch (error) {
            throw new Error(`SERVER: Failed to load custom SSL certificates: ${error}`);
        }
    }
}
