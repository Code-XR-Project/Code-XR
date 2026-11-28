const L = require('./lib.cjs'); const fs = require('fs');
/* global document, window -- evaluated in the browser pages through Playwright */
const probe = fs.readFileSync(__dirname + '/probes.js', 'utf8');
async function screenState(p) { return p.evaluate(() => {
  const el = document.querySelector('[codexr-multi-screen-manager]'); const m = el && el.components['codexr-multi-screen-manager'];
  const out = []; if (m) {for (const [id, r] of [...m.activeScreens, ...m.remoteScreens]) { const s = r.runtime?.getState?.() || {}; out.push({ id, role: s.broadcastRole, status: s.broadcastStatus, audio: s.hasAudio, unlock: s.audioUnlockRequired, bid: s.activeBroadcasterId, mode: s.mode }); }}
  const P = window.__probe; const vids = [...document.querySelectorAll('video')].map(v => ({ id: v.id, w: v.videoWidth, t: +v.currentTime.toFixed(1), muted: v.muted, paused: v.paused }));
  return { screens: out, probe: { ...P, shareAc: P.shareAc?.state, acStates: (P.acStates || []).map(a => a.state) }, vids };
}); }
(async () => {
  const logs = []; const b = await L.launch();
  const browsers = [b];
  const mk = async (fnName, tag) => { const bb = await L.launch(); browsers.push(bb); const origNew = bb.newContext.bind(bb); bb.newContext = async (o) => { const c = await origNew(o); await c.addInitScript(probe); return c; }; return L[fnName](bb, logs, tag); };
  const h = await mk('host', 'host'); await h.waitForTimeout(6000);
  const started = await h.evaluate(async () => { const el = document.querySelector('[codexr-multi-screen-manager]'); const m = el.components['codexr-multi-screen-manager']; const [id, r] = [...m.activeScreens][0]; await r.runtime.startCapture('screen'); return id; });
  console.log('host share started on', started); await h.waitForTimeout(3000);
  const g1 = await mk('tunnelGuest', 'g1'); await g1.waitForTimeout(12000);
  const lan = await mk('lanGuest', 'lan'); await lan.waitForTimeout(4000);
  const g2 = await mk('tunnelGuest', 'g2'); await g2.waitForTimeout(12000);
  for (const [t, p] of [['host', h], ['g1', g1], ['lan', lan], ['g2', g2]]) {console.log(t, JSON.stringify(await screenState(p)));}
  console.log('KINDS', JSON.stringify(global.__kinds)); fs.writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'codexr-e2e-screen-share.log'), logs.join('\n'));
  for (const x of browsers) {await x.close();}
})().catch(e => { console.error(e); process.exit(1); });
