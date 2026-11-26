import type { ServerSettings } from './serverSettingsManager';
import type { LaunchMode } from './registry/activeServerModel';

/**
 * What a person sees around a `MultiServerLauncher` launch: the HTTPS-to-HTTP
 * override warning for the lateral panel, the busy-port notice and the
 * auto-open (or its "Open Now" toast). The launcher holds no UI: the
 * application registers an implementation at start-up (the extension:
 * `features/active-servers/views/launchNotifications.ts`, from `extension.ts`),
 * which is what removed the `core/server -> features/active-servers` layer
 * exception (#13, step 7).
 */
export interface LaunchNotifier {
    warnHttpsOverriddenForPanel(): void;
    notifyPortChanged(requestedPort: number, finalPort: number): void;
    handleAutoOpening(
        settings: ServerSettings,
        serverUrl: string,
        htmlFile: string | undefined,
        launchMode: LaunchMode,
        activeServerId: string,
    ): Promise<void>;
}

let current: LaunchNotifier | null = null;

/** Registers the launch UI. Called once at start-up; a later call replaces it (tests). */
export function setLaunchNotifier(notifier: LaunchNotifier | null): void {
    current = notifier;
}

/** The registered launch UI. Throws if none was registered, so a missing registration is loud. */
export function getLaunchNotifier(): LaunchNotifier {
    if (!current) {
        throw new Error('No launch notifier registered. Call setLaunchNotifier(...) at start-up first.');
    }
    return current;
}
