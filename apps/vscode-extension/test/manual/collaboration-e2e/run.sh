#!/usr/bin/env bash
# Runs both scenarios against a fresh server. From apps/vscode-extension:
#   npm run compile-tests && bash test/manual/collaboration-e2e/run.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
logs="${TMPDIR:-/tmp}"
start_server() {
  pkill -f 'node .*launch-server.cjs' 2>/dev/null; sleep 1
  nohup node "$here/launch-server.cjs" "${1:-}" > "$logs/codexr-e2e-server.log" 2>&1 &
  for _ in $(seq 1 60); do sleep 1; grep -q CONTROL "$logs/codexr-e2e-server.log" && return 0; done
  echo "server did not start, see $logs/codexr-e2e-server.log"; exit 1
}
bash "$here/restart-proxy.sh"
start_server "${1:-}"
node "$here/screen-share.cjs" | grep -E '^(host|g1|lan|g2|KINDS)'
start_server "${1:-}"
node "$here/reconnect-and-kick.cjs" | grep -v '^RAW'
pkill -f 'node .*launch-server.cjs'; pkill -f 'node tunnel-proxy'
