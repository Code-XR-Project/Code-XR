/**
 * Network Utilities for Server Configuration
 * Provides network-related helper functions for server setup
 */

import * as os from 'os';
import { getLogger } from '../../platform/logging/sink';

const logger = getLogger('NETWORK_UTILS');

export class NetworkUtils {
    
    /**
     * Get the local IP address for external device access
     * @returns string - Local IP address or fallback to localhost
     */
    static getLocalIPAddress(): string {
        const interfaces = os.networkInterfaces();
        
        // Look for non-internal IPv4 addresses
        for (const name of Object.keys(interfaces)) {
            if (interfaces[name]) {
                for (const iface of interfaces[name]!) {
                    // Skip internal (localhost) and IPv6 addresses
                    if (iface.family === 'IPv4' && !iface.internal) {
                        logger.debug(() => `SERVER: Found local IP address: ${iface.address} (${name})`);
                        return iface.address;
                    }
                }
            }
        }
        
        logger.warn('SERVER: Could not find local IP address, falling back to localhost');
        return 'localhost';
    }
    
    /**
     * Generate server URLs for different access methods
     * @param port - Server port
     * @param protocol - 'http' or 'https'
     * @returns Object with different URL options
     */
    static generateServerUrls(port: number, protocol: 'http' | 'https' = 'https'): {
        localhost: string;
        localIP: string;
        allInterfaces: string[];
    } {
        const localIP = this.getLocalIPAddress();
        
        return {
            localhost: `${protocol}://localhost:${port}`,
            localIP: `${protocol}://${localIP}:${port}`,
            allInterfaces: [
                `${protocol}://localhost:${port}`,
                `${protocol}://${localIP}:${port}`,
                `${protocol}://0.0.0.0:${port}`
            ]
        };
    }
    
    /**
     * Get the primary external URL for client connections
     * @param port - Server port
     * @param protocol - 'http' or 'https'
     * @returns string - Primary external URL
     */
    static getPrimaryExternalUrl(port: number, protocol: 'http' | 'https' = 'https'): string {
        const localIP = this.getLocalIPAddress();
        return `${protocol}://${localIP}:${port}`;
    }
    
    /**
     * Get the localhost URL for browser/panel access
     * @param port - Server port
     * @param protocol - 'http' or 'https'
     * @returns string - Localhost URL for local access
     */
    static getLocalhostUrl(port: number, protocol: 'http' | 'https' = 'https'): string {
        return `${protocol}://localhost:${port}`;
    }
    
    /**
     * Display network configuration information
     * @param port - Server port
     * @param protocol - 'http' or 'https'
     */
    static displayNetworkInfo(port: number, protocol: 'http' | 'https' = 'https'): void {
        const urls = this.generateServerUrls(port, protocol);
        
        logger.debug('\n=== SERVER NETWORK CONFIGURATION ===');
        logger.debug('====================================');
        logger.debug(() => `Primary External URL: ${urls.localIP}`);
        logger.debug(() => `Localhost URL: ${urls.localhost}`);
        logger.debug(() => `For VR/Mobile devices use: ${urls.localIP}`);
        logger.debug(() => `For local testing use: ${urls.localhost}`);
        logger.debug('Network Diagnostics:');
        logger.debug(() => `  - Server listening on: 0.0.0.0:${port}`);
        logger.debug(() => `  - Local IP detected: ${this.getLocalIPAddress()}`);
        logger.debug(() => `  - Protocol: ${protocol.toUpperCase()}`);
        logger.debug('====================================\n');
        
        // Additional diagnostic info
        this.performNetworkDiagnostics(port);
    }
    
    /**
     * Perform network diagnostics
     * @param port - Server port to diagnose
     */
    static performNetworkDiagnostics(port: number): void {
        logger.debug('=== NETWORK DIAGNOSTICS ===');
        
        // Check all network interfaces
        const interfaces = os.networkInterfaces();
        logger.debug('Available network interfaces:');
        
        for (const [name, details] of Object.entries(interfaces)) {
            if (details) {
                for (const detail of details) {
                    if (detail.family === 'IPv4') {
                        const status = detail.internal ? '(internal)' : '(external)';
                        logger.debug(() => `  ${name}: ${detail.address} ${status}`);
                    }
                }
            }
        }
        
        logger.debug(`\nServer should be accessible at:`);
        logger.debug(() => `  - Local: http://127.0.0.1:${port}`);
        logger.debug(() => `  - Network: http://${this.getLocalIPAddress()}:${port}`);
        logger.debug('===========================\n');
    }
}
