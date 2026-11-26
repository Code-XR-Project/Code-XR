import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    APP_ORIGIN,
    REQUIRED_WEB_PREFERENCES,
    assertSecureWebPreferences,
    buildContentSecurityPolicy,
    isAllowedNavigation,
    isTrustedIpcCall,
    originOf,
    secureWebPreferences,
    trustedOrigins,
} from '../src/main/security.ts';
import { ALLOWED_IPC_CHANNELS, IPC_CHANNELS } from '../src/shared/api.ts';

function parseCsp(csp: string): Map<string, string[]> {
    return new Map(csp.split(';').map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name ?? '', values];
    }));
}

describe('web preferences', () => {
    it('satisfies every required preference', () => {
        const prefs = secureWebPreferences('/tmp/preload.cjs');
        assert.doesNotThrow(() => assertSecureWebPreferences(prefs as unknown as Record<string, unknown>));
        assert.equal(prefs.preload, '/tmp/preload.cjs');
    });

    it('requires the Electron checklist baseline', () => {
        assert.equal(REQUIRED_WEB_PREFERENCES.contextIsolation, true);
        assert.equal(REQUIRED_WEB_PREFERENCES.sandbox, true);
        assert.equal(REQUIRED_WEB_PREFERENCES.nodeIntegration, false);
        assert.equal(REQUIRED_WEB_PREFERENCES.webSecurity, true);
    });

    for (const [key, expected] of Object.entries(REQUIRED_WEB_PREFERENCES)) {
        it(`refuses a window whose ${key} is not ${String(expected)}`, () => {
            const weakened = { ...secureWebPreferences('p'), [key]: !expected };
            assert.throws(() => assertSecureWebPreferences(weakened), new RegExp(key));
        });
        it(`refuses a window that does not report ${key}`, () => {
            const missing: Record<string, unknown> = { ...secureWebPreferences('p') };
            delete missing[key];
            assert.throws(() => assertSecureWebPreferences(missing), new RegExp(key));
        });
    }

    it('refuses a window that reports no preferences', () => {
        assert.throws(() => assertSecureWebPreferences(null), /no web preferences/);
    });
});

describe('content security policy', () => {
    it('production allows only the app itself and never eval or inline code', () => {
        const csp = parseCsp(buildContentSecurityPolicy());
        assert.deepEqual(csp.get('default-src'), ["'none'"]);
        assert.deepEqual(csp.get('script-src'), ["'self'"]);
        assert.deepEqual(csp.get('style-src'), ["'self'"]);
        assert.deepEqual(csp.get('connect-src'), ["'self'"]);
        assert.deepEqual(csp.get('object-src'), ["'none'"]);
        assert.deepEqual(csp.get('base-uri'), ["'none'"]);
        assert.deepEqual(csp.get('frame-ancestors'), ["'none'"]);
        assert.doesNotMatch(buildContentSecurityPolicy(), /unsafe-eval|unsafe-inline|\*/);
    });

    it('development adds only the HMR socket and inline styles, never script relaxations', () => {
        const csp = parseCsp(buildContentSecurityPolicy({ devServerOrigin: 'http://127.0.0.1:5174' }));
        assert.deepEqual(csp.get('script-src'), ["'self'"]);
        assert.deepEqual(csp.get('connect-src'), ["'self'", 'ws://127.0.0.1:5174']);
        assert.deepEqual(csp.get('style-src'), ["'self'", "'unsafe-inline'"]);
    });

    it('maps an https dev server to a wss socket', () => {
        const csp = parseCsp(buildContentSecurityPolicy({ devServerOrigin: 'https://localhost:5174' }));
        assert.deepEqual(csp.get('connect-src'), ["'self'", 'wss://localhost:5174']);
    });
});

describe('origins and navigation', () => {
    it('computes the origin of the custom scheme', () => {
        assert.equal(originOf('codexr://app/index.html'), APP_ORIGIN);
        assert.equal(originOf('codexr://other/index.html'), 'codexr://other');
        assert.equal(originOf('http://127.0.0.1:5174/src/main.ts'), 'http://127.0.0.1:5174');
        assert.equal(originOf('not a url'), null);
        assert.equal(originOf('file:///etc/passwd'), null);
    });

    const prod = trustedOrigins();
    const dev = trustedOrigins('http://127.0.0.1:5174/');

    it('trusts the app origin, plus the dev server only when given', () => {
        assert.deepEqual([...prod], [APP_ORIGIN]);
        assert.deepEqual([...dev].sort(), [APP_ORIGIN, 'http://127.0.0.1:5174'].sort());
    });

    it('allows navigation inside the app', () => {
        assert.equal(isAllowedNavigation('codexr://app/index.html#welcome', prod), true);
        assert.equal(isAllowedNavigation('http://127.0.0.1:5174/', dev), true);
    });

    for (const url of [
        'https://example.com/',
        'http://127.0.0.1:5174/',
        'http://127.0.0.1:5175/',
        'file:///C:/Windows/System32/',
        'codexr://evil/index.html',
        'javascript:alert(1)',
        'data:text/html,<script>1</script>',
        '',
    ]) {
        it(`blocks navigation to ${JSON.stringify(url)} in production`, () => {
            assert.equal(isAllowedNavigation(url, prod), false);
        });
    }
});

describe('IPC trust', () => {
    const origins = trustedOrigins();

    it('every channel is namespaced and listed', () => {
        for (const channel of Object.values(IPC_CHANNELS)) {
            assert.match(channel, /^codexr:/);
            assert.ok(ALLOWED_IPC_CHANNELS.has(channel));
        }
        assert.equal(ALLOWED_IPC_CHANNELS.size, Object.keys(IPC_CHANNELS).length);
    });

    it('answers an allow-listed channel from the app', () => {
        assert.equal(isTrustedIpcCall(IPC_CHANNELS.appGetInfo, 'codexr://app/index.html', ALLOWED_IPC_CHANNELS, origins), true);
    });

    it('refuses an unknown channel', () => {
        assert.equal(isTrustedIpcCall('codexr:fs:delete-everything', 'codexr://app/index.html', ALLOWED_IPC_CHANNELS, origins), false);
    });

    it('refuses a foreign or unknown frame', () => {
        assert.equal(isTrustedIpcCall(IPC_CHANNELS.appGetInfo, 'https://example.com/', ALLOWED_IPC_CHANNELS, origins), false);
        assert.equal(isTrustedIpcCall(IPC_CHANNELS.appGetInfo, undefined, ALLOWED_IPC_CHANNELS, origins), false);
        assert.equal(isTrustedIpcCall(IPC_CHANNELS.appGetInfo, 'http://127.0.0.1:5174/', ALLOWED_IPC_CHANNELS, origins), false);
    });
});
