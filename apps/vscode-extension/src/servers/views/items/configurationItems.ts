import { ServerSettingsManager } from '../../storage/serverSettingsManager';

/**
 * Ensure persisted server configuration has been loaded.
 */
export async function ensureServerConfigReady(): Promise<void> {
    const manager = ServerSettingsManager.getInstance();
    await manager.ensureInitialized();
}

/**
 * Get current server configuration.
 */
export function getServerConfig() {
    return ServerSettingsManager.getInstance().getLegacyConfig();
}

/**
 * Update server configuration.
 */
export async function updateServerConfig(updates: any): Promise<void> {
    const manager = ServerSettingsManager.getInstance();
    await manager.updateFromLegacyConfig(updates);
}
