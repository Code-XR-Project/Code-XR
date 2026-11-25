import * as https from 'https';
import * as fs from 'fs';
import type * as vscode from 'vscode';
import type { HttpServer, HttpServerConfig, ParticipantRemovalOutcome } from './httpServer';
import type { ConnectedParticipantSummary } from '../collaboration/connectedParticipant';
import { PortManager } from './portManager';
import { GeneratedHttpsCertificateManager } from './generatedHttpsCertificateManager';
import { buildTlsServerOptions } from './httpsTlsOptions';
import type { RemoteSessionAuthority } from '../remote-access/remoteSessionAuthority';
import { getLogger } from '../../platform/logging/sink';
import { resolveTemplatePath } from '../../platform/templatePaths';

const logger = getLogger('SERVER');

/** The config shape both HTTPS servers share; each narrows it in its own interface. */
export interface HttpsServerBaseConfig extends Omit<HttpServerConfig, 'port'> {
    port: number;
    certPath?: string;
    keyPath?: string;
    extensionContext?: vscode.ExtensionContext;
}

/**
 * State and plumbing shared by HttpsCustomServer and HttpsDefaultServer: the
 * embedded HttpServer that answers every request and upgrade, the port
 * search, the TLS server wiring and the public delegation surface.
 *
 * Each subclass keeps what genuinely differs: its constructor guards (run
 * before super(), in their own order), its constructor log, the start()
 * orchestration with its listening and TLS-error handlers, where the
 * certificate pair comes from, and getConfig() (the custom server redacts).
 * Subclasses must not redeclare a field declared here: with ES2022 class
 * fields a redeclaration resets it to undefined after this constructor ran.
 *
 * This module imports httpServer for types only, and each subclass hands in
 * the HttpServer factory. httpServer.ts reaches the HTTPS subclasses again
 * through an import cycle (analysis host -> watchers -> server launcher), and
 * a runtime import here would let a subclass evaluate `extends` while this
 * module is still half-loaded.
 */
export abstract class HttpsServerBase<TConfig extends HttpsServerBaseConfig> {
    protected server: https.Server | null = null;
    protected config: TConfig;
    protected isRunning = false;
    protected httpHandler: HttpServer;
    protected readonly certificateManager: GeneratedHttpsCertificateManager;

    /** Callers have already checked that `config.extensionContext` is set. */
    protected constructor(config: TConfig, createHttpServer: (httpConfig: HttpServerConfig) => HttpServer) {
        this.certificateManager = new GeneratedHttpsCertificateManager(config.extensionContext!);
        this.config = {
            host: '0.0.0.0',
            staticRoot: resolveTemplatePath(config.extensionContext!.extensionPath),
            enableCors: true,
            allowedOrigins: ['*'],
            ...config,
        };

        this.httpHandler = createHttpServer({
            port: this.config.port,
            host: this.config.host,
            staticRoot: this.config.staticRoot,
            enableCors: this.config.enableCors,
            allowedOrigins: this.config.allowedOrigins,
            mainFile: this.config.mainFile,
            extensionContext: this.config.extensionContext,
            analysisSessionId: this.config.analysisSessionId,
        });
    }

    public abstract start(): Promise<string>;

    public abstract getConfig(): TConfig;

