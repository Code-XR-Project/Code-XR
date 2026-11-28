// Idle tunnel, host reload, tunnel drop and kick (COLLAB-ROOM-1/2/3).
/* global document -- evaluated in the browser pages through Playwright */
const L = require('./lib.cjs');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROXY_LOG = require('node:path').join(require('node:os').tmpdir(), 'codexr-e2e-proxy.log');
const proxyCmd = (idle) => `bash ${__dirname}/restart-proxy.sh ${idle}`;
const brief = (ps) => ps.map((p) => `${p.displayName}:${p.role}${p.remote ? ':remote' : ''}`).join(', ');
(async () => {
  execSync(proxyCmd(40000)); await sleep(1500);
  const logs = []; const b1 = await L.launch(); const b2 = await L.launch();
  const h = await L.host(b1, logs); await h.waitForTimeout(6000);
  const g = await L.tunnelGuest(b2, logs, 'guest'); await g.waitForTimeout(8000);
  const p0 = await L.ctl('/participants'); console.log('START', brief(p0));
  console.log('RAW', JSON.stringify(p0[0]).slice(0, 300));

  await sleep(60000);
  const idle = (fs.readFileSync(PROXY_LOG, 'utf8').match(/IDLE-CLOSE.*/g) || []);
  console.log('IDLE-CLOSES after 60 s quiet (tunnel closes at 40 s idle):', idle.length, idle.join(' | '));
  console.log('AFTER-IDLE', brief(await L.ctl('/participants')));

  await h.reload({ waitUntil: 'load' }); await h.waitForTimeout(10000);
  console.log('AFTER-HOST-RELOAD', brief(await L.ctl('/participants')));

  execSync(proxyCmd(40000)); await sleep(20000);
  console.log('AFTER-TUNNEL-DROP', brief(await L.ctl('/participants')));

  const guest = (await L.ctl('/participants')).find((p) => p.remote || p.role === 'guest');
  const mark = logs.length;
  console.log('KICK', JSON.stringify(await L.ctl('/kick?id=' + encodeURIComponent(guest.peerId))));
  await sleep(4000);
  console.log('AFTER-KICK', brief(await L.ctl('/participants')));
  console.log('GUEST SOCKET EVENTS AFTER KICK:\n' + logs.slice(mark).filter((l) => /^\[guest\] WS (close|open)/.test(l)).join('\n'));
  console.log('REMOVED SCREEN:', await g.evaluate(() => !!document.getElementById('codexrDisconnectScreen')));
  await sleep(8000);
  console.log('REOPENED AFTER KICK:', logs.slice(mark).filter((l) => /^\[guest\] WS open/.test(l)).length);
  await b1.close(); await b2.close();
})().catch((e) => { console.error(e); process.exit(1); });
