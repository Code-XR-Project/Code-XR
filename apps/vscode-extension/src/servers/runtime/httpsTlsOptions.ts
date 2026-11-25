import * as https from 'https';

/**
 * TLS settings shared by both HTTPS servers. RSA suites only: the generated
 * local certificate is RSA, and so is any pair a user is told to configure.
 * TLS 1.3 negotiates its own suites and is not limited by this list.
 */
export const HTTPS_CIPHER_SUITES: readonly string[] = [
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES128-SHA256',
    'ECDHE-RSA-AES256-SHA384',
    'DHE-RSA-AES128-GCM-SHA256',
    'DHE-RSA-AES256-GCM-SHA384',
    'AES128-GCM-SHA256',
    'AES256-GCM-SHA384',
];

export function buildTlsServerOptions(cert: string, key: string): https.ServerOptions {
    return {
        cert,
        key,
        rejectUnauthorized: false,
        requestCert: false,
        secureProtocol: 'TLS_method',
        honorCipherOrder: false,
        ciphers: HTTPS_CIPHER_SUITES.join(':'),
        secureOptions: 0,
        SNICallback: (_servername: string, callback: (err: Error | null, ctx?: any) => void) => {
            callback(null);
        },
    };
}

/** A client (usually a headset browser) refused the self-signed certificate. */
export function isCertificateRejectedByClient(error: Error): boolean {
    return error.message.includes('SSLV3_ALERT_CERTIFICATE_UNKNOWN') ||
        error.message.includes('certificate unknown') ||
        error.message.includes('SSL alert number 46');
}
