'use strict';
// Imitates a Cloudflare quick tunnel in front of the Code-XR server:
// TLS terminates here, the request goes to the origin from 127.0.0.1 (as cloudflared does)
// with Host preserved (*.trycloudflare.com) and cf-connecting-ip / x-forwarded-for added.
// Options (env): ORIGIN_PORT=3000 LISTEN=4443 LATENCY_MS=0 (one-way, per chunk) WS_IDLE_MS=100000
const tls = require('node:tls'); const https = require('node:https'); const fs = require('node:fs'); const path = require('node:path');
const ORIGIN_PORT = Number(process.env.ORIGIN_PORT || 3000);
const LISTEN = Number(process.env.LISTEN || 4443);
const LATENCY = Number(process.env.LATENCY_MS || 0);
const WS_IDLE = Number(process.env.WS_IDLE_MS || 100000);
// A throwaway self-signed certificate for *.trycloudflare.com, made on first run
// (never committed); the browsers are launched with ignoreHTTPSErrors.
const certDir = path.join(require('node:os').tmpdir(), 'codexr-e2e-proxy-cert');
if (!fs.existsSync(path.join(certDir, 'proxy.crt'))) {
  fs.mkdirSync(certDir, { recursive: true });
  require('node:child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7',
    '-subj', '/CN=*.trycloudflare.com', '-keyout', path.join(certDir, 'proxy.key'), '-out', path.join(certDir, 'proxy.crt')], { stdio: 'ignore' });
}
const opts = { key: fs.readFileSync(path.join(certDir, 'proxy.key')), cert: fs.readFileSync(path.join(certDir, 'proxy.crt')) };
const delayed = (dst) => (chunk) => { if (!LATENCY) { dst.write(chunk); return; } setTimeout(() => { if (!dst.destroyed) {dst.write(chunk);} }, LATENCY); };
const server = https.createServer(opts, (req, res) => {
  const headers = { ...req.headers, 'cf-connecting-ip': req.headers['x-guest-ip'] || '203.0.113.9', 'x-forwarded-for': req.headers['x-guest-ip'] || '203.0.113.9' };
  const fwd = https.request({ host: '127.0.0.1', port: ORIGIN_PORT, method: req.method, path: req.url, headers, rejectUnauthorized: false }, (r) => {
    setTimeout(() => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }, LATENCY);
  });
  fwd.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  setTimeout(() => req.pipe(fwd), LATENCY);
});
server.on('upgrade', (req, socket, head) => {
  const up = tls.connect({ host: '127.0.0.1', port: ORIGIN_PORT, rejectUnauthorized: false }, () => {
    const h = { ...req.headers, 'cf-connecting-ip': req.headers['x-guest-ip'] || '203.0.113.9', 'x-forwarded-for': req.headers['x-guest-ip'] || '203.0.113.9' };
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) {raw += `${k}: ${v}\r\n`;}
    up.write(raw + '\r\n'); if (head && head.length) {up.write(head);}
    let idle; const bump = () => { clearTimeout(idle); idle = setTimeout(() => { console.log('IDLE-CLOSE', req.url); socket.destroy(); up.destroy(); }, WS_IDLE); };
    bump();
    up.on('data', (c) => { bump(); delayed(socket)(c); });
    socket.on('data', (c) => { bump(); delayed(up)(c); });
    const end = () => { clearTimeout(idle); socket.destroy(); up.destroy(); };
    up.on('close', end); socket.on('close', end); up.on('error', end); socket.on('error', end);
  });
});
server.listen(LISTEN, '127.0.0.1', () => console.log('TUNNEL https://test-abc.trycloudflare.com:' + LISTEN, 'latency', LATENCY, 'wsIdle', WS_IDLE));
