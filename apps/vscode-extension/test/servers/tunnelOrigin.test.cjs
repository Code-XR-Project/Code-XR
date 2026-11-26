const test = require('node:test');
const assert = require('node:assert/strict');
const { tunnelOriginUrl, withCloudflaredOutput } = require('../../out/core/remote-access/remoteAccessModel.js');

test('tunnelOriginUrl points cloudflared at the IPv4 loopback the servers listen on (#159)', () => {
    assert.equal(tunnelOriginUrl('http://localhost:3000'), 'http://127.0.0.1:3000');
    assert.equal(tunnelOriginUrl('https://localhost:3443/'), 'https://127.0.0.1:3443');
    assert.equal(tunnelOriginUrl('http://[::1]:3000'), 'http://127.0.0.1:3000');
    assert.equal(tunnelOriginUrl('http://192.168.1.20:3000'), 'http://192.168.1.20:3000');
    assert.equal(tunnelOriginUrl('not a url'), 'not a url');
});

test('withCloudflaredOutput appends the last lines cloudflared printed', () => {
    assert.equal(withCloudflaredOutput('failed', ''), 'failed');
    const output = Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\r\n');
    assert.equal(withCloudflaredOutput('failed', output, 2), 'failed\ncloudflared said:\nline 8\nline 9');
});
