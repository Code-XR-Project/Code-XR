'use strict';
// Launches a real directory XR analysis (HTTPS server) through the core, no VS Code.
// Usage: node launch-server.cjs <targetFolder>   -> prints "URL <url>" and stays alive.
// Needs `npm run compile-tests` first (it loads out/) and a Python venv with the
// backend's requirements (CODEXR_VENV, default backend/artifacts/analysis-test-venv).
// Control API on 127.0.0.1:3999: /invite /code /participants /kick?id= /touch /info
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const repoRoot = path.resolve(projectRoot, '..', '..');
const out = (...p) => path.join(projectRoot, 'out', ...p);
const target = path.resolve(process.argv[2] || path.join(repoRoot, 'backend', 'manual_test'));
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-e2e-'));
fs.mkdirSync(path.join(storage, 'python-env'), { recursive: true });
fs.symlinkSync(process.env.CODEXR_VENV || path.join(repoRoot, 'backend', 'artifacts', 'analysis-test-venv'), path.join(storage, 'python-env', 'venv'), 'dir');
const state = new Map();
const globalState = { get: (k, f) => (state.has(k) ? state.get(k) : f), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()] };
const stubHost = {
  paths: { installRoot: projectRoot, globalStorageDir: storage, workspaceStorageDir: path.join(storage, 'ws'), mode: 'development' },
  globalState,
  notifier: { notify: async (s, m) => { console.log('NOTIFY', s, m); return undefined; }, confirm: async () => undefined,
    status: () => ({ dispose() {} }), createStatusIndicator: () => ({ text: '', show() {}, hide() {}, dispose() {} }) },
  withProgress: (_o, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
  prompt: async () => undefined, clipboardWrite: async () => {}, openExternal: async () => false,
  workspaceFolders: () => [target], signal: () => {},
};
async function main() {
  require(out('core', 'host', 'hostRegistry.js')).initializeHost(stubHost);
  const { EXTENSION_MODE } = require(out('core', 'host', 'hostPaths.js'));
  require(out('core', 'server', 'launchNotifier.js')).setLaunchNotifier({
    warnHttpsOverriddenForPanel() {}, notifyPortChanged(a, b) { console.log('PORT', a, b); },
    async handleAutoOpening(_s, url, html, mode, id) { console.log('URL', url, 'ID', id, 'HTML', html, 'MODE', mode); },
  });
  const context = { extensionPath: projectRoot, extensionMode: EXTENSION_MODE.Development, globalStorageUri: { fsPath: storage }, storageUri: { fsPath: path.join(storage, 'ws') }, globalState, subscriptions: [] };
  require(out('core','charts','settings','settingsAccessors.js')).initializeSettingsAccessors(context);
  require(out('core','analysis','configuration','analysisConfigurationStorage.js')).AnalysisConfigurationStorage.initialize(context);
  require(out('core','collaboration','collaborationProfileManager.js')).CollaborationProfileManager.initialize(context);
  require(out('core','remote-access','remoteAccessManager.js')).RemoteAccessManager.initialize(context);
  require(out('core','server','serverControl.js')).ServerControl.initialize(context);
  const { AnalysisOrchestrator } = require(out('core', 'analysis', 'analysisOrchestrator.js'));
  await AnalysisOrchestrator.orchestrateAnalysis(target, 'XR', 'directory', context, true);
  const reg = require(out('core', 'server', 'registry', 'activeServerRegistry.js'));
  const servers = reg.getActiveServerRegistry().getServers ? reg.getActiveServerRegistry().getServers() : [];
  console.log('SERVERS', JSON.stringify(servers.map(s => ({ id: s.id, url: s.url, port: s.port })), null, 0));
  const all = reg.getActiveServerRegistry().getAllServers();
  const server = all[0];
  const inst = server.serverInstance;
  const http = require('node:http');
  const publicUrl = process.env.PUBLIC_URL || 'https://test-abc.trycloudflare.com:4443';
  inst.setRemotePublicUrl(publicUrl);
  const auth = inst.getRemoteSessionAuthority();
  const codes = [];
  auth.onPairingRequest((e) => { codes.push(e); console.log('PAIRING', e.displayName, e.code); });
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    try {
      if (u.pathname === '/invite') { const t = inst.createInvitation(); const iu = new URL('/join', publicUrl); iu.searchParams.set('invite', t); return send({ url: iu.toString() }); }
      if (u.pathname === '/code') {return send(codes[codes.length - 1] || null);}
      if (u.pathname === '/participants') {return send(inst.getConnectedParticipants());}
      if (u.pathname === '/kick') {return send(inst.removeParticipant(u.searchParams.get('id')));}
      if (u.pathname === '/touch') { const f = path.join(target, u.searchParams.get('file') || 'python_metrics.py'); fs.appendFileSync(f, '\n# touched ' + Date.now() + '\n'); return send({ ok: true, f }); }
      if (u.pathname === '/info') {return send({ id: server.id, url: server.url, port: server.port, html: server.htmlFile });}
      res.writeHead(404); res.end();
    } catch (e) { res.writeHead(500); res.end(String(e && e.stack || e)); }
  }).listen(3999, '127.0.0.1', () => console.log('CONTROL http://127.0.0.1:3999'));
}
main().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
