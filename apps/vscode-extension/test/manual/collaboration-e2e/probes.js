(() => {
  const P = window.__probe = { videoDecoders: 0, audioEncoders: 0, audioEncOut: 0, videoEncoders: 0, videoEncOut: 0, videoOut: 0, audioDecoders: 0, audioOut: 0, audioCfg: 0, pcs: 0, acStates: [] };
  const wrap = (name, ctr, outKey) => { const C = window[name]; if (!C) return; window[name] = class extends C { constructor(init) { P[ctr]++; const o = init.output; super({ ...init, output: (f) => { P[outKey]++; o(f); } }); } configure(c) { if (name === 'AudioDecoder') P.audioCfg++; return super.configure(c); } }; };
  wrap('VideoDecoder', 'videoDecoders', 'videoOut'); wrap('AudioDecoder', 'audioDecoders', 'audioOut'); wrap('AudioEncoder', 'audioEncoders', 'audioEncOut'); wrap('VideoEncoder', 'videoEncoders', 'videoEncOut');
  const RPC = window.RTCPeerConnection; window.RTCPeerConnection = class extends RPC { constructor(c) { super(c); P.pcs++; } };
  const AC = window.AudioContext; window.AudioContext = class extends AC { constructor(o) { super(o); P.acStates.push(this); } };
  if (navigator.mediaDevices) navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d'); let n = 0;
    setInterval(() => { g.fillStyle = `hsl(${(n++ * 7) % 360},70%,50%)`; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText('frame ' + n, 40, 180); }, 66);
    const s = c.captureStream(15);
    const ac = new AC(); P.shareAc = ac; const osc = ac.createOscillator(); const d = ac.createMediaStreamDestination(); osc.connect(d); osc.start();
    s.addTrack(d.stream.getAudioTracks()[0]); P.fakeShare = true; return s;
  };
})();