    public async stop(): Promise<void> {
        if (!this.server || !this.isRunning) {
            logger.debug('HTTPS server is not running');
            return;
        }

        // Dispose BEFORE close, exactly as HttpServer.stop() does: close()
        // waits for every socket to drain, and the sockets that never drain
        // on their own are the ones the runtime features own (collaboration
        // and broadcast WebSockets, open SSE responses). Disposing inside the
        // close callback deadlocks the shutdown (a shipped 1.2.0 fix).
        this.httpHandler.disposeRuntimeFeatures();
        this.server.closeAllConnections();

        return new Promise((resolve, reject) => {
            this.server!.close((error) => {
                if (error) {
                    logger.error('Error stopping HTTPS server:', error);
                    reject(error);
                } else {
                    logger.debug('HTTPS server stopped successfully');
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
        const server = this.server;
        this.server = null;
        this.isRunning = false;
        if (server) {
            // close() stops accepting connections and releases the port; it
            // was never called here, so a force-stopped server kept listening
            // with no entry left in the tree to stop it from.
            server.close(() => undefined);
            server.closeAllConnections();
        }
    }

    /** The port the listener is actually bound to, or null when not listening. */
    public getListeningPort(): number | null {
        const address = this.server?.address();
        return address && typeof address === 'object' ? address.port : null;
    }

    public getIsRunning(): boolean {
        return this.isRunning;
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

    protected assertNotRunning(): void {
        if (this.isRunning) {
            throw new Error('SERVER: HTTPS server is already running');
        }
    }

    /**
     * Keeps the configured port when it is free, and only otherwise searches
     * upwards and adopts the next free one. The launcher has already picked a
     * free port; searching again unconditionally went through get-port, which
     * locks every port it returns for 15-30 s and therefore skipped the very
     * port the launcher had just chosen, so the server listened one port above
     * the one shown in the tree, the toast and the LAN URL.
     */
    protected async resolveListeningPort(): Promise<void> {
        if (await PortManager.isPortAvailable(this.config.port, this.config.host)) {
            logger.debug(() => `Port ${this.config.port} is available on host ${this.config.host}`);
            return;
        }
        logger.debug(() => `Looking for available port starting from ${this.config.port} on host ${this.config.host}...`);
        const availablePort = await PortManager.findAvailablePort(this.config.port, this.config.port + 100, this.config.host);

        if (availablePort !== this.config.port) {
            logger.debug(() => `Port ${this.config.port} was busy, using ${availablePort} instead on host ${this.config.host}`);
            this.config.port = availablePort;
        } else {
            logger.debug(() => `Port ${this.config.port} is available on host ${this.config.host}`);
        }
    }

    /**
     * Runs start()'s listen step: creates the TLS server, hands its requests
     * and upgrades to HttpServer, handles 'close' and listen errors, and lets
     * `wire` add the subclass's own 'listening' and 'tlsClientError' handlers
     * and call listen(). A throw (for instance while loading the certificate
     * pair) rejects start().
     */
    protected listenWithTls(
        loadSslOptions: () => https.ServerOptions,
        wire: (server: https.Server, resolve: (url: string) => void) => void,
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                const server = https.createServer(loadSslOptions(), (req, res) => {
                    this.httpHandler.handleRequest(req, res);
                });
                this.server = server;
                this.httpHandler.attachToNodeServer(server);

                server.on('error', (error: NodeJS.ErrnoException) => this.rejectStart(error, reject));

                server.on('close', () => {
                    logger.debug('HTTPS server closed');
                    this.isRunning = false;
                });

                wire(server, resolve);
            } catch (error) {
                logger.error('Error starting HTTPS server:', error);
                reject(error);
            }
        });
    }

    /** The listen 'error' handler; `describeStartError` lets a subclass add an arm. */
    private rejectStart(error: NodeJS.ErrnoException, reject: (reason: Error) => void): void {
        logger.error('HTTPS server error:', error);
        this.isRunning = false;

        if (error.code === 'EADDRINUSE') {
            reject(new Error(`SERVER: Port ${this.config.port} is already in use`));
        } else if (error.code === 'EACCES') {
            reject(new Error(`SERVER: Permission denied. May need to run as administrator for port ${this.config.port}`));
        } else {
            reject(this.describeStartError(error) ?? new Error(`SERVER: Failed to start HTTPS server: ${error.message}`));
        }
    }

    protected describeStartError(_error: NodeJS.ErrnoException): Error | undefined {
        return undefined;
    }

    /** Both files exist and are readable; throws the first problem found. */
    protected async assertCertificatePairReadable(certPath: string, keyPath: string): Promise<void> {
        if (!fs.existsSync(certPath)) {
            throw new Error(`SERVER: Certificate file not found: ${certPath}`);
        }

        if (!fs.existsSync(keyPath)) {
            throw new Error(`SERVER: Private key file not found: ${keyPath}`);
        }

        await fs.promises.access(certPath, fs.constants.R_OK);
        await fs.promises.access(keyPath, fs.constants.R_OK);
    }

    /**
     * Reads the configured pair into the TLS options. Each subclass passes its
     * own success log and failure prefix, so both strings stay per class.
     */
    protected loadSslOptions(loadedMessage: string, failurePrefix: string): https.ServerOptions {
        try {
            const cert = fs.readFileSync(this.config.certPath!, 'utf8');
            const key = fs.readFileSync(this.config.keyPath!, 'utf8');

            logger.debug(loadedMessage);

            return buildTlsServerOptions(cert, key);
        } catch (error) {
            throw new Error(`${failurePrefix}: ${error}`);
        }
    }
}
