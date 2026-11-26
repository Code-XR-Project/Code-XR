import path from 'node:path';
import { getHost } from '@codexr/core/host/hostRegistry';
import { CLOUDFLARED_CONSENT_KEY, CLOUDFLARED_VERSION, CloudflaredBinaryManager } from '@codexr/core/remote-access/cloudflaredBinaryManager';
import type { GlobalStateContext } from '@codexr/core/host/hostPaths';
import { channelLog } from '../log.ts';
import type { CloudflaredStatus } from './dependencyReport.ts';

const log = channelLog('servers');

/**
 * cloudflared, the program behind "Share through Cloudflare" (#155), is one
 * of the IDE's dependencies (#160): installed at start-up with the Python
 * environment, with no question (Adrián's decision for the IDE, #154). The
 * download itself is the core's: pinned version, from GitHub, verified with
 * SHA-256, into the IDE's user-data folder. A cloudflared already on PATH is
 * used as it is. The VS Code extension still asks before downloading.
 */
export class CloudflaredService {
    private readonly context: GlobalStateContext;
    private readonly manager: CloudflaredBinaryManager;
    private installing: Promise<CloudflaredStatus> | null = null;
    private lastError: string | null = null;

    constructor(context: GlobalStateContext) {
        this.context = context;
        this.manager = new CloudflaredBinaryManager(context);
    }

    /** What is installed now. Never downloads. */
    async status(): Promise<CloudflaredStatus> {
        return this.installing ? { state: 'installing', version: CLOUDFLARED_VERSION } : this.probe();
    }

    private async probe(): Promise<CloudflaredStatus> {
        try {
            const binary = await this.manager.resolveBinary(false);
            if (binary) {
                return { state: 'ready', version: CLOUDFLARED_VERSION, path: binary, source: this.isManaged(binary) ? 'managed' : 'system' };
            }
            return { state: this.lastError ? 'failed' : 'missing', version: CLOUDFLARED_VERSION, error: this.lastError ?? undefined };
        } catch (error) {
            // No download for this platform (macOS for now): it has to be on PATH.
            return { state: 'unsupported', version: CLOUDFLARED_VERSION, error: error instanceof Error ? error.message : String(error) };
        }
    }

    /** Installs it when missing. Never throws: a failure is logged and kept for the status. */
    ensureInstalled(): Promise<CloudflaredStatus> {
        this.installing ??= this.install().finally(() => {
            this.installing = null;
        });
        return this.installing;
    }

    private async install(): Promise<CloudflaredStatus> {
        try {
            if (await this.manager.resolveBinary(false)) {
                return await this.probe();
            }
        } catch (error) {
            log.warn(`cloudflared: ${error instanceof Error ? error.message : String(error)}`);
            return this.probe();
        }
        log.info(`Installing cloudflared ${CLOUDFLARED_VERSION}: downloaded from github.com/cloudflare/cloudflared, verified with SHA-256, stored in ${this.binaryFolder()}.`);
        try {
            // The IDE installs its dependencies with no question (#154): the
            // consent the core would ask for is recorded instead.
            await this.context.globalState.update(CLOUDFLARED_CONSENT_KEY, true);
            await this.manager.resolveBinary(true);
            this.lastError = null;
            log.info('cloudflared installed.');
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            log.error('Could not install cloudflared.', error);
            void getHost().notifier.notify('warning', `cloudflared could not be installed (${this.lastError}). Sharing a scene through Cloudflare will try again.`);
        }
        return this.probe();
    }

    private binaryFolder(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'remote-access', CLOUDFLARED_VERSION);
    }

    private isManaged(binary: string): boolean {
        return path.resolve(binary).startsWith(path.resolve(this.binaryFolder()) + path.sep);
    }
}
