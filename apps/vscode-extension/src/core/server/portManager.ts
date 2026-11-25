import * as net from 'net';
import { getLogger } from '../../platform/logging/sink';

const logger = getLogger('SERVER');

/**
 * Port availability checker and manager
 * Provides utilities to find available ports starting from a given port number
 */
export class PortManager {
    private static readonly DEFAULT_START_PORT = 3000;
    private static readonly DEFAULT_END_PORT = 8080;
    private static readonly MAX_RETRIES = 50;

    /**
     * Check if a specific port is available
     * @param port - The port number to check
     * @param host - The host to bind to. Without one, the port must be free on
     *   the wildcard address and on loopback (see isPortFreeEverywhere).
     * @returns Promise<boolean> - True if port is available, false otherwise
     */
    public static async isPortAvailable(port: number, host?: string): Promise<boolean> {
        if (host === undefined) {
            return PortManager.isPortFreeEverywhere(port);
        }
        return new Promise((resolve) => {
            const server = net.createServer();
            
            server.listen(port, host, () => {
                server.close(() => {
                    logger.debug(() => `Port ${port} is available on ${host}`);
                    resolve(true);
                });
            });
            
            server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    logger.debug(() => `Port ${port} is already in use on ${host}`);
                    resolve(false);
                } else {
                    logger.error(`Error checking port ${port}:`, err);
                    resolve(false);
                }
            });
        });
    }

    /**
     * True only when the port is free on the wildcard address AND on loopback
     * (IPv4 and IPv6). Checking 0.0.0.0 alone is not enough on macOS and
     * Windows: a wildcard bind can succeed while another process (a Vite or
     * Next dev server, typically on 3000) owns 127.0.0.1 or ::1, and
     * "localhost" then reaches that other app instead of Code-XR.
     */
    public static async isPortFreeEverywhere(port: number): Promise<boolean> {
        for (const host of ['0.0.0.0', '127.0.0.1', '::1']) {
            const free = await PortManager.isPortAvailableOnHost(port, host);
            if (!free) {
                return false;
            }
        }
        return true;
    }

    /** Like isPortAvailable, but a host this machine does not have (no IPv6) counts as free. */
    private static isPortAvailableOnHost(port: number, host: string): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', (err: NodeJS.ErrnoException) => {
                resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT');
            });
            server.listen({ port, host, exclusive: true }, () => {
                server.close(() => resolve(true));
            });
        });
    }

    /**
     * Find the first available port starting from a given port number
     * @param startPort - The starting port number (default: 3000)
     * @param endPort - The ending port number (default: 8080)
     * @param host - The host to bind to (default: '0.0.0.0')
     * @returns Promise<number> - The first available port found
     * @throws Error if no available port is found within the range
     */
    public static async findAvailablePort(
        startPort: number = PortManager.DEFAULT_START_PORT,
        endPort: number = PortManager.DEFAULT_END_PORT,
        host: string = '0.0.0.0'
    ): Promise<number> {
        logger.debug(() => `Searching for available port starting from ${startPort} on host ${host}`);
        
        // Validate inputs
        if (startPort < 1 || startPort > 65535) {
            throw new Error(`SERVER: Invalid start port ${startPort}. Must be between 1 and 65535`);
        }
        
        if (endPort < startPort || endPort > 65535) {
            throw new Error(`SERVER: Invalid end port ${endPort}. Must be between ${startPort} and 65535`);
        }

        try {
            // Use get-port for more reliable port detection with sequential checking
            const getPort = (await import('get-port')).default;
            
            // Create a sequential range array for get-port
            const maxRange = Math.min(endPort - startPort + 1, 100); // Check up to 100 ports sequentially
            const ports: number[] = [];
            for (let i = 0; i < maxRange; i++) {
                const port = startPort + i;
                if (port <= endPort) {
                    ports.push(port);
                }
            }
            
            logger.debug(() => `Checking ${ports.length} ports sequentially from ${startPort} to ${startPort + maxRange - 1}`);
            
            // No host: get-port then checks the wildcard and every local
            // interface, loopback included (see isPortFreeEverywhere).
            const availablePort = await getPort({
                port: ports,
            });

            logger.debug(() => `Found available port: ${availablePort} (sequential search successful)`);
            return availablePort;
        } catch (error) {
            logger.error(`get-port failed, using manual sequential detection:`, error);
            
            // Fallback to manual sequential implementation  
            logger.debug(() => `Manual port scanning from ${startPort} to ${endPort}`);
            let currentPort = startPort;
            let attempts = 0;
            const maxAttempts = Math.min(endPort - startPort + 1, PortManager.MAX_RETRIES);

            while (attempts < maxAttempts) {
                if (currentPort > endPort) {
                    break;
                }

                logger.debug(() => `Testing port ${currentPort} availability on ${host}`);
                if (await PortManager.isPortAvailable(currentPort, host)) {
                    logger.debug(() => `Port ${currentPort} is available and ready for use`);
                    return currentPort;
                } else {
                    logger.debug(() => `Port ${currentPort} is occupied, trying next port ${currentPort + 1}`);
                }

                currentPort++;
                attempts++;
            }

            throw new Error(
                `SERVER: No available port found in range ${startPort}-${endPort} after checking ${attempts} ports sequentially`
            );
        }
    }
}
