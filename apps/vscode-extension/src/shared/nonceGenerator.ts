import { randomBytes } from 'crypto';

/**
 * Generates a cryptographically secure nonce (number used once) for configuration tracking.
 * Uses Node.js crypto module to create unpredictable random values.
 * 
 * @param length - The length of the nonce in bytes (default: 16 bytes = 128 bits)
 * @returns A hex-encoded string representing the nonce
 */
export function generateNonce(length: number = 16): string {
    return randomBytes(length).toString('hex');
}
