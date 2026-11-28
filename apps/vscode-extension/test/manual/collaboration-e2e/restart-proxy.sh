#!/usr/bin/env bash
# Restarts the stand-in for the Cloudflare tunnel. Usage: restart-proxy.sh [ws-idle-ms]
# Every open tunnel socket drops, as when a guest's connection is cut.
cd "$(dirname "$0")"
pkill -f 'node tunnel-proxy' 2>/dev/null; sleep 1
LATENCY_MS=${LATENCY_MS:-80} WS_IDLE_MS=${1:-100000} nohup node tunnel-proxy.cjs > "${TMPDIR:-/tmp}/codexr-e2e-proxy.log" 2>&1 &
