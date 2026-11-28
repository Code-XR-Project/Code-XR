/**
 * The address analysis servers listen on. The VS Code extension keeps every
 * interface, so a headset or a phone on the LAN can open the scene. A host
 * whose scenes are only for this machine and the tunnel (the Code-XR IDE,
 * which serves plain HTTP) sets loopback at start-up: then nothing on the LAN
 * reaches an unauthenticated, insecure scene (COLLAB-IDE-2). The tunnel is
 * unaffected: cloudflared connects from this machine.
 */
let bindHost = '0.0.0.0';

export function setServerBindHost(host: '0.0.0.0' | '127.0.0.1'): void {
    bindHost = host;
}

export function getServerBindHost(): string {
    return bindHost;
}
