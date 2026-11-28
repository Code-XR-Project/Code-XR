'use strict';
/* global document -- evaluated in the browser pages through Playwright */
const os = require('node:os'); const path = require('node:path');
const { chromium } = require('playwright');
// The LAN guest opens the server on this machine's network address.
const LAN_HOST = process.env.LAN_HOST || Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address || '127.0.0.1';
const TUNNEL = 'https://test-abc.trycloudflare.com:4443';
const LOCAL = 'https://localhost:3000';
async function launch() {
  return chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-proxy-server', '--host-resolver-rules=MAP test-abc.trycloudflare.com 127.0.0.1', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}
const VENDOR = path.resolve(__dirname, '..', '..', 'vendor', 'scene-libraries') + path.sep;
const LIBS = [[/aframe\.io\/releases\/1\.7\.1\/aframe/, 'aframe-1.7.1.min.js'], [/aframe-babia-components@1\.3\.4\//, 'aframe-babia-components-1.3.4.min.js'], [/aframe-extras@v?7\.5\.4\//, 'aframe-extras-7.5.4.min.js'], [/aframe-environment-component@1\.5\.0\//, 'aframe-environment-component-1.5.0.min.js'], [/aframe-geometry-merger-component@2\.0\.1\//, 'aframe-geometry-merger-component-2.0.1.min.js'], [/html2canvas/, 'html2canvas-1.4.1.min.js'], [/Roboto-msdf\.json/, 'fonts/Roboto-msdf.json'], [/Roboto-msdf\.png/, 'fonts/Roboto-msdf.png']];
const MINE = new RegExp('^(https?|wss?)://(localhost|127\\.0\\.0\\.1|' + LAN_HOST.replace(/\./g, '\\.') + '|test-abc\\.trycloudflare\\.com)(:\\d+)?/');
async function routeLibs(ctx) { await ctx.route((u) => !MINE.test(u.href) && /^https?:/.test(u.href), (route) => { const url = route.request().url(); const hit = LIBS.find(([re]) => re.test(url)); if (hit) {return route.fulfill({ path: VENDOR + hit[1], contentType: hit[1].endsWith('.json') ? 'application/json' : hit[1].endsWith('.png') ? 'image/png' : 'application/javascript' });} return route.abort('blockedbyclient'); }); }
async function ctl(p) { const r = await fetch('http://127.0.0.1:3999' + p); return r.json(); }
function watch(page, tag, logs) {
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning' || /collab|broadcast|relay|room|live/i.test(t)) {logs.push(`[${tag}] ${m.type()}: ${t.slice(0, 300)}`);} });
  page.on('pageerror', (e) => logs.push(`[${tag}] PAGEERROR ${e.message}`));
  page.on('websocket', (ws) => { logs.push(`[${tag}] WS open ${ws.url()}`); if (/broadcast/.test(ws.url())) { ws.on('framesent', (f) => { if (typeof f.payload !== 'string') { const k = f.payload[3] & 15; (global.__kinds ||= {})[tag] ||= {}; global.__kinds[tag]['s' + k] = (global.__kinds[tag]['s' + k] || 0) + 1; } if (typeof f.payload === 'string') {logs.push(`[${tag}] >> ${f.payload.slice(0, 220)}`);} }); ws.on('framereceived', (f) => { if (typeof f.payload !== 'string') { const k = f.payload[3] & 15; (global.__kinds ||= {})[tag] ||= {}; global.__kinds[tag]['r' + k] = (global.__kinds[tag]['r' + k] || 0) + 1; } if (typeof f.payload === 'string') {logs.push(`[${tag}] << ${f.payload.slice(0, 220)}`);} }); }
    ws.on('close', () => logs.push(`[${tag}] WS close ${ws.url()}`)); ws.on('socketerror', (e) => logs.push(`[${tag}] WS error ${ws.url()} ${e}`)); });
}
async function host(browser, logs, tag = 'host') {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 700 } });
  await routeLibs(ctx); const page = await ctx.newPage(); watch(page, tag, logs);
  await page.goto(LOCAL + '/', { waitUntil: 'load' });
  return page;
}
let guestN = 10;
async function tunnelGuest(browser, logs, tag = 'guest', name) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 700 }, extraHTTPHeaders: { 'x-guest-ip': '198.51.100.' + (guestN++) } });
  await routeLibs(ctx); const page = await ctx.newPage(); watch(page, tag, logs);
  const { url } = await ctl('/invite');
  await page.goto(url);
  await page.waitForFunction(() => !document.getElementById('request').disabled, null, { timeout: 15000 });
  await page.click('#request');
  let code = null;
  for (let i = 0; i < 50 && !code; i++) { await page.waitForTimeout(200); const c = await ctl('/code'); if (c && c.displayName && (!tunnelGuest.used || !tunnelGuest.used.has(c.code))) {code = c.code;} }
  (tunnelGuest.used ||= new Set()).add(code);
  await page.waitForFunction(() => !document.getElementById('code').disabled, null, { timeout: 15000 });
  await page.fill('#code', code);
  await page.click('#confirm');
  await page.waitForURL((u) => !u.pathname.startsWith('/join') && !u.pathname.startsWith('/api'), { timeout: 20000 });
  await page.waitForLoadState('load');
  return page;
}
async function lanGuest(browser, logs, tag = 'lan') {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 700 } });
  await routeLibs(ctx); const page = await ctx.newPage(); watch(page, tag, logs);
  await page.goto('https://' + LAN_HOST + ':3000/', { waitUntil: 'load' });
  return page;
}
module.exports = { launch, ctl, host, tunnelGuest, lanGuest, TUNNEL, LOCAL };
